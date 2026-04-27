// FakeRuntime —— Stage 5 container.subscriber / bootSubscribers 的测试替身。
// 绕开 dockerode 依赖并允许测试主动触发 onExit。不放 `*.test.ts` 同目录是
// 因为 M8 也要复用（stage-5 TASK-LIST M6 + M8）。
import type {
  LaunchSpec,
  ProcessRuntime,
  RuntimeHandle,
} from '../../../process-runtime/types.js';

export interface FakeHandle extends RuntimeHandle {
  /** 测试侧主动触发进程退出。重复触发无副作用。 */
  emitExit(code: number | null, signal?: string | null): void;
  killed: boolean;
}

export function createFakeHandle(pid: number | string = 1): FakeHandle {
  let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  let exited = false;
  const handle: FakeHandle = {
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    pid,
    killed: false,
    async kill(): Promise<void> {
      handle.killed = true;
      if (!exited) {
        exited = true;
        exitCb?.(null, 'SIGTERM');
      }
    },
    onExit(cb): void {
      if (exitCb) throw new Error('onExit already registered');
      exitCb = cb;
    },
    emitExit(code, signal = null): void {
      if (exited) return;
      exited = true;
      exitCb?.(code, signal);
    },
  };
  return handle;
}

export interface FakeRuntime extends ProcessRuntime {
  readonly handles: FakeHandle[];
  readonly specs: LaunchSpec[];
  /** 注入下一次 spawn 的异常（消费一次）。 */
  failNextSpawn(err: Error): void;
}

export function createFakeRuntime(pidSeq: Array<number | string> = []): FakeRuntime {
  const handles: FakeHandle[] = [];
  const specs: LaunchSpec[] = [];
  let failErr: Error | null = null;
  let seqIdx = 0;
  const rt: FakeRuntime = {
    handles,
    specs,
    failNextSpawn(err): void { failErr = err; },
    async spawn(spec): Promise<RuntimeHandle> {
      specs.push(spec);
      if (failErr) { const e = failErr; failErr = null; throw e; }
      const pid = pidSeq[seqIdx++] ?? 1000 + handles.length;
      const h = createFakeHandle(pid);
      handles.push(h);
      return h;
    },
    async isAvailable(): Promise<boolean> { return true; },
    async destroy(): Promise<void> {},
  };
  return rt;
}
