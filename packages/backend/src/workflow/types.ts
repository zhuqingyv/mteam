// Phase 5 · 工作流模板类型 — 纯类型，零依赖。
// roles: 团队成员编排；taskChain: 线性任务链（on_complete 触发下一步）。
// 详见 docs/phase5/workflow-templates-design.md §3。

export interface WorkflowRole {
  templateName: string;
  isLeader: boolean;
  task?: string;
}

export interface TaskChainStep {
  from: string;
  to: string;
  trigger: 'on_complete';
  task: string;
}

export interface WorkflowTemplate {
  name: string;
  label: string;
  description: string | null;
  icon: string | null;
  roles: WorkflowRole[];
  taskChain: TaskChainStep[];
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowInput {
  name: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  roles: WorkflowRole[];
  taskChain?: TaskChainStep[];
  builtin?: boolean;
}
