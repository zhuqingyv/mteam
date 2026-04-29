import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import Surface from '../src/atoms/Surface';
import StatusDot from '../src/atoms/StatusDot';
import Logo from '../src/atoms/Logo';
import AgentLogo from '../src/atoms/AgentLogo';
import Text from '../src/atoms/Text';
import Button from '../src/atoms/Button';
import Icon from '../src/atoms/Icon';
import TypingDots from '../src/atoms/TypingDots';
import MessageMeta from '../src/atoms/MessageMeta';
import TextBlock from '../src/atoms/TextBlock';
import ToolCallItem from '../src/atoms/ToolCallItem';
import NotificationCard from '../src/atoms/NotificationCard';
import VirtualList from '../src/atoms/VirtualList';
import Dropdown from '../src/atoms/Dropdown';
import Textarea from '../src/atoms/Textarea';
import Input from '../src/atoms/Input';
import Tag from '../src/atoms/Tag';
import Modal from '../src/atoms/Modal';
import ToolCallList from '../src/molecules/ToolCallList';
import NotificationStack from '../src/molecules/NotificationStack';
import Avatar from '../src/molecules/Avatar';
import AvatarPicker from '../src/molecules/AvatarPicker';
import FormField from '../src/molecules/FormField';
import ConfirmDialog from '../src/molecules/ConfirmDialog';
import TitleBlock from '../src/molecules/TitleBlock';
import MenuDots from '../src/molecules/MenuDots';
import MessageBubble from '../src/molecules/MessageBubble';
import MessageRow from '../src/molecules/MessageRow';
import ChatHeader from '../src/molecules/ChatHeader';
import ChatInput from '../src/molecules/ChatInput';
import AgentSwitcher from '../src/molecules/AgentSwitcher';
import ToolBar from '../src/molecules/ToolBar';
import TabFilter from '../src/molecules/TabFilter';
import StatsBar from '../src/molecules/StatsBar';
import DragHandle from '../src/molecules/DragHandle';
import MessageBadge from '../src/molecules/MessageBadge';
import TeamSidebarItem from '../src/atoms/TeamSidebarItem';
import TeamSidebar from '../src/molecules/TeamSidebar';
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
import TemplateList from '../src/organisms/TemplateList';
import WorkerCard from '../src/organisms/WorkerCard';
import WorkerListPanel from '../src/organisms/WorkerListPanel';
import CanvasNode from '../src/molecules/CanvasNode';
import { CanvasNodeExpanded } from '../src/molecules/CanvasNode';
import InstanceChatPanel from '../src/organisms/InstanceChatPanel';
import ChatList from '../src/molecules/ChatList';
import CanvasTopBar from '../src/molecules/CanvasTopBar';
import ZoomControl from '../src/molecules/ZoomControl';

export type PropType = 'string' | 'number' | 'boolean' | 'enum';

export interface PropDef {
  name: string;
  type: PropType;
  options?: string[];
  default: unknown;
  description: string;
}

export type Layer = 'atoms' | 'molecules' | 'organisms';

