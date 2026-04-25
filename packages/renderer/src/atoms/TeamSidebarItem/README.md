# TeamSidebarItem
团队侧边栏单项按钮，展示首字母图标 + 团队名 + 成员数；支持选中态和折叠态。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| name | string | — | 团队名称（首字母用作图标） |
| memberCount | number | — | 成员数量 |
| active | boolean | false | 是否为当前选中团队 |
| collapsed | boolean | false | 折叠态只显示图标 |
| onClick | () => void | — | 点击回调 |

## Usage
```tsx
import TeamSidebarItem from './TeamSidebarItem';

<TeamSidebarItem
  name="Core Team"
  memberCount={4}
  active
  onClick={() => selectTeam('core')}
/>
```
