# 窗口交互修复方案（基于权威规范）

**作者**：技术方案师  
**日期**：2026-04-28  
**源头文档**：`CAPSULE-INTERACTION-SPEC.md` § 11-13  
**验证方式**：CDP 截图 + 真机多屏手测

---

## 用户反馈 vs 规范诊断

用户反馈了 5 个问题，通过对照 `CAPSULE-INTERACTION-SPEC.md` 的问题清单（§11），分析如下：

| # | 用户反馈 | 规范诊断 | 状态 | 优先级 |
|---|---------|---------|------|--------|
| 1 | 胶囊拖到副屏展开后跳回主屏 | A-P1 多屏跳回主屏 / B-P4 跨屏展开 | ✅ 已由 id:681 修复 | – |
| 2 | 展开态拖到其他位置收起后位置不对 | A-P1 第二条（拖副屏收起错位） | ✅ 不存在，代码已正确 | – |
| 3 | 展开/收起动画卡顿抖动 | B-P3 ExpandedView 渲染 / A-P2 按钮防护 | 🔍 对应 P2-2 | P2 |
| 4 | 收起时先变空白再收起 | 设计意图正确（先 fade 后 resize），无问题 | ✅ 符合规范 | – |
| 5 | 展开态只显示头部（截图证实） | B-P3 ExpandedView 渲染完整性 | ✅ 已由 id:584 修复 | – |

**结论**：用户报告的 5 个问题中，4 个已解决或符合设计，仅 1 个有待修复。

---

## 权威问题清单（摘自规范 § 11）

### P1（严重，无）

**无严重问题**。原 A-P1 / B-P4 均已由 id:681 修复，原 A-P1 第二条不存在。

### P2（中等，本期处理）

#### P2-1：快速连击防抖（原 B-P1）

**现象**  
`toggle()` 入口清理 `timersRef`，但极端 spam 下 React render 频繁，可能导致类名切换多次。

**根因**  
`toggle()` 无入口锁，多个事件处理可能同时触发。

**修法**  
在 `useCapsuleToggle` 加 `lockedRef: boolean`：
```typescript
const lockedRef = useRef(false);

const toggle = () => {
  if (lockedRef.current) return;  // 防入口重入
  lockedRef.current = true;
  
  // ... 原逻辑
  
  schedule(() => {
    setAnimating(false);
    lockedRef.current = false;  // 动画完后解锁
  }, TOTAL_MS);
};
```

**文件**  
`src/hooks/useCapsuleToggle.ts`

**验收**  
CDP 脚本 20ms 间隔连点 `.btn--dots` × 10 次，最后状态稳定，render 次数 ≤ 3。

#### P2-2：`animating` 期间禁点保护（原 A-P2，部分保留）

**现象**  
虽然 CSS 已通过 `.card--expanded .card__collapsed { visibility:hidden }` 保障禁点，但缺乏 React 层兜底防护。

**修法**  
在 `CapsuleCard.tsx`，当 `animating=true` 时禁用按钮点击：

```typescript
// CapsuleCard.tsx
<MenuDots onClick={() => {
  if (!animating) onToggle?.();
}} />

<Button 
  variant="icon" 
  size="sm" 
  onClick={() => {
    if (!animating) onToggle?.();
  }}
>
  <Icon name="close" size={16} />
</Button>
```

并在根元素加标记：
```tsx
<div className={cls.join(' ')} aria-busy={animating}>
  {/* ... */}
</div>
```

**文件**  
`src/organisms/CapsuleCard/CapsuleCard.tsx`

**验收**  
- 动画进行中（任意时刻）快速点击按钮 → 无反应
- 动画完成后才可再次点击

**注意**  
P2-1 + P2-2 合并实现为一个任务。

---

### P3（低优，按需）

#### P3-1：展开态拖动中点 X 的竞态（原 A-P5 / B-B6）

**现象**  
Electron 原生拖动与 React setState 异步，极端情况 UI 闪烁。

**修法**  
监听 `resize-started` IPC（`main.ts:96` 已发送），在 React 中设 `isDragging`，拖动中 toggle 直接 return。

**文件**  
`src/hooks/useCapsuleToggle.ts`  
`electron-main/preload.cjs`

**验收**  
手测拖动 + 快速点 X，无闪烁。

#### P3-2：位置 / 展开态持久化（原 A-P4, A-P6, B-B8）

**现象**  
窗口位置和展开态只存在 Electron BrowserWindow 中，F5 / 重启后丢失。

