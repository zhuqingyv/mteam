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
  };
}
