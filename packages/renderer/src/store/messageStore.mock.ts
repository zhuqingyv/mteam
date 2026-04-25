import type { Message } from './messageStore';

export const INITIAL_MESSAGES: Message[] = [
  { id: 'm1', role: 'agent', agentName: 'Claude', content: '你好！我是 MTEAM，你的智能开发助手。有什么可以帮你的吗？😊', time: '20:48' },
  { id: 'm2', role: 'user', content: '帮我总结一下当前 Agent 的状态', time: '20:48', read: true },
  {
    id: 'm3', role: 'agent', agentName: 'Claude', time: '20:49',
    content: '好的，当前 3 个 Agent 均在线：\n• claude-code：空闲\n• codex-agent：运行中（任务：修复 UI Bug）\n• qwen-dev：空闲',
    toolCalls: [{ id: 't1', toolName: 'read_file', status: 'done', summary: '读取 agent-status.json', duration: '0.3s' }],
  },
  { id: 'm4', role: 'user', content: '帮我优化 MTEAM 窗口的 UI 设计', time: '20:50', read: true },
  { id: 'm5', role: 'agent', agentName: 'Claude', content: '已优化完成！采用玻璃拟态与柔和光效，提升了层次感和可读性。需要我把设计稿生成给你吗？', time: '20:51' },
  { id: 'm6', role: 'user', content: '用 Claude 模型继续完善细节', time: '20:51', read: true },
  { id: 'm7', role: 'agent', agentName: 'Claude', content: '已切换到 Claude 模型，将继续完善细节优化。', time: '20:51' },
];
