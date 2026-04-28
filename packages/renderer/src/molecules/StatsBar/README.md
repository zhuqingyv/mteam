# StatsBar

数字员工统计条，横排展示 total / online / idle / offline 四个指标。发光玻璃面板（Surface panel variant）+ StatusDot / Icon + 数字 + 标签。

## Props

```ts
type StatKey = 'total' | 'online' | 'idle' | 'offline';

interface StatsBarProps {
  stats: {
    total: number;
    online: number;
    idle: number;
    offline?: number;
  };
  onStatClick?: (key: StatKey) => void;   // 传入才渲染为可点击按钮
  activeKey?: StatKey | null;             // 当前选中的筛选键，高亮对应 cell
}
```

## 数据来源

WS `get_workers` 响应里的 `stats` 对象，参见 `docs/frontend-api/workers-api.md`。

## 样式约定

- total 单元格用 Icon `team`；
- online 绿色（StatusDot `online` + 值绿色）；
- idle 橙色（StatusDot `busy`）；
- offline 灰色（StatusDot `offline`）；
- cell 之间用竖向渐变分隔线。

`offline` 缺省时不渲染离线单元格。

## 交互

- 传入 `onStatClick`：每个 cell 变为 `<button>`，带 hover 阴影加深 + translateY(-1px)，点击时 inset 阴影凹陷反馈。
- `activeKey` 匹配 cell 时高亮（蓝色半透明底 + 发光边框），用于上层切换 Tab 筛选后回显。
- 不传 `onStatClick`：cell 渲染为 `<div>`，纯展示、无 hover 效果。
