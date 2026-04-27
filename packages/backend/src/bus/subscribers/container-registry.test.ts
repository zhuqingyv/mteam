import { describe, it, expect, spyOn } from 'bun:test';
import type { ProcessRuntime, RuntimeHandle, LaunchSpec } from '../../process-runtime/types.js';
import {
  createContainerRegistry,
  type ContainerEntry,
} from './container-registry.js';

function fakeHandle(pid: number | string = 1): RuntimeHandle {
  return {
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    pid,
    async kill(): Promise<void> {},
    onExit(): void {},
  };
}

function fakeRuntime(): ProcessRuntime {
  return {
    async spawn(_spec: LaunchSpec): Promise<RuntimeHandle> {
      return fakeHandle();
    },
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async destroy(): Promise<void> {},
  };
}

function entry(kind: 'host' | 'docker' = 'host', pid: number | string = 1): ContainerEntry {
  return { handle: fakeHandle(pid), runtime: fakeRuntime(), runtimeKind: kind };
}

describe('container-registry', () => {
  it('register + get round-trip', () => {
    const r = createContainerRegistry();
    const e = entry('host', 42);
    r.register('a1', e);
    expect(r.get('a1')).toBe(e);
  });

  it('get returns null for unknown agentId', () => {
    const r = createContainerRegistry();
    expect(r.get('missing')).toBeNull();
  });

  it('remove clears the entry', () => {
    const r = createContainerRegistry();
    r.register('a1', entry());
    r.remove('a1');
    expect(r.get('a1')).toBeNull();
  });

  it('duplicate register overwrites and warns', () => {
    const r = createContainerRegistry();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const e1 = entry('host', 1);
      const e2 = entry('docker', 2);
      r.register('a1', e1);
      r.register('a1', e2);
      expect(r.get('a1')).toBe(e2);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('a1');
    } finally {
      warn.mockRestore();
    }
  });

  it('list snapshot is not affected by later mutation', () => {
    const r = createContainerRegistry();
    r.register('a1', entry());
    r.register('a2', entry());
    const snap = r.list();
    expect(snap.length).toBe(2);
    r.remove('a1');
    r.register('a3', entry());
    expect(snap.length).toBe(2);
    expect(snap.map((x) => x.agentId).sort()).toEqual(['a1', 'a2']);
  });

  it('size reflects current map', () => {
    const r = createContainerRegistry();
    expect(r.size()).toBe(0);
    r.register('a1', entry());
    r.register('a2', entry());
    expect(r.size()).toBe(2);
    r.remove('a1');
    expect(r.size()).toBe(1);
  });

  it('clear empties the map', () => {
    const r = createContainerRegistry();
    r.register('a1', entry());
    r.register('a2', entry());
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.get('a1')).toBeNull();
    expect(r.list()).toEqual([]);
  });

  it('different agentIds are isolated', () => {
    const r = createContainerRegistry();
    const e1 = entry('host', 'pid-1');
    const e2 = entry('docker', 'container-xyz');
    r.register('a1', e1);
    r.register('a2', e2);
    expect(r.get('a1')).toBe(e1);
    expect(r.get('a2')).toBe(e2);
    expect(r.get('a1')?.runtimeKind).toBe('host');
    expect(r.get('a2')?.runtimeKind).toBe('docker');
  });
});
