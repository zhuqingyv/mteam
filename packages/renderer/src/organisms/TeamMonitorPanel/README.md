# TeamMonitorPanel
团队监控面板，组合 `TeamSidebar` + `TeamCanvas`：左侧切换团队，右侧画布展示该团队的 Agents。外层是发光毛玻璃容器（panel variant），支持「展开 ↔ 胶囊」切换（350ms 过渡）。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| teams | Array<{ id; name; memberCount }> | — | 团队列表 |
| agents | Array<{ id; name; status; lastMessage?; x; y }> | — | 当前画布的 Agent 列表 |
| activeTeamId | string | teams[0].id | 受控的选中团队 |
| onSelectTeam | (id) => void | — | 切换团队回调 |
| onCreateTeam | () => void | — | 新建团队回调 |
| onAgentDragEnd | (id, x, y) => void | — | Agent 拖拽结束回调 |
| collapsed | boolean | false | 是否收起为胶囊态 |
| onToggleCollapsed | () => void | — | 胶囊/展开切换回调 |

## Usage
```tsx
<TeamMonitorPanel
  teams={teams}
  agents={agents}
  activeTeamId={activeId}
  onSelectTeam={setTeam}
  onCreateTeam={create}
  onAgentDragEnd={moveAgent}
  collapsed={collapsed}
  onToggleCollapsed={() => setCollapsed((v) => !v)}
/>
```
