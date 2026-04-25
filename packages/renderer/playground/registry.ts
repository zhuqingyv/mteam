import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import Surface from '../src/atoms/Surface';
import StatusDot from '../src/atoms/StatusDot';
import Logo from '../src/atoms/Logo';
import Text from '../src/atoms/Text';
import Button from '../src/atoms/Button';
import Icon from '../src/atoms/Icon';
import TypingDots from '../src/atoms/TypingDots';
import MessageMeta from '../src/atoms/MessageMeta';
import ToolCallItem from '../src/atoms/ToolCallItem';
import NotificationCard from '../src/atoms/NotificationCard';
import VirtualList from '../src/atoms/VirtualList';
import ToolCallList from '../src/molecules/ToolCallList';
import NotificationStack from '../src/molecules/NotificationStack';
import Avatar from '../src/molecules/Avatar';
import TitleBlock from '../src/molecules/TitleBlock';
import MenuDots from '../src/molecules/MenuDots';
import MessageBubble from '../src/molecules/MessageBubble';
import MessageRow from '../src/molecules/MessageRow';
import ChatHeader from '../src/molecules/ChatHeader';
import ChatInput from '../src/molecules/ChatInput';
import AgentSwitcher from '../src/molecules/AgentSwitcher';
import DragHandle from '../src/molecules/DragHandle';
import MessageBadge from '../src/molecules/MessageBadge';
import TeamSidebarItem from '../src/atoms/TeamSidebarItem';
import TeamSidebar from '../src/molecules/TeamSidebar';
import AgentCard from '../src/molecules/AgentCard';
import CliList from '../src/molecules/CliList';
import RosterList from '../src/molecules/RosterList';
import CapsuleCard from '../src/organisms/CapsuleCard';
import ChatPanel from '../src/organisms/ChatPanel';
import TeamCanvas from '../src/organisms/TeamCanvas';
import TeamMonitorPanel from '../src/organisms/TeamMonitorPanel';
import PrimaryAgentSettings from '../src/organisms/PrimaryAgentSettings';
import NotificationCenter from '../src/organisms/NotificationCenter';
import AgentList from '../src/organisms/AgentList';
import TemplateEditor from '../src/organisms/TemplateEditor';

export type PropType = 'string' | 'number' | 'boolean' | 'enum';

export interface PropDef {
  name: string;
  type: PropType;
  options?: string[];
  default: unknown;
  description: string;
}

