# 前端组件架构设计

> 适用范围：`packages/renderer`
> 目标：以 Tailwind CSS 作为样式方案，建立清晰的分层、稳定的 Token 体系和可控的抽象节奏。

---

## 1. 概述

本应用是一个 Electron 多窗口产品（胶囊 / 聊天 / 桌宠 / 设置等），UI 风格偏"液态玻璃 + 暗色"。
当前代码集中在 `src/components/`，尚未分层，Token 分散在各处 CSS。

本次架构调整的目标：

- 建立**明确分层**：原子 → 分子 → 组件块 → 模板 → 页面，禁止反向依赖。
- 建立**统一 Token 体系**：颜色/字号/间距/圆角/阴影/动效全部集中。
- **抽象跟随场景**，不提前建帝国：只有真正复用到的才抽公共组件。
- 制定**可变/不可变边界**：哪些改动是安全的局部迭代，哪些必须谨慎。

---

## 2. 设计原则

1. **分层单向依赖**：下层不知道上层存在，上层可以使用下层。
2. **抽象跟随场景**：第一次出现不抽，第二次观察，第三次必抽。
3. **Token 即契约**：跨组件的视觉参数必须走 Token，禁止硬编码。
4. **Tailwind 优先，自定义 CSS 兜底**：组件样式用 Tailwind class，复杂效果（毛玻璃多层阴影等）用 `@apply` 或单独 CSS 文件。
5. **API 一致性优先于灵活性**：宁可多一个枚举值，也不要多一个魔法参数。
6. **下一个 agent 秒懂**：命名、目录、文件三者一一对应，拒绝屎山。

---

## 3. 目录结构

```
src/
├── design-tokens/          # 颜色/字号/圆角/间距/阴影/动效
│   ├── tokens.css          # CSS 变量定义（权威来源）
│   ├── tokens.ts           # TS 侧镜像常量（按需）
│   └── index.ts
├── atoms/                  # 零业务，仅样式 + 最小 props
│   ├── Icon/
│   ├── Text/
│   ├── StatusDot/
│   ├── Logo/
│   ├── Button/
│   └── Surface/
├── molecules/              # 2-3 个原子的组合
│   ├── Avatar/
│   ├── TitleBlock/
│   ├── MenuDots/
│   ├── MessageBadge/
│   └── DragHandle/
├── organisms/              # 完整功能区块
│   ├── CapsuleCard/
│   ├── ChatPanel/
│   ├── AgentList/
│   ├── SettingsPanel/
│   └── JellyPet/
├── templates/              # 窗口骨架（布局 + 占位）
│   ├── CapsuleWindow.tsx
│   ├── PanelWindow.tsx
│   └── PetWindow.tsx
├── pages/                  # Electron 多窗口入口
│   ├── CapsulePage.tsx
│   ├── ChatPage.tsx
│   └── PetPage.tsx
├── store/                  # zustand stores（按领域分文件）
├── api/                    # IPC / HTTP 封装
├── hooks/                  # 通用 hooks
├── assets/                 # 静态资源
├── App.tsx
└── main.tsx
```

### 分层依赖规则

| 层级 | 可依赖 | 禁止 |
|---|---|---|
| design-tokens | 无 | — |
| atoms | tokens | 业务、molecules、organisms、store、api |
| molecules | atoms + tokens | organisms、业务 zustand store |
| organisms | molecules + atoms + tokens + hooks + store + api | templates、pages |
| templates | organisms + 下层 | pages |
| pages | templates + store + api | — |

> 一条铁律：**不允许反向依赖**。如果一个 atom 需要知道某个 organism 的存在，那说明它不该是 atom。

---

## 4. 分层定义

### 4.1 Atoms（原子层）

**定位**：零业务，最小不可再分的视觉单元。只管"长什么样"，不管"为什么"。

**约束**：

- 不接业务 props（如 `agentId`），只接视觉 props。
- 样式用 Tailwind class 直接写在 JSX 中；复杂效果可配 CSS 文件。
- 样式透传规则见 §7.2。

