// Vite 客户端类型：让 import.meta.env 拥有类型。
/// <reference types="vite/client" />

// 自定义环境变量类型声明
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  electronAPI?: {
    resize: (w: number, h: number, anchor?: string, animate?: boolean) => void;
    startResize: (direction: string) => void;
    openTeamPanel: () => void;
    openSettings: () => void;
    openRoleList: () => void;
    startDrag: (screenX: number, screenY: number) => void;
    dragMove: (screenX: number, screenY: number) => void;
    onDragStart?: (cb: () => void) => () => void;
    onDragEnd?: (cb: () => void) => () => void;
  };
  // dev-only：E2E 测试挂载用，import.meta.env.DEV 门控
  __messageStore?: typeof import('./store/messageStore').useMessageStore;
  __teamStore?: typeof import('./store/teamStore').useTeamStore;
  __agentStore?: typeof import('./store/agentStore').useAgentStore;
  __primaryAgentStore?: typeof import('./store/primaryAgentStore').usePrimaryAgentStore;
}
