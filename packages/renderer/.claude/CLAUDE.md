# Renderer 组件库使用指南

本文件给所有进到 `packages/renderer/` 做事的 agent 看。**读完再动手**。

## 0. 铁律（先看这里）

1. **禁止手搓组件**。所有 UI 组件必须来自组件库（`atoms/` / `molecules/` / `organisms/`）。
   - 禁止在 `pages/` / `organisms/` / `templates/` 里写裸 `<div class="...">` 拼 UI。
   - 禁止引入 Tailwind、Material、antd、shadcn 等外部 UI 库。
   - 唯一例外：页面级布局容器（`.some-page__layout`）。容器本身不是 UI 组件。
2. **缺组件先补，再使用**。流程：
   - 新建 `src/<layer>/<Name>/{Name.tsx, Name.css, index.ts}`。
   - 到 `playground/registry.ts` 注册一条 `ComponentEntry`。
   - 再在业务代码引用。**先注册才算完工**，未注册 = 不存在。
3. **先查 playground，没有才补**。改任何页面前，打开 `playground/registry.ts` 扫一遍当前清单（`grep -n "name: '" playground/registry.ts`）。命中就直接用；没命中再补。
4. **组件库 100% 合规才能交付**。交付前自查：
   - 0 裸 SVG（必须用 `<Icon name="..." />`）。
   - 0 Tailwind 裸类 / 0 行内 color/background style。
   - 0 自研 `<button>` / `<input>` / `<textarea>` / `<dialog>`（走 atoms）。

## 1. 组件层级

```
atoms/       原子 — 无业务语义，纯视觉（Button/Input/Icon/Surface/StatusDot...）
molecules/   分子 — 组合 atoms 的小交互单元（ChatInput/ToolBar/AvatarPicker...）
organisms/   器官 — 完整的业务区块（ChatPanel/TemplateList/NotificationCenter...）
templates/   模板 — 整页布局骨架（PanelWindow/CapsuleWindow）
```

**依赖方向**：templates → organisms → molecules → atoms。反向依赖 = bug。

## 2. Playground 地址与版本号

- **启动**：`cd packages/renderer && npm run playground:dev`（默认 5174 端口）。
- **构建**：`npm run playground:build` → `playground/dist`。
- **版本号**：`playground/App.tsx` 的 `PLAYGROUND_VERSION` 常量 + `playground/index.html` 的 `<title>`。**两处必须一致**。
- **升版规则**：
  - 新增组件 / 大改 registry / props 重构 → minor 升（1.6.0 → 1.7.0）。
  - 小改 demo 数据、文案、修样式 → patch 升（1.7.0 → 1.7.1）。
  - 仅内部重构不影响展示 → 不升。

## 3. Playground registry 规则

每个 atoms/molecules/organisms 组件必须有一条 `ComponentEntry`：

```ts
{
  name: 'ComponentName',
  layer: 'atoms' | 'molecules' | 'organisms',
  group: 'basic' | 'input' | 'display' | 'container' | 'form' | 'chat' | 'nav' | 'team' | 'display-mol' | 'full',
  component: ComponentName,
  props: PropDef[],           // 可调 props（枚举/布尔/字符串/数字）
  defaults: { ... },          // 所有 prop 的初始值 + 复杂数据（不在 props 里调的）
  renderChildren?: (v) => ReactNode,  // 如果组件接受 children
  note?: '一句话 demo 说明',
  handlers?: (setValues) => ({ onXxx: (...args) => { setValues(...) } }),
}
```

### 回调自动透传

`ComponentCard.tsx` 会自动把 entry 声明过的 `on*` 回调全部注入组件（不再需要维护白名单）。收集来源：
- `defaults` 里的 key
- `props` defs 里的 name
- `handlers()` 返回对象的 key

**凡是希望在 Events 面板看到日志 / 让 demo 交互生效的回调**，写到 `handlers` 里即可（不需要实际更新 values 时返回 `() => {}`）。

## 4. 常见陷阱

- **`CONTROLLED_PROP_BY_CALLBACK`**：`onChange → value`、`onSelect → activeId`。这两个回调第一个参数会自动写回到对应 prop。如果你的组件语义不同（比如 `onChange` 的参数不是 value），**别用同名回调**，换个名字。
- **`Tag.closable` 是 demo 字段**：Tag 组件没有 `closable` prop，它只判断 `onRemove` 是否传入。registry 里的 `closable` 是 playground 约定，用来演示开关。
- **图标命名**：`Icon` 支持 `close/send/chevron/chevron-down/settings/plus/check/check-double/team`。没有 `arrow/back/menu`，要加先改 `src/atoms/Icon/Icon.tsx`。
- **Logo 三态**：`online/connecting/offline`。`online` prop 已 deprecated，新代码用 `status`。
- **AgentLogo vs Logo**：`AgentLogo` 专门画 CLI 的 logo（claude/codex/gemini/aider/cursor/copilot/unknown）；`Logo` 是产品 M-TEAM logo。别混用。
- **ChatPanel 主 Agent 场景**：`agents=[]` 会抑制 AgentSwitcher，模型切换走 `toolBar` 插槽（ToolBar Dropdown）。团队场景传 `agents` 数组会顶部渲染 AgentSwitcher。

## 5. 改完组件后的自检清单

1. `npm run -w @mcp-team-hub/renderer tsc` 0 error。
2. `npm run -w @mcp-team-hub/renderer build` 成功。
3. `npm run playground:build` 成功。
4. Playground 打开能看到新组件卡片，props 可调、Events 有日志。
5. 业务页里用到的 props 都在 registry demo 过。
6. 版本号更新（App.tsx + index.html 两处）。