| 组件 | 职责 | 关键 props |
|---|---|---|
| Icon | 渲染 SVG 图标 | `name`, `size: 'sm'\|'md'\|'lg'` |
| Text | 排版文本，绑定字号/字重 token | `variant: 'title'\|'body'\|'caption'`, `tone: 'primary'\|'secondary'\|'tertiary'\|'inverse'` |
| StatusDot | 状态圆点 | `status: 'online'\|'busy'\|'offline'\|'warning'\|'danger'`, `size` |
| Logo | 品牌/AI Logo 图元 | `variant`, `size` |
| Button | 基础按钮 | `variant: 'primary'\|'ghost'\|'danger'`, `size`, `disabled`, `onClick` |
| Surface | 玻璃/卡片底座 | `tone: 'glass-dark'\|'glass-light'\|'overlay'`, `radius`, `elevation` |

### 4.2 Molecules（分子层）

**定位**：2-3 个原子组合出的"有语义的小单元"。

| 组件 | 组成 | 用途 |
|---|---|---|
| Avatar | Surface + Logo/Icon/图片 + StatusDot | 头像（品牌 Logo / 图标 / 图片三选一）+ 状态叠加 |
| TitleBlock | Text(title) + Text(caption) | 标题 + 副标题组合 |
| MenuDots | IconButton | 三点菜单入口 |
| MessageBadge | Surface + Text | 未读消息红点/数字 |
| DragHandle | Surface + Icon | 可拖拽把手 |

### 4.3 Organisms（组件块层）

**定位**：完整的业务区块，可直接在页面中放置。

| 组件 | 承载场景 |
|---|---|
| CapsuleCard | 胶囊窗口的主卡片（含 Avatar、TitleBlock、MenuDots、DragHandle） |
| ChatPanel | 聊天主体：消息列表 + 输入框 + 附件 |
| AgentList | Agent 列表（带在线状态、操作入口） |
| SettingsPanel | 设置面板的分组 + 列表项 |
| JellyPet | 桌宠本体 + 气泡 |

### 4.4 Templates（模板层）

**定位**：窗口骨架，负责"往哪放"，不负责"放什么"。

| 模板 | 用途 |
|---|---|
| CapsuleWindow | 胶囊窗口骨架（透明背景 + 拖拽区 + 内容槽） |
| PanelWindow | 聊天/设置类面板骨架（标题栏 + 内容区 + 底栏） |
| PetWindow | 桌宠窗口骨架（透明 + 鼠标穿透边界） |

### 4.5 Pages（页面层）

Electron 多窗口入口，每个窗口一个 Page 文件。Page 只做：
组合 template → 注入数据 → 绑定全局副作用（快捷键、窗口事件等）。

---

## 5. Design Token 清单

Token 是整个系统的契约层。**所有跨组件的视觉参数必须走 Token**。

### 5.1 `src/design-tokens/tokens.css`

```css
:root {
  /* ---------- 颜色 · 强调色 ---------- */
  --color-accent-primary: #4aa3ff;
  --color-accent-success: #23c55e;
  --color-accent-warning: #f5a623;
  --color-accent-danger:  #ff5b5b;

  /* ---------- 颜色 · 文本 ---------- */
  --color-text-primary:   rgba(255, 255, 255, 0.92);
  --color-text-secondary: rgba(255, 255, 255, 0.62);
  --color-text-tertiary:  rgba(255, 255, 255, 0.45);
  --color-text-inverse:   rgba(20, 24, 32, 0.92);

  /* ---------- 表面 · 玻璃 / 叠加 ----------
     Token 层只提供基础纯色，渐变在组件 CSS 里自行叠合，避免跨组件耦合渐变方向/止点。 */
  --surface-glass-dark:  rgba(34, 36, 47, 0.85);
  --surface-glass-light: rgba(255, 255, 255, 0.18);
  --surface-overlay:     rgba(0, 0, 0, 0.35);

  /* ---------- 间距 ---------- */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;

  /* ---------- 圆角 ---------- */
  --radius-sm:   6px;
  --radius-md:   12px;
  --radius-lg:   20px;
  --radius-xl:   28px;
  --radius-pill: 999px;

  /* ---------- 字体 ---------- */
  --font-family-ui: "SF Pro Display", -apple-system, system-ui, sans-serif;

  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 15px;
  --font-size-xl: 22px;

  --font-weight-regular:  400;
  --font-weight-medium:   500;
  --font-weight-semibold: 600;

  /* ---------- 阴影 ---------- */
  --shadow-soft:  0 2px 8px rgba(0, 0, 0, 0.18);
  --shadow-glass: 0 8px 24px rgba(0, 0, 0, 0.28);
  --shadow-float: 0 16px 40px rgba(0, 0, 0, 0.36);

  /* ---------- 动效 ---------- */
  --duration-fast: 120ms;
  --duration-base: 200ms;
  --duration-slow: 320ms;
  --easing-standard: cubic-bezier(0.2, 0, 0, 1);
}
```

