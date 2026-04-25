# TeamMonitorPanel
团队监控面板，组合 `TeamSidebar` + `TeamCanvas`：左侧切换团队，右侧画布展示该团队的 Agents。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| teams | Array<{ id; name; memberCount }> | — | 团队列表 |
| agents | Array<{ id; name; status; lastMessage?; x; y }> | — | 当前画布的 Agent 列表 |
| activeTeamId | string | teams[0].id | 受控的选中团队（未传时内部维护） |
| onSelectTeam | (id) => void | — | 切换团队回调 |
| onAgentDragEnd | (id, x, y) => void | — | Agent 拖拽结束回调 |

## Usage
```tsx
import TeamMonitorPanel from './TeamMonitorPanel';

<TeamMonitorPanel
  teams={teams}
  agents={agents}
  onSelectTeam={setTeam}
  onAgentDragEnd={moveAgent}
/>
```
