// 统一设置注册表核心类型。纯数据结构，不依赖任何业务模块。

export interface SettingEntry {
  key: string;
  label: string;
  description: string;
  category: string;
  schema: Record<string, unknown>;
  readonly: boolean;
  notify: 'none' | 'primary' | 'related-agents';
  getter: () => unknown;
  setter: (value: unknown) => void;
  keywords?: readonly string[];
}

export interface SearchResult {
  key: string;
  label: string;
  description: string;
  category: string;
  schema: Record<string, unknown>;
  readonly: boolean;
  currentValue: unknown;
}
