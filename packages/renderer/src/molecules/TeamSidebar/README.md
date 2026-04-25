# TeamSidebar
左侧团队列表侧栏，聚合多个 `TeamSidebarItem`；自带展开/收起切换按钮。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| teams | Array<{ id; name; memberCount }> | — | 团队列表 |
| activeTeamId | string | — | 当前选中的团队 id |
| onSelectTeam | (id: string) => void | — | 选中团队回调 |
| defaultCollapsed | boolean | false | 初始是否折叠 |

## Usage
```tsx
import TeamSidebar from './TeamSidebar';

<TeamSidebar
  teams={[{ id: 'a', name: 'Core', memberCount: 4 }]}
  activeTeamId="a"
  onSelectTeam={setActive}
/>
```
