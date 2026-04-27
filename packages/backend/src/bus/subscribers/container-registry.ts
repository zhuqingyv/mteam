// agentId → { handle, runtime } 的内存映射。
// 纯数据结构，不订阅任何 bus 事件，不 import bus/db。
// 契约见 docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md §1/§2。
import type { ProcessRuntime, RuntimeHandle } from '../../process-runtime/types.js';

export interface ContainerEntry {
  handle: RuntimeHandle;
  runtime: ProcessRuntime;
  runtimeKind: 'host' | 'docker';
}

export interface ContainerRegistry {
  register(agentId: string, entry: ContainerEntry): void;
  get(agentId: string): ContainerEntry | null;
  remove(agentId: string): void;
  list(): ReadonlyArray<{ agentId: string; entry: ContainerEntry }>;
  size(): number;
  clear(): void;
}

export function createContainerRegistry(): ContainerRegistry {
  const map = new Map<string, ContainerEntry>();

  return {
    register(agentId, entry) {
      if (map.has(agentId)) {
        console.warn(
          `[container-registry] duplicate register for agentId=${agentId}; overwriting`,
        );
      }
      map.set(agentId, entry);
    },
    get(agentId) {
      return map.get(agentId) ?? null;
    },
    remove(agentId) {
      map.delete(agentId);
    },
    list() {
      return Array.from(map.entries(), ([agentId, entry]) => ({ agentId, entry }));
    },
    size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}