### 5.2 TS 侧镜像（`tokens.ts`）

仅在 TS 里需要数值运算时导出（例如动画库、canvas 绘制）。日常 CSS 消费走 CSS 变量。

---

## 6. CSS 策略

采用 **Tailwind CSS** 作为主样式方案。

### 6.1 为什么选 Tailwind

- **原子化 CSS 天然匹配原子设计**：atoms 用 Tailwind utility class 几乎零 CSS 文件。
- **Design Token 直接映射**：`tailwind.config.ts` 的 `theme.extend` 就是 token 定义，CSS 变量和 class 一一对应。
- **组件级样式无命名冲突**：class 写在 JSX 里，不存在全局类名污染。
- **开发速度快**：不用切文件写 CSS，在 TSX 里直接出样式。

### 6.2 Tailwind 配置与 Token 映射

`tailwind.config.ts` 的 `theme.extend` 直接消费 `tokens.css` 的 CSS 变量：

```ts
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        accent: {
          primary: 'var(--color-accent-primary)',
          success: 'var(--color-accent-success)',
          warning: 'var(--color-accent-warning)',
          danger:  'var(--color-accent-danger)',
        },
        text: {
          primary:   'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          tertiary:  'var(--color-text-tertiary)',
          inverse:   'var(--color-text-inverse)',
        },
        surface: {
          'glass-dark':  'var(--surface-glass-dark)',
          'glass-light': 'var(--surface-glass-light)',
          overlay:       'var(--surface-overlay)',
        },
      },
      borderRadius: {
        sm:   'var(--radius-sm)',
        md:   'var(--radius-md)',
        lg:   'var(--radius-lg)',
        xl:   'var(--radius-xl)',
        pill: 'var(--radius-pill)',
      },
      fontFamily: {
        ui: ['SF Pro Display', '-apple-system', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft:  'var(--shadow-soft)',
        glass: 'var(--shadow-glass)',
        float: 'var(--shadow-float)',
      },
    },
  },
}
```

### 6.3 三条硬规则

1. **常规样式用 Tailwind class**：间距、字号、圆角、颜色等能用 utility 的必须用 utility，不写自定义 CSS。
2. **复杂视觉效果用 `@apply` 或独立 CSS 文件**：毛玻璃多层 `box-shadow`、`backdrop-filter` 组合、SVG filter 等 Tailwind 不好表达的，允许单独 CSS 文件（`Foo.css`），但仍引用 token 变量。
3. **禁止在组件文件里定义跨组件 token**：所有 token 只在 `tokens.css` + `tailwind.config.ts` 定义。

### 6.4 Electron 特殊处理

- `-webkit-app-region: drag/no-drag` 用自定义 Tailwind plugin 或 `@apply` 封装为 `.drag` / `.no-drag` utility。
- `html/body/#root` 透明背景放在 `tokens.css` 的全局层。

---

## 7. Props 约定

### 7.1 API 一致性三条硬规则

1. **回调统一 `onXxx` 前缀**：`onClick`、`onClose`、`onSelect`，禁止 `handleClick`、`clickHandler`。
2. **布尔状态用直接名词**：`online`、`selected`、`disabled`，禁止 `isOnline`、`isDisabled`。
3. **尺寸/变体用字符串枚举**：`size: 'sm' | 'md' | 'lg'`、`variant: 'primary' | 'ghost' | 'danger'`。需要像素值的例外场景才允许 `number`。