**修法**  
1. `useCapsuleToggle`：读写 `localStorage.capsule`
2. `main.ts`：createWindow 时读 localStorage 初始位置
3. resize IPC 成功后写位置到 localStorage

**文件**  
`src/hooks/useCapsuleToggle.ts`  
`electron-main/main.ts`  
`electron-main/preload.cjs`

**验收**  
拖到副屏 → 重启 → 胶囊出现在副屏原位。

#### P3-3：DragHandle cursor 反馈（原 B-P7）

**修法**  
```css
.card__drag { cursor: grab; }
.card__drag:active { cursor: grabbing; }
.card--expanded .card__drag { cursor: grab; }
```

**文件**  
`src/organisms/CapsuleCard/CapsuleCard.css`

**验收**  
鼠标 hover 拖动区显示 grab，按下显示 grabbing。

---

## 修复任务派单

| 任务 | 优先级 | 涉及文件 | 预估 | 验收关键 |
|------|--------|---------|------|---------|
| T1: toggle 防抖 + animating 禁点 | P2 | `useCapsuleToggle.ts`, `CapsuleCard.tsx` | S | spam 点击 10 次稳定收敛 |
| T2: 拖动中锁定 toggle | P3 | `preload.cjs`, `useCapsuleToggle.ts`, `main.ts` | M | 拖动中点 X 无反应 |
| T3: 位置 / 展开态持久化 | P3 | `main.ts`, `preload.cjs`, `useCapsuleToggle.ts` | M | 重启恢复副屏位置 |
| T4: DragHandle cursor | P3 | `CapsuleCard.css` | XS | grab/grabbing 视觉反馈 |

---

## 修复详细方案（T1）

### T1 — toggle 防抖 + animating 期间按钮锁

**任务描述**  
防止快速连击导致多次 render，同时在动画进行中锁住按钮点击。

**涉及文件**
1. `packages/renderer/src/hooks/useCapsuleToggle.ts`
2. `packages/renderer/src/organisms/CapsuleCard/CapsuleCard.tsx`

**修法（详细代码）**

**文件 1：useCapsuleToggle.ts**

在 hook 中加入锁机制：
```typescript
import { useState, useRef, useEffect } from 'react';
import { useWindowStore, selectExpanded, selectSetExpanded } from '../store';

const CAPSULE = { width: 380, height: 120 };
const EXPANDED = { width: 640, height: 620 };
const RESIZE_MS = 350;
const BODY_FADE_MS = 200;
const TOTAL_MS = RESIZE_MS + BODY_FADE_MS;

const INITIAL_EXPANDED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('expanded') === '1';

export function useCapsuleToggle() {
  const expanded = useWindowStore(selectExpanded);
  const setExpanded = useWindowStore(selectSetExpanded);
  const [animating, setAnimating] = useState(false);
  const [bodyVisible, setBodyVisible] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lockedRef = useRef(false);  // ← 新增

  useEffect(() => {
    const initiallyExpanded = INITIAL_EXPANDED || useWindowStore.getState().expanded;
    if (initiallyExpanded) {
      setExpanded(true);
      setBodyVisible(true);
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', false);
    } else {
      window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', false);
    }
  }, [setExpanded]);

  const schedule = (fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  };

  const toggle = () => {
    if (lockedRef.current) return;  // ← 防入口重入
    lockedRef.current = true;

    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    
    if (!expanded) {
      setAnimating(true);
      setExpanded(true);
      setBodyVisible(false);
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
      schedule(() => setBodyVisible(true), RESIZE_MS);
      schedule(() => {
        setAnimating(false);
        lockedRef.current = false;  // ← 动画完后解锁
      }, TOTAL_MS);
    } else {
      setAnimating(true);
      setBodyVisible(false);
      schedule(() => {
        window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', true);
        setExpanded(false);
      }, BODY_FADE_MS);
      schedule(() => {
        setAnimating(false);
        lockedRef.current = false;  // ← 动画完后解锁
      }, TOTAL_MS);
    }
  };

  return { expanded, animating, bodyVisible, toggle };
}
```

**文件 2：CapsuleCard.tsx**

