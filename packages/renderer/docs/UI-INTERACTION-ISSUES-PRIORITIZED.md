# 前端交互问题清单（3-Agent 审查整合）

**集成自**：plan-user 详细交互审查 + mnemo id:692（精简后）  
**日期**：2026-04-28  
**状态**：已对照权威设计文档核对，3 个误诊已排除

---

## 汇总

| 优先级 | 数量 | 问题类型 |
|--------|------|---------|
| **P1 必修** | 3 | 功能缺陷 |
| **P2 高优** | 3 | UX 问题 |
| **P3 中优** | 2 | 易用性 |
| **设计意图** | 3 | 非问题（已核对） |

---

## P1 必修问题（3 个）

### P1-1：中文输入法 Enter 确认选词会误发消息

**文件**  
`src/molecules/ChatInput/ChatInput.tsx:27-32`

**现象**  
用户用中文输入法（IME）连续输入，按 Enter 确认选词时，消息会被误发出。

**根因**  
`onKeyDown` 事件处理检查了 `isComposing`，但 composing 结束后再次触发 onKeyDown 时，`isComposing` 已为 false，导致选词确认的 Enter 被当作发送。

**修法**  
改用 `onKeyPress` 或加延迟判断组合：
```typescript
// ChatInput.tsx
const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  // IME 输入中时直接返回，不处理 Enter
  if (e.nativeEvent.isComposing) return;
  
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend?.();
  }
};

// 或改为 onKeyPress
const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.nativeEvent.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend?.();
  }
};
```

**验收**  
用中文输入法输入 5-10 行文字，每行用 Enter 确认选词，确保消息不被误发。

---

### P1-2：展开动画中拖动窗口会抖动

**文件**  
`src/hooks/useCapsuleToggle.ts:38-45` + `src/organisms/CapsuleCard/CapsuleCard.css`

**现象**  
展开动画正在进行中（0~350ms），用户拖动窗口，会看到明显的中间态卡顿或尺寸跳跃。

**根因**  
展开流程：
1. t=0：`setExpanded(true)` + `resize IPC`（启动 Electron 350ms 动画）
2. t=0-350ms：CSS 内部过渡与 Electron 动画并行，但用户拖动时 Electron 会中断/重新计算窗口位置
3. t=350ms：`setBodyVisible(true)`（body 开始 fade in）
4. 结果：中断位置 + CSS 计时重置 = 抖动

**修法**  
**选项 A（推荐）**：等 Electron resize 完成再改 React 状态
```typescript
// useCapsuleToggle.ts
const toggle = () => {
  // ...
  if (!expanded) {
    setAnimating(true);
    setExpanded(true);
    setBodyVisible(false);
    
    // resize 后等 350ms，确保窗口动画完成
    window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
    schedule(() => setBodyVisible(true), RESIZE_MS);
    schedule(() => setAnimating(false), RESIZE_MS + BODY_FADE_MS);
  }
  // ...
};
```

**选项 B**：Electron resize 改为同步回调式（需后端协调）
在 preload.cjs 中暴露：
```typescript
window.electronAPI.resizeAsync = (w, h, anchor, animate) => {
  return new Promise((resolve) => {
    window.electronAPI.onResizeComplete(() => resolve());
    window.electronAPI.resize(w, h, anchor, animate);
  });
};
```

**验收**  
展开动画进行中（100-300ms 时点），拖动窗口，观察是否有卡顿。应平滑无抖动。

---

### P1-3：文本框最大高度 120px 但没用户反馈

**文件**  
`src/molecules/ChatInput/ChatInput.tsx` + `ChatInput.css:30`

**现象**  
用户输入 5 行以上文字时，文本框达到最大高度 120px，滚动条出现但几乎看不见（仅 6px 宽），用户不知道已到达上限。

**修法**  
```css
/* ChatInput.css */
.chat-input__textarea {
  max-height: 120px;
  overflow-y: auto;
  resize: none;  /* 禁用手动拖拽，防止破坏布局 */
}

/* 滚条宽度增大，悬停时深化 */
.chat-input__textarea::-webkit-scrollbar {
  width: 8px;  /* 从 6px 增大 */
}

.chat-input__textarea::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.10);
  border-radius: 4px;
  transition: background 150ms ease;
}

.chat-input__textarea::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);  /* 悬停时明显深化 */
}

.chat-input__textarea:focus::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.20);  /* 获焦时也示意 */
}
```