### 7.2 其他约定

- **Atom 不接 `className` / `style` 透传**：想改样式 → 加枚举变体，不是开天窗。
- **事件 payload 简单化**：能传 `id` 就不传整个对象。
- **默认值写在解构**：`function Avatar({ size = 'md', online = false })`，不用 `defaultProps`。

---

## 8. 可变 / 不可变规则

每次改动前先问三个问题：

1. **改动会波及其他组件吗？** → 不可变层（需要评审）
2. **改动改变了 API 契约吗？** → 不可变层（需要评审）
3. **改动只换了视觉细节？** → 可变层（自由迭代）

| 分类 | 内容 | 说明 |
|---|---|---|
| 不可变层 | tokens.css、atoms 的 props、molecules 的 props、组件间依赖关系 | 改动需评审，至少要说清影响面 |
| 可变层 | 每个组件内部实现、组件 CSS 细节、organism 的视觉迭代 | 可以放心改，diff 局部 |

**测试策略**：atoms / molecules 单测可选（纯视觉层、改动风险低）；organisms **必须**有单测覆盖核心交互（点击、状态切换、数据绑定），视觉回归另行通过截屏验证。

---

## 9. 产品场景 → 组件映射

| 产品场景 | 用到的 organism | 用到的 molecule | 关键 atom |
|---|---|---|---|
| 胶囊窗口 | CapsuleCard | Avatar、TitleBlock、MenuDots、DragHandle | Surface、StatusDot、Icon、Text |
| 聊天窗口 | ChatPanel | Avatar、MessageBadge | Button、Text、Icon、Surface |
| Agent 列表 | AgentList | Avatar、TitleBlock | StatusDot、Text |
| 设置面板 | SettingsPanel | TitleBlock | Text、Button、Surface |
| 桌宠 | JellyPet | — | Surface、Text |

### 复用性分析

- **高频必抽**（标注所属层；§4 分层表里"待建"的等对应场景落地时再创建，不提前建）：
  - `StatusDot` → `atoms/StatusDot`（§4.1 已定义）。预期在 agent 在线状态、消息未读、通知、桌宠电量等场景复用。
  - `IconButton` → `atoms/Button` 的 variant（§4.1 Button 已定义，`variant` 增加 `'icon'` 变体，不单独建目录）。
  - `SpeechBubble` → `molecules/`（待建，桌宠气泡 + 聊天气泡共用场景出现时再抽）。
  - `Tag/Chip` → `atoms/`（待建，出现标签/状态徽章场景时再抽）。
- **中频用 CSS 类**：Stack / HStack 用 utility class，不做组件。
- **不要抽象**：CapsuleCard 整体、MessageBubble 内部细节——抽了反而限制迭代。

---

## 10. 落地路线图

核心原则：**抽象跟随场景，不提前建帝国**。

### Step 1 — 安装 Tailwind + 落 tokens（基础设施）
- 安装 `tailwindcss`、`@tailwindcss/vite`，配置 `tailwind.config.ts`。
- 新建 `src/design-tokens/tokens.css`（CSS 变量定义）。
- `tailwind.config.ts` 的 `theme.extend` 映射 CSS 变量。
- 在 `main.tsx` 引入 Tailwind + tokens。
- 逐步替换组件里的硬编码颜色/间距。

### Step 2 — 抽两个最高频原子
- `StatusDot`（agent 在线状态、消息未读、桌宠电量等多场景复用）
- `SpeechBubble`（桌宠 + 聊天共用）

### Step 3 — 聊天窗迭代时再抽
- `MessageBubble`
- `AttachmentCard`

### Step 4 — 设置/通知面板迭代时再抽
- `ListItem`
- `Switch`

> 每一步都要有"真实第二次使用场景"才抽。没有第二处复用就别抽。

---

## 11. 现状迁移计划

> 以下表格只列出仓库中**实际存在**的文件（`src/components/`、`src/styles/`、`src/App.tsx` 等）。ChatPanel / SettingsPanel 等 organism 目前尚未落地，等到对应窗口迭代时再按 §10 路线图新建，不在本次迁移范围内。

