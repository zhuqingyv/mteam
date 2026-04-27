// Phase 4 C-2.1 · ActionItem 类型定义（权威来源：docs/phase4/INTERFACE-CONTRACTS.md）。
// 纯类型文件，零业务依赖；仅供 repo / service / HTTP / WS subscriber 导入。
export type ActionItemKind = 'task' | 'approval' | 'decision' | 'authorization';

export type ActionItemStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'rejected'
  | 'timeout'
  | 'cancelled';

// 比 comm/envelope.ts 的 ActorRef 更窄：action-item 只关心 kind + id。
export interface ActorId {
  kind: 'user' | 'agent' | 'system';
  id: string;
}

export interface ActionItem {
  id: string;
  kind: ActionItemKind;
  title: string;
  description: string;
  creator: ActorId;
  assignee: ActorId;
  deadline: number;
  status: ActionItemStatus;
  createdAt: number;
  updatedAt: number;
  remindedAt: number | null;
  resolution: string | null;
  teamId: string | null;
  relatedMessageId: string | null;
}

// DAO 返回类型别名，与 ActionItem 完全等价。repo 函数签名用它突出"DB row"语义。
export type ActionItemRow = ActionItem;

// create() 输入：服务端注入时间戳 / 初始状态；id 可选（缺省 DAO 生成 UUID v4）。
export interface CreateActionItemInput {
  id?: string;
  kind: ActionItemKind;
  title: string;
  description?: string;
  creator: ActorId;
  assignee: ActorId;
  deadline: number;
  teamId?: string | null;
  relatedMessageId?: string | null;
}