或加文本提示：
```tsx
// ChatInput.tsx
const isAtMax = inputRef.current?.scrollHeight >= 120;
return (
  <div className="chat-input">
    <textarea 
      ref={inputRef}
      className={['chat-input__textarea', isAtMax && 'chat-input__textarea--max'].join(' ')}
      {...props}
    />
    {isAtMax && <div className="chat-input__hint">已达输入上限，支持 Shift+Enter 换行</div>}
  </div>
);
```

**验收**  
输入多行文字到最大高度，确保滚条可见且用户能意识到上限。

---

## P2 高优问题（3 个）

### P2-1：Dropdown 选项文本超长时会压邻近元素

**文件**  
`src/atoms/Dropdown/Dropdown.css:82-83`

**现象**  
ToolBar 中 Dropdown 如果选项文本很长（如长模型名），下拉 panel 会撑大并压住右侧齿轮按钮。

**根因**  
`.dropdown__panel { width: 100%; }` 是相对 trigger 宽度的 100%，但 panel 没限制最大宽度，内容会撑开。

**修法**  
根据已有 id:607 的方案，确保 panel 等宽 trigger 且内容省略：
```css
/* Dropdown.css */
.dropdown__panel {
  width: 100%;
  right: 0;
  box-sizing: border-box;
  max-width: 200px;  /* 限制最大宽度，避免撑到相邻元素 */
}

.dropdown__option {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

**验收**  
ToolBar 中选择长模型名，下拉 panel 不会压住齿轮按钮。

---

### P2-2：消息列表快速滚动时偶现空白

**文件**  
`src/atoms/VirtualList/VirtualList.tsx` + `src/organisms/ChatPanel/ChatPanel.css`

**现象**  
快速滚动消息列表时，偶尔会看到空白区域闪现，或消息列表底部突然出现空白。

**根因**  
`.chat-panel__messages` 的 sticky 判断逻辑（`stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20`）中的 20px 阈值在高分屏或消息高度变化时不稳定。

**修法**  
```typescript
// VirtualList.tsx，改进 sticky 检测
useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;

  const handleScroll = () => {
    // 阈值改为更宽松的 30px，兼容各种 DPI
    const threshold = 30;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  el.addEventListener('scroll', handleScroll);
  
  // 加 ResizeObserver 监听消息高度变化，重新计算 stick
  const resizeObserver = new ResizeObserver(() => {
    handleScroll();  // 内容变化时重新计算
  });
  resizeObserver.observe(el);

  return () => {
    el.removeEventListener('scroll', handleScroll);
    resizeObserver.disconnect();
  };
}, []);
```

**验收**  
快速滚动消息列表 10-20 次，无空白闪现。

---

### P2-3：输入框获焦时滚动条没亮起来

**文件**  
`src/organisms/ChatPanel/ChatPanel.css:29-37`

**现象**  
消息列表滚条颜色 `rgba(255, 255, 255, 0.08)`，与半透明背景融合看不清，用户不知道能滚动。

**修法**  
```css
/* ChatPanel.css */
.chat-panel__messages::-webkit-scrollbar {
  width: 6px;
}

.chat-panel__messages::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.10);
  border-radius: 3px;
  transition: background 150ms ease;
}

/* 悬停时显著深化 */
.chat-panel__messages::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}