| 现状位置 | 目标位置 | 动作 |
|---|---|---|
| `src/components/CapsuleCard/CapsuleCard.tsx` | `src/organisms/CapsuleCard/CapsuleCard.tsx` | 移动；业务逻辑保留在 organism |
| `src/components/CapsuleCard/CapsuleAvatar.tsx` | `src/molecules/Avatar/Avatar.tsx` | 重命名为通用 Avatar（品牌 Logo / 图标 / 图片三态） |
| `src/components/CapsuleCard/CapsuleMenu.tsx` | `src/molecules/MenuDots/MenuDots.tsx` | 重命名；内部按钮抽到 `atoms/Button` 的 `icon` variant |
| `src/components/CapsuleCard/LogoM.tsx` | `src/atoms/Logo/Logo.tsx` | 移动；以 `variant` 区分品牌 Logo（M）与后续 AI Logo |
| `src/components/CapsuleCard/index.ts` | `src/organisms/CapsuleCard/index.ts` | 跟随 CapsuleCard 一并移动 |
| `src/components/JellyPet.tsx`（单文件） | `src/organisms/JellyPet/JellyPet.tsx` | 拆成目录形态；如出现气泡再抽 `molecules/SpeechBubble` |
| `src/styles/capsule.css` 中的全局 token（`:root { --accent-green, --accent-blue, --text-primary, --text-secondary }`） | `src/design-tokens/tokens.css` | 迁入权威 token 文件，使用 `--color-accent-success` / `--color-accent-primary` / `--color-text-primary` / `--color-text-secondary` 标准名 |
| `src/styles/capsule.css` 中的组件级样式 | 迁入 Tailwind class 写在 JSX 中；复杂阴影/毛玻璃保留 `CapsuleCard.css` | 组件内部尺寸用 Tailwind arbitrary value `w-[340px]` 或保留局部 CSS 变量 |
| `src/styles/glass.css` | `src/design-tokens/tokens.css` 合并基础玻璃 token；组件级玻璃样式留在各 organism CSS | 按"token 只出基础色，渐变在组件层"原则拆分 |
| `src/assets/logo-m.png` | 保持在 `src/assets/` | 路径不动，仅 `Logo.tsx` 引用路径同步更新 |
| `src/App.tsx` 中的多窗口路由分发 | `src/pages/CapsulePage.tsx` / `PetPage.tsx` / 等 | 按窗口拆 Page；`App.tsx` 退化为根选择器 |
| `src/store/atoms.ts`（jotai，空壳） | `src/store/`（改用 zustand，按领域拆分：`teamStore.ts` / `chatStore.ts` / `uiStore.ts`） | 删除 jotai 依赖，安装 zustand，按领域建 store |
| `src/api/client.ts`、`src/main.tsx` | 路径保持不变 | 不在组件分层迁移范围 |

迁移策略：

1. **不要一次性 big bang**：先起新目录，按组件迁；旧目录保留直到最后一个引用消失。
2. **每个 PR 只迁一个 organism**：避免 diff 爆炸。
3. **迁移过程中禁止顺手重构**：想改 API 的改动单独开 PR。
4. **token 迁移先行**：先建 `design-tokens/tokens.css` 并在 `main.tsx` 首个引入，旧 `capsule.css` 的 `:root` 声明直接删除，组件 CSS 里的 `var(--accent-green)` 等改为 `var(--color-accent-success)`。

---

## 12. 附录：命名速查

| 类型 | 示例 | 反例 |
|---|---|---|
| 组件目录 | `atoms/StatusDot/` | `atoms/status_dot/` |
| 组件文件 | `StatusDot.tsx`（+ 可选 `StatusDot.css`） | `index.tsx` + `style.css` |
| Tailwind class | `className="w-2.5 h-2.5 rounded-full bg-accent-success"` | 自定义全局 `.dot` 类 |
| 回调 prop | `onSelect` | `handleSelect`、`selectHandler` |
| 布尔 prop | `selected` | `isSelected` |
| 尺寸 prop | `size="md"` | `size={12}`（除非是例外场景） |