export type Layer = 'atoms' | 'molecules' | 'organisms';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type ValuesUpdater = (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;

export interface ComponentEntry {
  name: string;
  layer: Layer;
  component: AnyComponent;
  props: PropDef[];
  defaults: Record<string, unknown>;
  renderChildren?: (props: Record<string, unknown>) => ReactNode;
  note?: string;
  // Optional callbacks that mutate the card's values state. The returned map is
  // merged on top of the default loggers, so event logging still runs.
  handlers?: (setValues: ValuesUpdater) => Record<string, (...args: unknown[]) => void>;
}

export const registry: ComponentEntry[] = [
  {
    name: 'Surface',
    layer: 'atoms',
    component: Surface,
    props: [
      {
        name: 'variant',
        type: 'enum',
        options: ['capsule', 'panel'],
        default: 'capsule',
        description: '形态：capsule 胶囊 / panel 面板',
      },
    ],
    defaults: { variant: 'capsule' },
    renderChildren: () => React.createElement('div', { style: { padding: '20px 24px', color: 'rgba(255,255,255,0.7)', fontSize: 13 } }, 'Surface Content'),
  },
  {
    name: 'StatusDot',
    layer: 'atoms',
    component: StatusDot,
    props: [
      {
        name: 'status',
        type: 'enum',
        options: ['online', 'busy', 'offline'],
        default: 'online',
        description: '状态颜色',
      },
      {
        name: 'size',
        type: 'enum',
        options: ['sm', 'md', 'lg'],
        default: 'md',
        description: '尺寸',
      },
    ],
    defaults: { status: 'online', size: 'md' },
  },
  {
    name: 'Logo',
    layer: 'atoms',
    component: Logo,
    props: [
      { name: 'size', type: 'number', default: 56, description: '尺寸 px' },
      { name: 'online', type: 'boolean', default: true, description: '在线状态（false=灰度）' },
    ],
    defaults: { size: 56, online: true },
  },
  {
    name: 'Text',
    layer: 'atoms',
    component: Text,
    props: [
      {
        name: 'variant',
        type: 'enum',
        options: ['title', 'subtitle', 'caption', 'badge'],
        default: 'caption',
        description: '文本样式',
      },
    ],
    defaults: { variant: 'title' },
    renderChildren: () => 'M-TEAM',
  },
  {
    name: 'Button',
    layer: 'atoms',
    component: Button,
    props: [
      {
        name: 'variant',
        type: 'enum',
        options: ['primary', 'ghost', 'icon', 'dots'],
        default: 'primary',
        description: '按钮样式',
      },
      {
        name: 'size',
        type: 'enum',
        options: ['sm', 'md', 'lg'],
        default: 'md',
        description: '尺寸',
      },
      { name: 'disabled', type: 'boolean', default: false, description: '禁用' },
    ],
    defaults: { variant: 'primary', size: 'md', disabled: false },
    renderChildren: (p) => (p.variant === 'dots' ? null : 'Click Me'),
  },
  {
    name: 'Icon',
    layer: 'atoms',
    component: Icon,
    props: [
      {
        name: 'name',
        type: 'enum',
        options: ['close', 'send', 'chevron', 'settings', 'plus', 'check-double'],
        default: 'send',
        description: '图标名',
      },
      { name: 'size', type: 'number', default: 24, description: '尺寸 px' },
      { name: 'color', type: 'string', default: '#e6edf7', description: '颜色' },
    ],
    defaults: { name: 'send', size: 24, color: '#e6edf7' },
  },
  {
    name: 'TypingDots',
    layer: 'atoms',
    component: TypingDots,
    props: [
      { name: 'color', type: 'string', default: 'rgba(230,237,247,0.8)', description: '点颜色' },
    ],
    defaults: { color: 'rgba(230,237,247,0.8)' },
  },
  {
    name: 'MessageMeta',
    layer: 'atoms',
    component: MessageMeta,
    props: [
      { name: 'time', type: 'string', default: '10:24', description: '时间文本' },
      { name: 'read', type: 'boolean', default: true, description: '已读双勾' },
    ],
    defaults: { time: '10:24', read: true },
  },
  {
    name: 'ToolCallItem',
    layer: 'atoms',
    component: ToolCallItem,
    props: [
      { name: 'toolName', type: 'string', default: 'read_file', description: '工具名' },
      {
        name: 'status',
        type: 'enum',
        options: ['running', 'done', 'error'],
        default: 'done',
        description: '状态',
      },
      { name: 'summary', type: 'string', default: '读取 package.json', description: '摘要' },
      { name: 'duration', type: 'string', default: '1.2s', description: '耗时' },
    ],
    defaults: { toolName: 'read_file', status: 'done', summary: '读取 package.json', duration: '1.2s' },
  },
  {
    name: 'NotificationCard',
    layer: 'atoms',
    component: NotificationCard,
    props: [
      { name: 'title', type: 'string', default: 'Claude 完成任务', description: '标题' },
      { name: 'message', type: 'string', default: 'UI Bug 已修复，等待确认', description: '内容' },
      { name: 'time', type: 'string', default: '刚刚', description: '时间' },
      {
        name: 'type',
        type: 'enum',
        options: ['info', 'task', 'error'],
        default: 'task',
        description: '类型（左侧彩色条）',
      },
    ],
    defaults: { title: 'Claude 完成任务', message: 'UI Bug 已修复，等待确认', time: '刚刚', type: 'task' },
  },
  {
    name: 'VirtualList',
    layer: 'atoms',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: (props: Record<string, unknown>) =>
      React.createElement(
        'div',
        { style: { width: 420, height: 360, background: 'rgba(255,255,255,0.02)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        React.createElement(VirtualList as any, props),
      ),
    props: [
      { name: 'itemEstimateHeight', type: 'number', default: 60, description: '预估行高 px' },
      { name: 'overscan', type: 'number', default: 3, description: '上下额外渲染条数' },
    ],
    defaults: {
      itemEstimateHeight: 60,
      overscan: 3,
      items: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        text: `第 ${i + 1} 条消息 · ${'内容'.repeat((i % 5) + 1)}`,
      })),
      getKey: (m: { id: string }) => m.id,
      renderItem: (m: { id: string; text: string }) => React.createElement(
        'div',
        { style: { padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', color: '#e6edf7', fontSize: 13 } },
        m.text,
      ),
    },
    note: '100 条 mock 数据，仅渲染可见区域（DOM ≤ 20）',
  },
  {
    name: 'ToolCallList',
    layer: 'molecules',
    component: ToolCallList,
    props: [
      { name: 'defaultCollapsed', type: 'boolean', default: false, description: '默认收起' },
    ],
    defaults: {
      defaultCollapsed: false,
      calls: [
        { id: '1', toolName: 'read_file', status: 'done', summary: '读取 package.json', duration: '0.3s' },
        { id: '2', toolName: 'bash', status: 'done', summary: '执行 npm install', duration: '3.4s' },
        { id: '3', toolName: 'edit', status: 'running', summary: '修改 App.tsx' },
      ],
    },
    note: 'calls 为 mock 数据',
  },
  {
    name: 'Avatar',
    layer: 'molecules',
    component: Avatar,
    props: [
      { name: 'size', type: 'number', default: 56, description: 'Logo 尺寸' },
      { name: 'online', type: 'boolean', default: true, description: '在线状态点' },
    ],
    defaults: { size: 56, online: true },
  },
  {
    name: 'TitleBlock',
    layer: 'molecules',
    component: TitleBlock,
    props: [
      { name: 'title', type: 'string', default: 'M-TEAM', description: '主标题' },
      { name: 'subtitle', type: 'string', default: '3 Agents · 2 Tasks', description: '副标题' },
      { name: 'badgeText', type: 'string', default: '5 New messages', description: '徽章文本' },
      { name: 'badgeCount', type: 'number', default: 5, description: '徽章计数（>0 显示圆点）' },
    ],
    defaults: { title: 'M-TEAM', subtitle: '3 Agents · 2 Tasks', badgeText: '5 New messages', badgeCount: 5 },
  },
  {
    name: 'MenuDots',
    layer: 'molecules',
    component: MenuDots,
    props: [],
    defaults: {},
  },
  {
    name: 'MessageBubble',
    layer: 'molecules',
    component: MessageBubble,
    props: [
      {
        name: 'variant',
        type: 'enum',
        options: ['agent', 'user', 'thinking'],
        default: 'agent',
        description: '气泡类型',
      },
      { name: 'agentName', type: 'string', default: 'Claude', description: 'Agent 名称（agent/thinking 显示）' },
      { name: 'time', type: 'string', default: '10:24', description: '时间' },
      { name: 'read', type: 'boolean', default: false, description: 'user 已读标识' },
    ],
    defaults: { variant: 'agent', agentName: 'Claude', time: '10:24', read: false },
    renderChildren: (p) => (p.variant === 'thinking' ? null : '你好，我是团队 Agent'),
  },
  {
    name: 'MessageRow',
    layer: 'molecules',
    component: MessageRow,
    props: [
      {
        name: 'role',
        type: 'enum',
        options: ['agent', 'user'],
        default: 'agent',
        description: '角色',
      },
      { name: 'content', type: 'string', default: '你好，我是团队 Agent', description: '消息内容' },
      { name: 'time', type: 'string', default: '20:48', description: '时间' },
      { name: 'agentName', type: 'string', default: 'Claude', description: 'Agent 名（agent 角色显示）' },
      { name: 'thinking', type: 'boolean', default: false, description: '思考中' },
      { name: 'read', type: 'boolean', default: false, description: 'user 已读' },
    ],
    defaults: {
      role: 'agent',
      content: '你好，我是团队 Agent',
      time: '20:48',
      agentName: 'Claude',
      thinking: false,
      read: false,
      toolCalls: [
        { id: '1', toolName: 'read_file', status: 'done', summary: '读取 package.json', duration: '0.3s' },
        { id: '2', toolName: 'edit', status: 'running', summary: '修改 App.tsx' },
      ],
    },
  },
  {
    name: 'ChatHeader',
    layer: 'molecules',
    component: ChatHeader,
    props: [
      { name: 'name', type: 'string', default: 'M-TEAM', description: '团队名' },
      { name: 'online', type: 'boolean', default: true, description: '在线' },
    ],
    defaults: { name: 'M-TEAM', online: true },
    note: '展开态顶栏',
  },
  {
    name: 'ChatInput',
    layer: 'molecules',
    component: ChatInput,
    props: [
      { name: 'placeholder', type: 'string', default: '输入消息…', description: '占位符' },
      { name: 'value', type: 'string', default: '有什么我能帮你的？', description: '输入内容' },
    ],
    defaults: { placeholder: '输入消息…', value: '有什么我能帮你的？' },
    note: '可输入、Enter/点箭头发送（发送后清空）',
    handlers: (setValues) => ({
      onSend: () => {
        setValues((prev) => ({ ...prev, value: '' }));
      },
    }),
  },
  {
    name: 'AgentSwitcher',
    layer: 'molecules',
    component: AgentSwitcher,
    props: [
      { name: 'activeId', type: 'string', default: 'claude', description: '当前激活 Agent id' },
    ],
    defaults: {
      activeId: 'claude',
      agents: [
        { id: 'claude', name: 'Claude', icon: 'C' },
        { id: 'codex', name: 'Codex', icon: 'X' },
        { id: 'gpt', name: 'GPT', icon: 'G' },
      ],
    },
    note: 'agents 列表为 mock 数据',
  },
  {
    name: 'DragHandle',
    layer: 'molecules',
    component: DragHandle,
    props: [
      { name: 'visible', type: 'boolean', default: true, description: '显示' },
    ],
    defaults: { visible: true },
  },
  {
    name: 'MessageBadge',
    layer: 'molecules',
    component: MessageBadge,
    props: [
      { name: 'count', type: 'number', default: 5, description: '计数' },
      {
        name: 'variant',
        type: 'enum',
        options: ['dot', 'number'],
        default: 'number',
        description: '样式',
      },
    ],
    defaults: { count: 5, variant: 'number' },
  },
  {
    name: 'NotificationStack',
    layer: 'molecules',
    component: NotificationStack,
    props: [
      { name: 'maxVisible', type: 'number', default: 3, description: '最多显示层数' },
    ],
    defaults: {
      maxVisible: 3,
      acknowledgedIds: [],
      notifications: [
        { id: '1', title: 'Claude 完成任务', message: 'UI Bug 已修复，等待确认', time: '刚刚', type: 'task' },
        { id: '2', title: '新消息', message: 'Codex 发送了一条消息', time: '2分钟前', type: 'info' },
        { id: '3', title: '构建失败', message: 'vite build 报错：Module not found', time: '5分钟前', type: 'error' },
      ],
    },
    note: 'acknowledgedIds 驱动签收动画（打勾→淡出→滑走）；card 无 × 按钮',
  },
  {
    name: 'CapsuleCard',
    layer: 'organisms',
    component: CapsuleCard,
    props: [
      { name: 'name', type: 'string', default: 'M-TEAM', description: '团队名' },
      { name: 'agentCount', type: 'number', default: 3, description: 'Agent 数' },
      { name: 'taskCount', type: 'number', default: 2, description: 'Task 数' },
      { name: 'messageCount', type: 'number', default: 5, description: '消息数' },
      { name: 'online', type: 'boolean', default: true, description: '在线' },
    ],
    defaults: { name: 'M-TEAM', agentCount: 3, taskCount: 2, messageCount: 5, online: true },
    note: '展开动画依赖 Electron，Playground 仅展示收起态',
  },
  {
    name: 'ChatPanel',
    layer: 'organisms',
    component: ChatPanel,
    props: [],
    defaults: {
      messages: [
        { id: '1', role: 'agent', agentName: 'Claude', content: '你好！我是 MTEAM，你的智能开发助手。有什么可以帮你的吗？😊', time: '20:48' },
        { id: '2', role: 'user', content: '帮我总结一下当前 Agent 的状态', time: '20:48', read: true },
        {
          id: '3',
          role: 'agent',
          agentName: 'Claude',
          content: '好的，当前 3 个 Agent 均在线：\n• claude-code：空闲\n• codex-agent：运行中（任务：修复 UI Bug）\n• qwen-dev：空闲',
          time: '20:49',
          toolCalls: [
            { id: 't1', toolName: 'list_agents', status: 'done', summary: '列出所有 Agent', duration: '0.2s' },
            { id: 't2', toolName: 'get_status', status: 'done', summary: '查询运行状态', duration: '0.5s' },
            { id: 't3', toolName: 'read_tasks', status: 'running', summary: '读取任务队列' },
          ],
        },
        { id: '4', role: 'user', content: '帮我优化 MTEAM 窗口的 UI 设计', time: '20:50', read: true },
        { id: '5', role: 'agent', agentName: 'Claude', content: '', time: '', thinking: true },
      ],
      agents: [
        { id: 'claude', name: 'Claude', active: true },
        { id: 'codex', name: 'Codex' },
        { id: 'qwen', name: 'Qwen' },
      ],
      inputPlaceholder: '给 MTEAM 发送消息...',
    },
    note: '消息/Agent 列表为 mock 数据',
  },
  {
    name: 'TeamSidebarItem',
    layer: 'atoms',
    component: TeamSidebarItem,
    props: [
      { name: 'name', type: 'string', default: 'Frontend', description: '团队名' },
      { name: 'memberCount', type: 'number', default: 3, description: '成员数' },
      { name: 'active', type: 'boolean', default: false, description: '激活态' },
      { name: 'collapsed', type: 'boolean', default: false, description: '收起（只图标）' },
    ],
    defaults: { name: 'Frontend', memberCount: 3, active: false, collapsed: false },
  },
  {
    name: 'TeamSidebar',
    layer: 'molecules',
    component: TeamSidebar,
    props: [
      { name: 'activeTeamId', type: 'string', default: 'frontend', description: '激活 team id' },
      { name: 'defaultCollapsed', type: 'boolean', default: false, description: '默认收起' },
    ],
    defaults: {
      activeTeamId: 'frontend',
      defaultCollapsed: false,
      teams: [
        { id: 'frontend', name: 'Frontend', memberCount: 4 },
        { id: 'backend', name: 'Backend', memberCount: 3 },
        { id: 'devops', name: 'DevOps', memberCount: 2 },
      ],
    },
    note: 'teams 为 mock 数据',
  },
  {
    name: 'AgentCard',
    layer: 'molecules',
    component: AgentCard,
    props: [
      { name: 'name', type: 'string', default: 'Claude', description: 'Agent 名' },
      {
        name: 'status',
        type: 'enum',
        options: ['working', 'idle', 'shutdown'],
        default: 'working',
        description: '状态',
      },
      { name: 'lastMessage', type: 'string', default: '正在修复 UI Bug…', description: '最后消息' },
      { name: 'x', type: 'number', default: 0, description: 'X 位置' },
      { name: 'y', type: 'number', default: 0, description: 'Y 位置' },
    ],
    defaults: { name: 'Claude', status: 'working', lastMessage: '正在修复 UI Bug…', x: 0, y: 0 },
    note: '可拖拽（mousedown/move/up），点击可展开为 400×400 CapsuleCard，× 回到胶囊态',
  },
  {
    name: 'TeamCanvas',
    layer: 'organisms',
    component: TeamCanvas,
    props: [],
    defaults: {
      agents: [
        { id: 'a1', name: 'Claude', status: 'working', lastMessage: '修复 UI Bug', x: 40, y: 40 },
        { id: 'a2', name: 'Codex', status: 'idle', lastMessage: '等待任务', x: 240, y: 160 },
        { id: 'a3', name: 'Qwen', status: 'shutdown', x: 80, y: 280 },
      ],
    },
    note: '画布式布局，卡片可拖拽',
  },
  {
    name: 'TeamMonitorPanel',
    layer: 'organisms',
    component: TeamMonitorPanel,
    props: [
      { name: 'activeTeamId', type: 'string', default: 'frontend', description: '激活 team id' },
    ],
    defaults: {
      activeTeamId: 'frontend',
      teams: [
        { id: 'frontend', name: 'Frontend', memberCount: 4 },
        { id: 'backend', name: 'Backend', memberCount: 3 },
        { id: 'devops', name: 'DevOps', memberCount: 2 },
      ],
      agents: [
        { id: 'a1', name: 'Claude', status: 'working', lastMessage: '修复 UI Bug', x: 40, y: 40 },
        { id: 'a2', name: 'Codex', status: 'idle', lastMessage: '等待任务', x: 260, y: 160 },
        { id: 'a3', name: 'Qwen', status: 'shutdown', x: 100, y: 300 },
      ],
    },
    note: '完整监控面板：侧边栏 + 画布',
  },
  {
    name: 'CliList',
    layer: 'molecules',
    component: CliList,
    props: [],
    defaults: {
      clis: [
        { name: 'claude', path: '/usr/local/bin/claude', available: true },
        { name: 'codex', path: '/usr/local/bin/codex', available: true },
        { name: 'qwen', path: '', available: false },
      ],
    },
    note: 'clis 为 mock；Refresh 点击触发 onRefresh',
  },
  {
    name: 'PrimaryAgentSettings',
    layer: 'organisms',
    component: PrimaryAgentSettings,
    props: [
      { name: 'running', type: 'boolean', default: false, description: '总控是否运行中' },
    ],
    defaults: {
      running: false,
      config: { model: 'claude-opus-4-7', maxTokens: 8192 },
    },
    note: 'Start/Stop 与 running 状态联动（disabled）',
    handlers: (setValues) => ({
      onStart: () => setValues((p) => ({ ...p, running: true })),
      onStop: () => setValues((p) => ({ ...p, running: false })),
    }),
  },
  {
    name: 'NotificationCenter',
    layer: 'organisms',
    component: NotificationCenter,
    props: [
      { name: 'open', type: 'boolean', default: true, description: '是否展开抽屉' },
    ],
    defaults: {
      open: true,
      acknowledgedIds: [] as string[],
      notifications: [
        { id: '1', title: 'Claude 完成任务', message: 'UI Bug 已修复，等待确认', time: '刚刚', type: 'task' },
        { id: '2', title: '新消息', message: 'Codex 发送了一条消息', time: '2 分钟前', type: 'info' },
        { id: '3', title: '构建失败', message: 'vite build 报错：Module not found', time: '5 分钟前', type: 'error' },
        { id: '4', title: '模板已更新', message: 'frontend-engineer 的系统提示词已更新', time: '10 分钟前', type: 'info' },
      ],
    },
    note: '点击条目标记已读（变暗）；× 关闭抽屉',
    handlers: (setValues) => ({
      onAcknowledge: (id: unknown) => setValues((p) => {
        const prev = (p.acknowledgedIds as string[]) || [];
        return prev.includes(id as string) ? p : { ...p, acknowledgedIds: [...prev, id as string] };
      }),
      onClose: () => setValues((p) => ({ ...p, open: false })),
    }),
  },
  {
    name: 'RosterList',
    layer: 'molecules',
    component: RosterList,
    props: [],
    defaults: {
      entries: [
        { id: 'i1', name: 'claude-leader', alias: 'Lead', scope: 'local' },
        { id: 'i2', name: 'codex-worker', scope: 'local' },
        { id: 'i3', name: 'qwen-remote', alias: 'Q', scope: 'remote' },
      ],
    },
    note: '点击 alias 编辑；Enter 提交、Esc 取消',
    handlers: (setValues) => ({
      onEditAlias: (id: unknown, alias: unknown) => setValues((p) => {
        const list = (p.entries as { id: string; alias?: string }[]) || [];
        return { ...p, entries: list.map((e) => e.id === id ? { ...e, alias: alias as string } : e) };
      }),
    }),
  },
  {
    name: 'AgentList',
    layer: 'organisms',
    component: AgentList,
    props: [],
    defaults: {
      agents: [
        { id: 'a1', name: 'claude-frontend', status: 'running', task: '修复 UI Bug' },
        { id: 'a2', name: 'codex-backend', status: 'idle' },
        { id: 'a3', name: 'qwen-offline', status: 'offline' },
      ],
    },
    note: 'offline→Activate；其他→Offline；全部都有 Delete',
  },
  {
    name: 'TemplateEditor',
    layer: 'organisms',
    component: TemplateEditor,
    props: [],
    defaults: {
      template: { name: 'frontend-engineer', role: 'engineer', persona: '负责前端开发与 UI 实现。', availableMcps: ['filesystem', 'git'] },
      mcpOptions: ['filesystem', 'git', 'github', 'browser', 'shell'],
    },
    note: 'Save 触发 onSave（payload = 当前表单值）；Cancel 触发 onCancel',
  },
];

// 页面级组件（不在 Playground 展示）：ExpandedView — position: fixed 铺满视口，
// 直接消费 store，无 props。在产品窗口即可看到完整形态。