// Sub-groups within each layer. Keep values in sync with App.tsx ordering.
export type Group =
  // atoms
  | 'basic'
  | 'input'
  | 'display'
  | 'container'
  // molecules
  | 'form'
  | 'chat'
  | 'nav'
  | 'team'
  | 'display-mol'
  // organisms
  | 'full';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type ValuesUpdater = (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;

export interface ComponentEntry {
  name: string;
  layer: Layer;
  group: Group;
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
    group: 'basic',
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
    group: 'basic',
    component: StatusDot,
    props: [
      {
        name: 'status',
        type: 'enum',
        options: ['online', 'busy', 'offline', 'thinking', 'responding'],
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
    group: 'display',
    component: Logo,
    props: [
      { name: 'size', type: 'number', default: 56, description: '尺寸 px' },
      {
        name: 'status',
        type: 'enum',
        options: ['online', 'connecting', 'offline'],
        default: 'online',
        description: '三态：online 彩色 / connecting 灰+呼吸 / offline 灰度静态',
      },
    ],
    defaults: { size: 56, status: 'online' },
  },
  {
    name: 'AgentLogo',
    layer: 'atoms',
    group: 'display',
    component: AgentLogo,
    props: [
      {
        name: 'cliType',
        type: 'enum',
        options: [
          'claude', 'codex', 'openai', 'gemini', 'aider',
          'cursor', 'devin', 'replit', 'windsurf', 'amazon-q', 'copilot',
          'unknown',
        ],
        default: 'claude',
        description: 'CLI 类型；未知回落到 M logo',
      },
      { name: 'size', type: 'number', default: 32, description: '尺寸 px' },
      { name: 'grayscale', type: 'boolean', default: false, description: '灰度（offline 态）' },
    ],
    defaults: { cliType: 'claude', size: 32, grayscale: false },
    note: 'cliType 支持 claude/codex(→openai)/gemini/aider/cursor/devin/replit/windsurf/amazon-q/copilot；未命中回落到默认 M logo',
  },
  {
    name: 'Text',
    layer: 'atoms',
    group: 'basic',
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
    group: 'basic',
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
    handlers: () => ({ onClick: () => {} }),
  },
  {
    name: 'Icon',
    layer: 'atoms',
    group: 'basic',
    component: Icon,
    props: [
      {
        name: 'name',
        type: 'enum',
        options: ['close', 'send', 'stop', 'chevron', 'chevron-down', 'settings', 'plus', 'check', 'check-double', 'team'],
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
    group: 'display',
    component: TypingDots,
    props: [
      { name: 'color', type: 'string', default: 'rgba(230,237,247,0.8)', description: '点颜色' },
    ],
    defaults: { color: 'rgba(230,237,247,0.8)' },
  },
  {
    name: 'TextBlock',
    layer: 'atoms',
    group: 'display',
    component: TextBlock,
    props: [
      { name: 'content', type: 'string', default: '你好，我是团队 Agent', description: '文本内容' },
      { name: 'streaming', type: 'boolean', default: true, description: '流式（尾部光标）' },
    ],
    defaults: { content: '你好，我是团队 Agent', streaming: true },
    note: '流式输出时尾部闪烁光标',
  },
  {
    name: 'MessageMeta',
    layer: 'atoms',
    group: 'display',
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
    group: 'display',
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
    group: 'display',
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
    name: 'Dropdown',
    layer: 'atoms',
    group: 'input',
    component: Dropdown,
    props: [
      {
        name: 'value',
        type: 'enum',
        options: ['claude', 'codex'],
        default: 'claude',
        description: '当前选中项 value',
      },
    ],
    defaults: {
      value: 'claude',
      options: [
        { value: 'claude', label: 'Claude' },
        { value: 'codex', label: 'Codex' },
      ],
    },
    note: '发光玻璃胶囊触发器 + 下拉面板；点击外部关闭',
    handlers: (setValues) => ({
      onChange: (v: unknown) => setValues((p) => ({ ...p, value: v as string })),
    }),
  },
  {
    name: 'Textarea',
    layer: 'atoms',
    group: 'input',
    component: Textarea,
    props: [
      { name: 'placeholder', type: 'string', default: '请输入多行文本…', description: '占位符' },
      { name: 'disabled', type: 'boolean', default: false, description: '禁用' },
      { name: 'rows', type: 'number', default: 4, description: '初始行数' },
      { name: 'maxLength', type: 'number', default: 200, description: '最大字符数（显示计数）' },
    ],
    defaults: {
      value: '',
      placeholder: '请输入多行文本…',
      disabled: false,
      rows: 4,
      maxLength: 200,
    },
    note: '发光玻璃风格多行输入；maxLength 非空时右下角显示字数计数',
    handlers: (setValues) => ({
      onChange: (v: unknown) => setValues((p) => ({ ...p, value: v as string })),
    }),
  },
  {
    name: 'Input',
    layer: 'atoms',
    group: 'input',
    component: Input,
    props: [
      { name: 'value', type: 'string', default: '', description: '输入值' },
      { name: 'placeholder', type: 'string', default: '请输入…', description: '占位符' },
      {
        name: 'type',
        type: 'enum',
        options: ['text', 'password', 'email'],
        default: 'text',
        description: '输入类型',
      },
      { name: 'disabled', type: 'boolean', default: false, description: '禁用' },
      { name: 'error', type: 'boolean', default: false, description: '错误态（红色发光边框）' },
    ],
    defaults: { value: '', placeholder: '请输入…', type: 'text', disabled: false, error: false },
    note: '发光玻璃风格单行输入；受控组件，onChange 回传新值',
    handlers: (setValues) => ({
      onChange: (v: unknown) => setValues((p) => ({ ...p, value: v as string })),
    }),
  },
  {
    name: 'Tag',
    layer: 'atoms',
    group: 'input',
    component: Tag,
    props: [
      { name: 'label', type: 'string', default: 'filesystem', description: '标签文本' },
      {
        name: 'variant',
        type: 'enum',
        options: ['default', 'primary', 'danger'],
        default: 'default',
        description: '样式',
      },
      {
        name: 'size',
        type: 'enum',
        options: ['sm', 'md'],
        default: 'md',
        description: '尺寸',
      },
      { name: 'disabled', type: 'boolean', default: false, description: '禁用' },
      { name: 'closable', type: 'boolean', default: true, description: '可关闭（注入 onRemove）' },
    ],
    defaults: { label: 'filesystem', variant: 'default', size: 'md', disabled: false, closable: true },
    note: '胶囊发光玻璃；closable=true 时显示关闭按钮并触发 onRemove',
    handlers: (setValues) => ({
      onRemove: () => setValues((p) => ({ ...p, closable: !(p.closable as boolean) })),
    }),
  },
  {
    name: 'Modal',
    layer: 'atoms',
    group: 'container',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: Modal as any,
    props: [
      { name: 'open', type: 'boolean', default: false, description: '是否打开' },
      { name: 'title', type: 'string', default: '删除模板', description: '标题' },
      {
        name: 'size',
        type: 'enum',
        options: ['sm', 'md', 'lg'],
        default: 'md',
        description: '尺寸',
      },
      { name: 'closeOnBackdrop', type: 'boolean', default: true, description: '点外部关闭' },
      { name: 'closeOnEsc', type: 'boolean', default: true, description: 'ESC 关闭' },
    ],
    defaults: { open: false, title: '删除模板', size: 'md', closeOnBackdrop: true, closeOnEsc: true },
    renderChildren: () =>
      React.createElement(
        'div',
        { style: { color: 'rgba(230,237,247,0.8)', fontSize: 14, lineHeight: 1.6 } },
        '确定要删除 "frontend-engineer" 模板吗？此操作不可撤销。',
      ),
    note: '居中遮罩+发光玻璃面板；ESC/点外部关闭；打开时焦点陷入面板、关闭时还原',
    handlers: (setValues) => ({
      onClose: () => setValues((p) => ({ ...p, open: false })),
    }),
  },
  {
    name: 'VirtualList',
    layer: 'atoms',
    group: 'container',
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
      { name: 'overscan', type: 'number', default: 5, description: '上下额外渲染条数' },
    ],
    defaults: {
      itemEstimateHeight: 60,
      overscan: 5,
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
    group: 'chat',
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
    group: 'form',
    component: Avatar,
    props: [
      { name: 'size', type: 'number', default: 56, description: 'Logo 尺寸' },
      { name: 'online', type: 'boolean', default: true, description: '在线状态点' },
    ],
    defaults: { size: 56, online: true },
  },
  {
    name: 'AvatarPicker',
    layer: 'molecules',
    group: 'form',
    component: AvatarPicker,
    props: [
      { name: 'columns', type: 'number', default: 5, description: '网格列数' },
      { name: 'disabled', type: 'boolean', default: false, description: '禁用' },
      { name: 'loading', type: 'boolean', default: false, description: '加载中（骨架屏）' },
    ],
    defaults: {
      columns: 5,
      disabled: false,
      loading: false,
      value: 'avatar-03',
      avatars: Array.from({ length: 20 }, (_, i) => {
        const n = String(i + 1).padStart(2, '0');
        return { id: `avatar-${n}`, filename: `avatar-${n}.png`, builtin: true };
      }),
    },
    handlers: (setValues) => ({
      onChange: (...args: unknown[]) => {
        const id = args[0] as string;
        setValues((prev) => ({ ...prev, value: id }));
      },
      onRandom: () => {
        setValues((prev) => {
          const list = (prev.avatars as { id: string }[]) || [];
          if (list.length === 0) return prev;
          const pick = list[Math.floor(Math.random() * list.length)];
          return { ...prev, value: pick.id };
        });
      },
    }),
    note: '20 个内置头像 mock；onRandom 随机命中，onChange 切换选中',
  },
  {
    name: 'TitleBlock',
    layer: 'molecules',
    group: 'display-mol',
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
    group: 'nav',
    component: MenuDots,
    props: [
      { name: 'disabled', type: 'boolean', default: false, description: '禁用（按钮模式）' },
      { name: 'asDragHandle', type: 'boolean', default: false, description: '作为窗口拖动手柄（Electron -webkit-app-region: drag）' },
    ],
    defaults: { disabled: false, asDragHandle: false },
    handlers: () => ({ onClick: () => {} }),
  },
  {
    name: 'FormField',
    layer: 'molecules',
    group: 'form',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: FormField as any,
    props: [
      { name: 'label', type: 'string', default: '模板名称', description: '字段标签' },
      { name: 'required', type: 'boolean', default: true, description: '是否必填（标红 *）' },
      { name: 'error', type: 'string', default: '', description: '错误信息（非空时显示红字）' },
      { name: 'value', type: 'string', default: 'frontend-engineer', description: '内部 Input 示例值' },
    ],
    defaults: { label: '模板名称', required: true, error: '', value: 'frontend-engineer' },
    renderChildren: (p) =>
      React.createElement(Input, {
        value: (p.value as string) ?? '',
        placeholder: '请输入模板名称',
        error: Boolean(p.error),
        // onChange 由 handlers 接管
      }),
    handlers: (setValues) => ({
      onChange: (...args: unknown[]) => {
        const v = args[0] as string;
        setValues((prev) => ({ ...prev, value: v }));
      },
    }),
    note: 'label + required 星号 + 错误文案 + slot（演示包裹 Input）',
  },
  {
    name: 'ConfirmDialog',
    layer: 'molecules',
    group: 'form',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: ConfirmDialog as any,
    props: [
      { name: 'open', type: 'boolean', default: false, description: '是否打开' },
      { name: 'title', type: 'string', default: '删除模板', description: '弹窗标题' },
      {
        name: 'message',
        type: 'string',
        default: '确定要删除 "frontend-engineer" 模板吗？此操作不可撤销。',
        description: '提示内容',
      },
      { name: 'confirmLabel', type: 'string', default: '删除', description: '确认按钮文案' },
      { name: 'cancelLabel', type: 'string', default: '取消', description: '取消按钮文案' },
      {
        name: 'variant',
        type: 'enum',
        options: ['default', 'danger'],
        default: 'danger',
        description: '变体（danger 红色确认按钮）',
      },
    ],
    defaults: {
      open: false,
      title: '删除模板',
      message: '确定要删除 "frontend-engineer" 模板吗？此操作不可撤销。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      variant: 'danger',
    },
    handlers: (setValues) => ({
      onConfirm: () => setValues((p) => ({ ...p, open: false })),
      onCancel: () => setValues((p) => ({ ...p, open: false })),
    }),
    note: 'Modal + Button 组合；danger 变体为红色确认，default 为蓝色',
  },
  {
    name: 'MessageBubble',
    layer: 'molecules',
    group: 'chat',
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
    group: 'chat',
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
    group: 'chat',
    component: ChatHeader,
    props: [
      { name: 'name', type: 'string', default: 'M-TEAM', description: '团队名' },
      { name: 'online', type: 'boolean', default: true, description: '在线' },
    ],
    defaults: { name: 'M-TEAM', online: true },
    note: '展开态顶栏：Logo + 名称 + StatusDot + 右上 × 关闭按钮',
    handlers: () => ({ onClose: () => {} }),
  },
  {
    name: 'ChatInput',
    layer: 'molecules',
    group: 'chat',
    component: ChatInput,
    props: [
      { name: 'placeholder', type: 'string', default: '输入消息…', description: '占位符' },
      { name: 'value', type: 'string', default: '有什么我能帮你的？', description: '输入内容' },
      { name: 'streaming', type: 'boolean', default: false, description: '流式中 — 发送按钮变停止按钮' },
    ],
    defaults: { placeholder: '输入消息…', value: '有什么我能帮你的？', streaming: false },
    note: '可输入、Enter/点箭头发送（发送后清空）；streaming 时按钮变停止，点击触发 onStop',
    handlers: (setValues) => ({
      onSend: () => {
        setValues((prev) => ({ ...prev, value: '' }));
      },
      onStop: () => {},
    }),
  },
  {
    name: 'AgentSwitcher',
    layer: 'molecules',
    group: 'nav',
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
    note: 'agents 列表为 mock；onSelect 切换高亮 + 右侧 [+] 触发 onAdd',
    handlers: () => ({
      // onSelect 会走 CONTROLLED_PROP_BY_CALLBACK 自动更新 activeId
      onSelect: () => {},
      onAdd: () => {},
    }),
  },
  {
    name: 'ToolBar',
    layer: 'molecules',
    group: 'nav',
    component: ToolBar,
    props: [
      {
        name: 'currentModel',
        type: 'enum',
        options: ['claude', 'codex'],
        default: 'claude',
        description: '当前选中的模型 value',
      },
      {
        name: 'teamPanelActive',
        type: 'boolean',
        default: false,
        description: '成员面板按钮激活态（点击按钮可切换）',
      },
    ],
    defaults: {
      currentModel: 'claude',
      teamPanelActive: false,
      modelOptions: [
        { value: 'claude', label: 'Claude', icon: React.createElement(AgentLogo, { cliType: 'claude', size: 14 }) },
        { value: 'codex', label: 'Codex', icon: React.createElement(AgentLogo, { cliType: 'codex', size: 14 }) },
        { value: 'gemini', label: 'Gemini', icon: React.createElement(AgentLogo, { cliType: 'gemini', size: 14 }) },
      ],
    },
    note: 'ChatPanel footer 工具条：左侧模型下拉（选项带 AgentLogo 图标）+ 右侧 [👥 成员] [⚙ 设置]',
    handlers: (setValues) => ({
      onModelChange: (v: unknown) => setValues((p) => ({ ...p, currentModel: v as string })),
      onTeamPanel: () => setValues((p) => ({ ...p, teamPanelActive: !p.teamPanelActive })),
      onSettings: () => {},
    }),
  },
  {
    name: 'TabFilter',
    layer: 'molecules',
    group: 'nav',
    component: TabFilter,
    props: [
      {
        name: 'activeKey',
        type: 'enum',
        options: ['all', 'templates', 'online'],
        default: 'all',
        description: '当前激活 Tab 的 key',
      },
    ],
    defaults: {
      activeKey: 'all',
      tabs: [
        { key: 'all', label: '全部成员', icon: React.createElement(Icon, { name: 'team', size: 14 }) },
        { key: 'templates', label: '角色模板', icon: React.createElement(Icon, { name: 'settings', size: 14 }) },
        { key: 'online', label: '在线中', icon: React.createElement(StatusDot, { status: 'online', size: 'sm' }) },
      ],
    },
    note: '发光玻璃胶囊容器 + 三 Tab 横排；active 用 primary 蓝色、inactive 用 ghost；icon/count 可选',
    handlers: (setValues) => ({
      onChange: (key: unknown) => setValues((p) => ({ ...p, activeKey: key as string })),
    }),
  },
  {
    name: 'StatsBar',
    layer: 'molecules',
    group: 'display-mol',
    component: StatsBar,
    props: [
      {
        name: 'activeKey',
        type: 'enum',
        options: ['', 'total', 'online', 'idle', 'offline'],
        default: '',
        description: '当前高亮的 cell；空字符串等价于 null（无选中）',
      },
    ],
    defaults: {
      activeKey: '',
      stats: { total: 6, online: 4, idle: 2, offline: 0 },
    },
    handlers: (setValues) => ({
      onStatClick: (k: unknown) => {
        setValues((prev) => ({ ...prev, activeKey: prev.activeKey === k ? '' : (k as string) }));
      },
    }),
    note: '右上统计条：total 用 team 图标，online 绿 / idle 橙 / offline 灰；offline 缺省不渲染。传 onStatClick 后 cell 变 button，带 hover 上浮 + active 凹陷；activeKey 蓝框高亮。数据来自 WS get_workers.stats',
  },
  {
    name: 'DragHandle',
    layer: 'molecules',
    group: 'nav',
    component: DragHandle,
    props: [
      { name: 'visible', type: 'boolean', default: true, description: '显示' },
    ],
    defaults: { visible: true },
  },
  {
    name: 'MessageBadge',
    layer: 'molecules',
    group: 'nav',
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
    group: 'display-mol',
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
    group: 'full',
    component: CapsuleCard,
    props: [
      { name: 'name', type: 'string', default: 'M-TEAM', description: '团队名' },
      { name: 'agentCount', type: 'number', default: 3, description: 'Agent 数' },
      { name: 'taskCount', type: 'number', default: 2, description: 'Task 数' },
      { name: 'messageCount', type: 'number', default: 5, description: '消息数' },
      { name: 'online', type: 'boolean', default: true, description: '在线' },
      {
        name: 'logoStatus',
        type: 'enum',
        options: ['online', 'connecting', 'offline'],
        default: 'online',
        description: 'Logo 三态；未传则回落到 online 布尔',
      },
      { name: 'expanded', type: 'boolean', default: false, description: '展开态（仅静态展示，Electron 里由 useCapsuleToggle 驱动）' },
      { name: 'bodyVisible', type: 'boolean', default: false, description: '展开动画结束后 body 淡入' },
    ],
    defaults: { name: 'M-TEAM', agentCount: 3, taskCount: 2, messageCount: 5, online: true, logoStatus: 'online', expanded: false, bodyVisible: false },
    note: '收起态 Logo/名称/统计/背景点击均 toggle；右侧六点是拖动手柄（app-region:drag，仅 Electron 生效）。展开态 card__collapsed 不在 DOM',
    handlers: (setValues) => ({
      onToggle: () => setValues((p) => ({ ...p, expanded: !p.expanded, bodyVisible: !p.expanded })),
    }),
  },
  {
    name: 'ChatPanel',
    layer: 'organisms',
    group: 'full',
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
      agents: [],
      inputPlaceholder: '给 MTEAM 发送消息...',
      inputValue: '',
      toolBar: React.createElement(ToolBar, {
        modelOptions: [
          { value: 'claude', label: 'Claude', icon: React.createElement(AgentLogo, { cliType: 'claude', size: 14 }) },
          { value: 'codex', label: 'Codex', icon: React.createElement(AgentLogo, { cliType: 'codex', size: 14 }) },
        ],
        currentModel: 'claude',
        onModelChange: () => {},
      }),
    },
    note: '主 Agent 场景：agents=[] 抑制 AgentSwitcher，模型切换走 ToolBar 的 Dropdown；toolBar 插槽可自由定制。团队场景传入 agents[] 会顶部渲染 AgentSwitcher',
    handlers: (setValues) => ({
      onInputChange: (v: unknown) => setValues((p) => ({ ...p, inputValue: v as string })),
      onSend: () => setValues((p) => ({ ...p, inputValue: '' })),
    }),
  },
  {
    name: 'TeamSidebarItem',
    layer: 'atoms',
    group: 'display',
    component: TeamSidebarItem,
    props: [
      { name: 'name', type: 'string', default: 'Frontend', description: '团队名' },
      { name: 'memberCount', type: 'number', default: 3, description: '成员数' },
      { name: 'active', type: 'boolean', default: false, description: '激活态' },
      { name: 'collapsed', type: 'boolean', default: false, description: '收起（只图标）' },
    ],
    defaults: { name: 'Frontend', memberCount: 3, active: false, collapsed: false },
    handlers: () => ({ onClick: () => {} }),
  },
  {
    name: 'TeamSidebar',
    layer: 'molecules',
    group: 'team',
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
    note: 'teams 为 mock；点击 item 触发 onSelectTeam；底部 [+新建团队] 触发 onCreateTeam；hover item 出现 × 按钮触发 onDisbandTeam（业务侧需自行弹 confirm 再调后端）',
    handlers: (setValues) => ({
      onSelectTeam: (id: unknown) => setValues((p) => ({ ...p, activeTeamId: id as string })),
      onCreateTeam: () => {},
      onDisbandTeam: (id: unknown) => setValues((p) => {
        const next = (p.teams as Array<{ id: string }>).filter((t) => t.id !== id);
        const nextActive = p.activeTeamId === id ? (next[0]?.id ?? '') : p.activeTeamId;
        return { ...p, teams: next, activeTeamId: nextActive };
      }),
    }),
  },
  {
    name: 'TeamCanvas',
    layer: 'organisms',
    group: 'full',
    component: TeamCanvas,
    props: [],
    defaults: {
      agents: [
        { id: 'a1', name: 'Claude', status: 'thinking', cliType: 'claude', isLeader: true, x: 40, y: 40, taskCount: 2, unreadCount: 0, messageCount: 12 },
        { id: 'a2', name: 'Codex', status: 'responding', cliType: 'codex', isLeader: false, x: 240, y: 160, taskCount: 1, unreadCount: 3, messageCount: 7 },
        { id: 'a3', name: 'Aider', status: 'idle', cliType: 'aider', isLeader: false, x: 80, y: 280, taskCount: 0, unreadCount: 0, messageCount: 0 },
        { id: 'a4', name: 'Gemini', status: 'offline', cliType: 'gemini', isLeader: false, x: 440, y: 40, taskCount: 0, unreadCount: 0, messageCount: 0 },
      ],
    },
    note: 'S4-G1 切到 CanvasNode：画布可平移/缩放/双击重置；节点可拖拽；onAgentOpen 收起态点击展开；onTransformCommit 在 pan/zoom 结束时触发，用于持久化',
    handlers: () => ({ onAgentDragEnd: () => {}, onAgentOpen: () => {}, onTransformCommit: () => {} }),
  },
  {
    name: 'TeamMonitorPanel',
    layer: 'organisms',
    group: 'full',
    component: TeamMonitorPanel,
    props: [
      { name: 'activeTeamId', type: 'string', default: 'frontend', description: '激活 team id' },
      { name: 'collapsed', type: 'boolean', default: false, description: '收起为胶囊态' },
    ],
    defaults: {
      activeTeamId: 'frontend',
      collapsed: false,
      teams: [
        { id: 'frontend', name: 'Frontend', memberCount: 4 },
        { id: 'backend', name: 'Backend', memberCount: 3 },
        { id: 'devops', name: 'DevOps', memberCount: 2 },
      ],
      agents: [
        { id: 'a1', name: 'Claude', status: 'thinking', cliType: 'claude', isLeader: true, x: 40, y: 40, taskCount: 2, unreadCount: 0, messageCount: 8 },
        { id: 'a2', name: 'Codex', status: 'responding', cliType: 'codex', isLeader: false, x: 260, y: 160, taskCount: 1, unreadCount: 0, messageCount: 5 },
        { id: 'a3', name: 'Gemini', status: 'idle', cliType: 'gemini', isLeader: false, x: 100, y: 300, taskCount: 0, unreadCount: 0, messageCount: 0 },
      ],
    },
    note: '完整监控面板：侧边栏 + 画布；collapsed=true 显示胶囊态，点击胶囊/×触发 onToggleCollapsed',
    handlers: (setValues) => ({
      onToggleCollapsed: () => setValues((p) => ({ ...p, collapsed: !p.collapsed })),
      onSelectTeam: (id: unknown) => setValues((p) => ({ ...p, activeTeamId: id as string })),
      onCreateTeam: () => {},
      onAgentDragEnd: () => {},
      onAgentOpen: () => {},
      onCanvasTransformCommit: () => {},
    }),
  },
  {
    name: 'CliList',
    layer: 'molecules',
    group: 'team',
    component: CliList,
    props: [],
    defaults: {
      clis: [
        { name: 'claude', path: '/usr/local/bin/claude', available: true },
        { name: 'codex', path: '/usr/local/bin/codex', available: true },
        { name: 'gemini', path: '/usr/local/bin/gemini', available: true },
        { name: 'aider', path: '', available: false },
      ],
    },
    note: 'clis 为 mock；每行左侧 AgentLogo 按 name 映射，不可用态灰度；Refresh 点击触发 onRefresh',
    handlers: () => ({ onRefresh: () => {} }),
  },
  {
    name: 'PrimaryAgentSettings',
    layer: 'organisms',
    group: 'full',
    component: PrimaryAgentSettings,
    props: [
      { name: 'running', type: 'boolean', default: false, description: '总控是否运行中（驱动状态点+文案）' },
    ],
    defaults: {
      running: false,
      config: {
        id: 'pa-1',
        name: 'Primary Agent',
        cliType: 'claude',
        systemPrompt: '',
        mcpConfig: [],
        status: 'STOPPED',
        createdAt: '2026-04-26T00:00:00Z',
        updatedAt: '2026-04-26T00:00:00Z',
      },
    },
    note: '只读摘要：标题 + 状态点 + Name/CLI。Start/Stop 等交互由 SettingsPage 外层托管，不在本组件内',
  },
  {
    name: 'NotificationCenter',
    layer: 'organisms',
    group: 'full',
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
    group: 'team',
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
    group: 'full',
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
    handlers: () => ({
      onActivate: () => {},
      onRequestOffline: () => {},
      onDelete: () => {},
    }),
  },
  {
    name: 'TemplateEditor',
    layer: 'organisms',
    group: 'full',
    component: TemplateEditor,
    props: [
      { name: 'isEdit', type: 'boolean', default: false, description: '编辑模式（name 只读）' },
    ],
    defaults: {
      isEdit: false,
      template: {
        name: 'frontend-engineer',
        role: 'engineer',
        description: 'Frontend developer focused on React/TypeScript',
        persona: '负责前端开发与 UI 实现。',
        avatar: 'avatar-03',
        availableMcps: ['filesystem', 'git'],
      },
      mcpOptions: ['filesystem', 'git', 'github', 'browser', 'shell'],
      existingNames: ['frontend-engineer', 'qa-engineer', 'reviewer'],
      avatars: Array.from({ length: 20 }, (_, i) => {
        const n = String(i + 1).padStart(2, '0');
        return { id: `avatar-${n}`, filename: `avatar-${n}.png`, builtin: true };
      }),
    },
    handlers: (setValues) => ({
      onRandomAvatar: () => setValues((prev) => {
        const list = (prev.avatars as { id: string }[]) || [];
        if (list.length === 0) return prev;
        const pick = list[Math.floor(Math.random() * list.length)];
        const tpl = (prev.template as Record<string, unknown>) || {};
        return { ...prev, template: { ...tpl, avatar: pick.id } };
      }),
      onSave: () => {},
      onCancel: () => {},
    }),
    note: 'FormField/Input/Textarea/Tag/AvatarPicker 组合；isEdit=true 时名称只读；existingNames 用于查重',
  },
  {
    name: 'TemplateList',
    layer: 'organisms',
    group: 'full',
    component: TemplateList,
    props: [
      { name: 'loading', type: 'boolean', default: false, description: '加载态（骨架屏）' },
    ],
    defaults: {
      loading: false,
      templates: [
        {
          name: 'frontend-engineer',
          role: 'engineer',
          description: 'Frontend developer focused on React/TypeScript, responsive design and accessibility.',
          persona: 'You are a skilled frontend engineer...',
          avatar: 'avatar-03',
          availableMcps: [
            { name: 'mteam', surface: ['send_msg'], search: '*' },
            { name: 'filesystem', surface: '*', search: '*' },
            { name: 'git', surface: '*', search: '*' },
            { name: 'github', surface: '*', search: '*' },
          ],
          createdAt: '2026-04-26T10:00:00Z',
          updatedAt: '2026-04-27T10:30:00Z',
        },
        {
          name: 'qa-reviewer',
          role: 'qa',
          description: 'Careful code reviewer. Ensures test coverage and regression safety.',
          persona: 'You review PRs...',
          avatar: 'avatar-07',
          availableMcps: [
            { name: 'mteam', surface: ['send_msg', 'read_message'], search: '*' },
            { name: 'filesystem', surface: '*', search: '*' },
          ],
          createdAt: '2026-04-26T11:00:00Z',
          updatedAt: '2026-04-27T09:00:00Z',
        },
        {
          name: 'pm-lead',
          role: 'manager',
          description: '项目经理，负责任务拆解与进度跟踪。',
          persona: null,
          avatar: 'avatar-12',
          availableMcps: [{ name: 'mteam', surface: '*', search: '*' }],
          createdAt: '2026-04-27T08:00:00Z',
          updatedAt: '2026-04-27T08:00:00Z',
        },
        {
          name: '文案写手',
          role: 'writer',
          description: '无 avatar 的模板，展示首字母兜底。',
          persona: null,
          avatar: null,
          availableMcps: [],
          createdAt: '2026-04-27T09:00:00Z',
          updatedAt: '2026-04-27T09:00:00Z',
        },
      ],
    },
    note: '卡片网格；点击卡片 → onSelect；编辑/删除按钮；顶部 [新建模板]；空态与 loading 骨架屏',
    handlers: () => ({
      onSelect: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onCreate: () => {},
    }),
  },
  {
    name: 'WorkerCard',
    layer: 'organisms',
    group: 'full',
    component: WorkerCard,
    props: [
      {
        name: 'status',
        type: 'enum',
        options: ['online', 'idle', 'offline'],
        default: 'online',
        description: '员工在线状态（由实例聚合）',
      },
      { name: 'instanceCount', type: 'number', default: 2, description: '该员工当前实例数' },
    ],
    defaults: {
      name: 'frontend-dev',
      role: '前端开发专家',
      description: '负责 React/TypeScript 组件开发、页面对接、响应式布局与可访问性优化。沟通务实、讲究细节。',
      avatar: 'avatar-03',
      status: 'online',
      mcps: ['mteam', 'mnemo', 'filesystem', 'git', 'github'],
      instanceCount: 2,
      lastActivity: {
        summary: '和 Leader 协作完成登录页样式',
        ts: '2026-04-27T10:32:15.420Z',
      },
      teams: ['官网重构', '移动端适配'],
    },
    note: '员工卡片：头像+名称+状态胶囊；描述 3 行截断；MCP Tag（最多 3 个，超出 +N）；底部最近协作 + 💬 + ⋯',
    handlers: () => ({
      onChat: () => {},
      onViewMore: () => {},
    }),
  },
  {
    name: 'WorkerListPanel',
    layer: 'organisms',
    group: 'full',
    component: WorkerListPanel,
    props: [
      {
        name: 'tab',
        type: 'enum',
        options: ['all', 'template', 'online'],
        default: 'all',
        description: '筛选 Tab（all / template / online）',
      },
      { name: 'searchQuery', type: 'string', default: '', description: '搜索词（本地过滤 name/role/description/mcps）' },
      { name: 'loading', type: 'boolean', default: false, description: '加载态（无数据时显示）' },
    ],
    defaults: {
      tab: 'all',
      searchQuery: '',
      loading: false,
      stats: { total: 3, online: 2, idle: 1, offline: 1 },
      workers: [
        {
          name: 'frontend-dev',
          role: '前端开发专家',
          description: '负责 React/TypeScript 组件开发、页面对接、响应式布局。',
          persona: '务实、注重细节',
          avatar: 'avatar-03',
          mcps: ['mteam', 'mnemo', 'filesystem'],
          status: 'online',
          instanceCount: 2,
          teams: ['官网重构'],
          lastActivity: { summary: '协作完成登录页样式', at: '2026-04-27T10:32:15.420Z' },
        },
        {
          name: 'backend-dev',
          role: '后端开发专家',
          description: '负责 API 设计、数据建模、性能优化。',
          persona: '',
          avatar: 'avatar-05',
          mcps: ['mteam', 'mnemo', 'github'],
          status: 'online',
          instanceCount: 1,
          teams: ['官网重构'],
          lastActivity: { summary: '完成订单接口压测', at: '2026-04-27T09:18:04.100Z' },
        },
        {
          name: 'qa-engineer',
          role: '质量工程师',
          description: '自动化测试、回归验证、发布质量守门人。',
          persona: '',
          avatar: 'avatar-08',
          mcps: ['mteam'],
          status: 'idle',
          instanceCount: 1,
          teams: [],
          lastActivity: null,
        },
      ],
    },
    note: '员工大列表：TabFilter + StatsBar + WorkerCard 网格；本地搜索/筛选；空态/加载态',
    handlers: (setValues) => ({
      onTabChange: (next: unknown) => setValues((prev) => ({ ...prev, tab: next })),
      onChat: () => {},
      onViewMore: () => {},
    }),
  },
  {
    name: 'TurnRendering',
    layer: 'molecules',
    group: 'chat',
    component: MessageRow,
    props: [
      { name: 'streaming', type: 'boolean', default: true, description: '流式输出（文本尾部光标）' },
    ],
    defaults: {
      role: 'agent',
      content: '',
      time: '21:00',
      agentName: 'Claude',
      streaming: true,
      blocks: [
        { type: 'thinking', blockId: 'b1' },
        { type: 'text', blockId: 'b2', content: '我来分析一下这个文件...' },
        {
          type: 'tool_call',
          blockId: 'b3',
          title: 'mcp__mteam-primary__create_leader',
          status: 'completed',
          input: { display: 'mcp__mteam-primary__create_leader' },
          output: { display: '成功创建 Leader 实例' },
          startTs: '2026-04-27T11:56:33.863Z',
          updatedTs: '2026-04-27T11:56:34.687Z',
        },
        {
          type: 'tool_call',
          blockId: 'b4',
          title: 'read_file',
          status: 'failed',
          input: { display: 'read_file' },
          output: { display: 'Error: file not found' },
          startTs: '2026-04-27T11:56:35.100Z',
          updatedTs: '2026-04-27T11:56:35.420Z',
        },
        { type: 'text', blockId: 'b5', content: '文件分析完毕，共 42 行代码。' },
      ],
    },
    note: 'Turn 块渲染 demo：thinking→text→tool_call→tool_result→text',
  },
  {
    name: 'CanvasNode',
    layer: 'molecules',
    group: 'team',
    component: CanvasNode,
    props: [
      { name: 'name', type: 'string', default: 'Claude', description: '节点名' },
      {
        name: 'status',
        type: 'enum',
        options: ['idle', 'thinking', 'responding', 'offline'],
        default: 'thinking',
        description: '四态状态色：idle 绿 / thinking 黄 / responding 蓝 / offline 灰',
      },
      {
        name: 'cliType',
        type: 'enum',
        options: ['claude', 'codex', 'gemini', 'aider', 'cursor', 'copilot', 'unknown'],
        default: 'claude',
        description: 'CLI 类型（驱动 AgentLogo）',
      },
      { name: 'avatar', type: 'string', default: '', description: '成员头像图片 URL（空值用首字母兜底）' },
      { name: 'isLeader', type: 'boolean', default: false, description: '是否 leader（加粗/描边）' },
      { name: 'taskCount', type: 'number', default: 2, description: '任务数徽章' },
      { name: 'unreadCount', type: 'number', default: 3, description: '未读计数（红点）' },
      { name: 'messageCount', type: 'number', default: 12, description: '消息总数' },
      { name: 'x', type: 'number', default: 20, description: 'X 位置' },
      { name: 'y', type: 'number', default: 20, description: 'Y 位置' },
    ],
    defaults: {
      id: 'node-1',
      name: 'Claude',
      status: 'thinking',
      cliType: 'claude',
      avatar: '',
      isLeader: false,
      taskCount: 2,
      unreadCount: 3,
      messageCount: 12,
      x: 20,
      y: 20,
    },
    note: '收起态画布节点：大圆 avatar（空值首字母兜底）+ 右下 AgentLogo badge；status 四态可切换；unreadCount>0 显示红点；位移>3px 触发 onDragEnd，未越阈值视为点击 onOpen',
    handlers: () => ({ onOpen: () => {}, onDragEnd: () => {} }),
  },
  {
    name: 'CanvasNodeExpanded',
    layer: 'molecules',
    group: 'team',
    component: CanvasNodeExpanded,
    props: [
      { name: 'name', type: 'string', default: 'Claude', description: '节点名' },
      {
        name: 'status',
        type: 'enum',
        options: ['idle', 'thinking', 'responding', 'offline'],
        default: 'responding',
        description: '四态状态色',
      },
    ],
    defaults: { id: 'node-1', name: 'Claude', status: 'responding', x: 20, y: 20 },
    renderChildren: () =>
      React.createElement(
        'div',
        { style: { padding: '20px 24px', color: 'rgba(230,237,247,0.8)', fontSize: 13, lineHeight: 1.6 } },
        '展开态主区 children 插槽：S4-G2a 会装入 ChatList + InstanceChatPanelConnected。',
      ),
    note: '画布内原地展开态 400×500：顶栏 Avatar + name + StatusDot + 最小化/关闭；顶栏拖拽更新 viewport 内 x/y 坐标；主区是 children 插槽',
    handlers: () => ({ onMinimize: () => {}, onClose: () => {}, onDragEnd: () => {} }),
  },
  {
    name: 'InstanceChatPanel',
    layer: 'organisms',
    group: 'full',
    component: InstanceChatPanel,
    props: [
      { name: 'instanceId', type: 'string', default: 'inst-claude-1', description: '实例 ID' },
      { name: 'peerId', type: 'string', default: 'user', description: '对端 ID（user / leader-id / member-id）' },
      { name: 'peerName', type: 'string', default: '我', description: '对端名称（placeholder 用）' },
      { name: 'streaming', type: 'boolean', default: false, description: '流式中 — 发送按钮变停止按钮' },
      { name: 'inputValue', type: 'string', default: '', description: '输入内容' },
      { name: 'emptyHint', type: 'string', default: '', description: '空列表提示（messages.length===0 时显示）' },
      { name: 'disabled', type: 'boolean', default: false, description: '禁用输入（peer 不支持发送时用）' },
    ],
    defaults: {
      instanceId: 'inst-claude-1',
      peerId: 'user',
      peerName: '我',
      streaming: false,
      inputValue: '',
      emptyHint: '',
      disabled: false,
      messages: [
        { id: 'm1', role: 'agent', agentName: 'Claude', content: '你好，我是 Claude，当前实例 inst-claude-1。', time: '20:48' },
        { id: 'm2', role: 'user', content: '帮我分析一下登录流程', time: '20:49', read: true },
        {
          id: 'm3',
          role: 'agent',
          agentName: 'Claude',
          content: '好的，我先读一下相关文件：',
          time: '20:49',
          toolCalls: [
            { id: 't1', toolName: 'read_file', status: 'done', summary: '读取 auth.ts', duration: '0.2s' },
            { id: 't2', toolName: 'grep', status: 'running', summary: '搜索 login 调用点' },
          ],
        },
      ],
    },
    note: 'instanceId + peerId 双维度驱动；内部复用 ChatPanel（agents=[] 抑制切换器）；数据 props 驱动不读 store；disabled 态禁输入；messages 空 + emptyHint 非空时显示提示',
    handlers: (setValues) => ({
      onInputChange: (v: unknown) => setValues((p) => ({ ...p, inputValue: v as string })),
      onSend: () => setValues((p) => ({ ...p, inputValue: '' })),
      onStop: () => {},
    }),
  },
  {
    name: 'ChatList',
    layer: 'molecules',
    group: 'chat',
    component: ChatList,
    props: [
      { name: 'activeId', type: 'string', default: 'user', description: '当前激活的 peer id' },
      { name: 'collapsed', type: 'boolean', default: false, description: '收起态（仅头像列）' },
      { name: 'emptyHint', type: 'string', default: 'No chats yet', description: '空态提示' },
    ],
    defaults: {
      activeId: 'user',
      collapsed: false,
      emptyHint: 'No chats yet',
      items: [
        { id: 'user', name: '我', role: 'user', lastMessage: '帮我分析登录流程', lastTime: '20:49', unread: 0 },
        { id: 'leader-1', name: 'Leader', role: 'leader', lastMessage: '已安排给 claude-frontend', lastTime: '20:45', unread: 2 },
        { id: 'member-1', name: 'Codex', role: 'member', lastMessage: '后端接口已完成', lastTime: '20:30', unread: 0 },
        { id: 'member-2', name: 'Gemini', role: 'member', lastMessage: '', lastTime: '', unread: 99 },
        { id: 'member-3', name: 'Aider', role: 'member', lastMessage: '等待任务分配', lastTime: '19:58' },
      ],
    },
    note: 'ChatList + ChatListItem：头像（首字母兜底）+ 名称 + lastMessage（省略）+ lastTime + unread badge；activeId 高亮；role=leader 头像带绿点；支持 overflow-y 内部滚动',
    handlers: () => ({
      // onSelect 走 CONTROLLED_PROP_BY_CALLBACK 自动更新 activeId
      onSelect: () => {},
    }),
  },
  {
    name: 'CanvasTopBar',
    layer: 'molecules',
    group: 'team',
    component: CanvasTopBar,
    props: [
      { name: 'teamName', type: 'string', default: 'Frontend', description: '团队名' },
      { name: 'memberCount', type: 'number', default: 4, description: '成员数' },
      { name: 'zoomPercent', type: 'number', default: 100, description: '缩放百分比（0-300，自动 clamp）' },
    ],
    defaults: { teamName: 'Frontend', memberCount: 4, zoomPercent: 100 },
    note: '画布顶栏：左 {teamName} · {memberCount} 成员；右 [zoom%] [适应画布] [+ 新成员] [齿轮] [关闭]；所有按钮走 atoms/Button + Icon',
    handlers: () => ({
      onZoomMenu: () => {},
      onFit: () => {},
      onNewMember: () => {},
      onSettings: () => {},
      onClose: () => {},
    }),
  },
  {
    name: 'ZoomControl',
    layer: 'molecules',
    group: 'team',
    component: ZoomControl,
    props: [
      { name: 'zoom', type: 'number', default: 1, description: '缩放比例（1=100%）' },
    ],
    defaults: { zoom: 1 },
    note: '[-] [zoom%] [+] 三按钮；双击中间百分比触发 onReset；绝对定位由 parent 决定',
    handlers: (setValues) => ({
      onZoomIn: () => setValues((p) => ({ ...p, zoom: Math.min(3, ((p.zoom as number) || 1) + 0.1) })),
      onZoomOut: () => setValues((p) => ({ ...p, zoom: Math.max(0.25, ((p.zoom as number) || 1) - 0.1) })),
      onReset: () => setValues((p) => ({ ...p, zoom: 1 })),
    }),
  },
];

// 页面级组件（不在 Playground 展示）：ExpandedView — position: fixed 铺满视口，
// 直接消费 store，无 props。在产品窗口即可看到完整形态。