在 MenuDots 和 close 按钮加 animating 检查：
```typescript
import Logo from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import TitleBlock from '../../molecules/TitleBlock';
import MenuDots from '../../molecules/MenuDots';
import DragHandle from '../../molecules/DragHandle';
import './CapsuleCard.css';

interface CapsuleCardProps {
  name?: string;
  agentCount: number;
  taskCount: number;
  messageCount: number;
  online?: boolean;
  expanded?: boolean;
  animating?: boolean;
  bodyVisible?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}

export default function CapsuleCard({
  name = 'M-TEAM', agentCount, taskCount, messageCount, online,
  expanded = false, animating = false, bodyVisible = false, onToggle, children,
}: CapsuleCardProps) {
  const cls = ['card'];
  if (expanded) cls.push('card--expanded');
  if (animating) cls.push('card--animating');
  if (bodyVisible) cls.push('card--body-visible');

  const handleToggle = () => {
    if (!animating) onToggle?.();
  };

  return (
    <div className={cls.join(' ')} aria-busy={animating}>
      <div className="card__drag"><DragHandle /></div>
      <div className="card__logo"><Logo size={expanded ? 24 : 44} online={online} /></div>
      <div className="card__collapsed">
        <TitleBlock title={name} subtitle={`${agentCount} Agents · ${taskCount} Tasks`} badgeText={messageCount > 0 ? `${messageCount} New messages` : undefined} badgeCount={messageCount} />
        <MenuDots onClick={handleToggle} />
      </div>
      <div className="card__expanded-head">
        <span className="card__expanded-name">{name}</span>
        <StatusDot status={online ? 'online' : 'offline'} size="sm" />
      </div>
      <div className="card__close">
        <Button variant="icon" size="sm" onClick={handleToggle}>
          <Icon name="close" size={16} />
        </Button>
      </div>
      <div className="card__body">{children}</div>
    </div>
  );
}
```

**验收 checklist**

- [ ] tsc 编译通过，无类型错误
- [ ] CDP 测试脚本：
  ```javascript
  // 模拟快速连点 10 次
  for (let i = 0; i < 10; i++) {
    setTimeout(() => {
      document.querySelector('.btn--dots')?.click();
    }, i * 20);  // 每 20ms 一次
  }
  // 600ms 后断言：
  // - expanded === true
  // - animating === false
  // - window.getComputedStyle(card).width === '640px'
  ```
- [ ] 真机手测：快速展开/收起无卡顿
- [ ] 截图存 `docs/phase2/T1-debounce-*.png`

---

## 验证方法（全体 P2 任务）

### CDP 本地验证（所有任务）

```bash
cd /Users/zhuqingyu/project/mcp-team-hub/packages/renderer

# 启动开发环境
bun dev

# 另开终端，运行 CDP 脚本连接 localhost:9222
# 逐条执行 checklist 中的脚本
```

### 真机验证（T1/T2/T3）

1. **T1 防抖**：spam 点击 10 次，观察收敛
2. **T2 拖动中锁定**：拖动窗口，拖动中点 X，松开后点 X
3. **T3 位置恢复**：拖到副屏 → 关闭 → 重启 → 位置检查

### 性能检查（可选）

DevTools Performance 标签：
- [ ] 展开动画帧率 ≥58fps
- [ ] 无"long task" 红条（>50ms）
- [ ] React 批处理命中（单次 render）

---

## 时间线

| 阶段 | 时间 | 任务 |
|------|------|------|
| Phase 2.1 | 本周 | T1（P2）代码 review + 合并 |
| Phase 2.2 | 次周 | T2/T3/T4（P3）按需实现 |
| Phase 3 | 后续 | 动画体验进一步优化、性能专项 |

---

## 相关文档

- **权威规范**：`docs/CAPSULE-INTERACTION-SPEC.md`
- **mnemo 知识**：
  - id:681 — 跨屏修复（已落地）
  - id:584 — opacity 修复（已落地）
  - id:682/683/684 — 完整交互规范

---

## 关键约束（必读）

从 `CAPSULE-INTERACTION-SPEC.md` 摘录，所有修复必须遵守：

1. **React 批处理**（§3.3）：setState 必须在同一 event handler，禁止 rAF 分帧
2. **锚点固定**（§4.3, §8.1）：resize 永远用 `bottom-right`，不改逻辑
3. **跨屏 clamp**（§7）：用 `getDisplayMatching` + `workArea`，已由 id:681 落地
4. **CSS visibility**（§3.3, §9.1）：`.card__collapsed` 必须 `visibility:hidden` 兜底 opacity
5. **边界条件**（§10）：快速连击 (B1)、展开中点 X (B2) 等已列举，本方案针对 B1

---

## 交付物清单

- [x] 本方案文档（`WINDOW-INTERACTION-FIX-PLAN.md`）
- [ ] T1 代码改动 + 测试
- [ ] T2/T3/T4 代码改动 + 测试（按优先级）
- [ ] CDP 截图 × N（每个任务一套）
- [ ] 真机多屏测试报告