/* 容器获焦时也深化滚条 */
.chat-panel__messages:focus-within::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.20);
}
```

**验收**  
输入框获焦，滚条颜色应明显可见。

---

## P3 中优问题（2 个）

### P3-1：设置窗口没有 ESC 快捷关闭

**文件**  
`src/pages/SettingsPage/SettingsPage.tsx`

**现象**  
用户打开设置窗口后，习惯按 ESC 关闭，但无反应。

**修法**  
```typescript
// SettingsPage.tsx
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      window.electronAPI?.closeSettings?.();
    }
  };

  document.addEventListener('keydown', handleKeyDown);
  return () => document.removeEventListener('keydown', handleKeyDown);
}, []);
```

**验收**  
打开设置窗口，按 ESC，窗口应关闭。

---

### P3-2：Dropdown 下拉框在屏幕上方时会超出顶部

**文件**  
`src/atoms/Dropdown/Dropdown.css:79`

**现象**  
Dropdown 位于窗口上方时，下拉 panel 以 `bottom: calc(100% + 10px)` 向上展开，可能超出屏幕顶部，完全看不见。

**修法**  
用 JS 动态检测，根据空间选择向上或向下：
```typescript
// Dropdown.tsx
const [dropDirection, setDropDirection] = useState<'up' | 'down'>('up');

useEffect(() => {
  const trigger = triggerRef.current;
  if (!trigger) return;

  const rect = trigger.getBoundingClientRect();
  // 如果上方空间 < panel 高度（假设 250px），改为向下
  const spaceAbove = rect.top;
  const panelHeight = 250;
  
  setDropDirection(spaceAbove < panelHeight ? 'down' : 'up');
}, []);

// CSS 改为条件
```

或纯 CSS 方案（降级）：
```css
/* Dropdown.css */
.dropdown__panel {
  bottom: calc(100% + 10px);
  max-height: 60vh;  /* 限制高度 + 内部滚动 */
  overflow-y: auto;
}
```

**验收**  
在 Dropdown 位于顶部时打开下拉，panel 应可见（向下展开或内部滚动）。

---

## 非问题（已核对，不修改）

| 原问题 | 文档依据 | 结论 |
|-------|--------|------|
| DragHandle 在胶囊态隐藏，无法拖动 | CAPSULE-INTERACTION-SPEC.md §6.2 | **正确设计**。胶囊态整个区域 drag-enabled |
| 快速双击展开/收起会混乱 | §5.1 打断重来 | **正确设计**。打断立即走新分支是意图 |
| 团队面板自动弹出遮挡内容 | INTERACTION-DESIGN.md §2 | **不存在**。独立 BrowserWindow，无遮挡 |

---

## 开发派单

### Wave 1（P1 必修）

**T1：中文输入法 + 展开动画 + 输入框反馈**（S 级工作量）
- 改进 ChatInput IME 处理（onKeyPress）
- ChatInput 最大高度提示 + 滚条优化
- 展开动画中拖动平滑化（等 resize 完成）
- 文件：ChatInput.tsx + ChatInput.css + useCapsuleToggle.ts

**验收**：
- [ ] 中文输入法连续输入 × 5，Enter 选词无误发
- [ ] 展开动画中拖动无抖动
- [ ] 输入 5 行文字，滚条可见

### Wave 2（P2 高优）

**T2：Dropdown + VirtualList + 滚条**（M 级工作量）
- Dropdown 等宽 + 长文本省略
- VirtualList stick 阈值 + ResizeObserver
- ChatPanel 滚条获焦深化
- 文件：Dropdown.css + VirtualList.tsx + ChatPanel.css

**验收**：
- [ ] Dropdown 长选项不压邻近元素
- [ ] 快速滚动消息列表无空白
- [ ] 输入框获焦滚条明显可见

### Wave 3（P3 中优）

**T3：ESC 关闭 + Dropdown 边界**（XS 级工作量）
- SettingsPage ESC 关闭
- Dropdown 上方超出时处理
- 文件：SettingsPage.tsx + Dropdown.tsx/css

---

## 验收 Checklist

- [ ] **P1 全部通过** CDPspam 测试 + 真机多屏验证
- [ ] **P2 全部通过** 性能监控（无卡顿）
- [ ] **P3 全部通过** 易用性测试
- [ ] **回归测试** 确认无新问题引入

---

## 参考

- **mnemo id:692** — 原始 11 问题 → 8 问题精简
- **mnemo id:683** — 胶囊交互完整规范
- **mnemo id:607** — Dropdown 等宽方案
- **mnemo id:593** — ChatPanel padding 方案

