// MemoryManager 进程级单例。import 本模块不起 ticker（lazy）。
export * from './manager.js';
export * from './collection-adapters.js';
import { MemoryManager } from './manager.js';

export const memoryManager: MemoryManager = new MemoryManager();
