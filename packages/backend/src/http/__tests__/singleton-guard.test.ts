// singleton-guard 单测。覆盖：
//   1) 无 pid 文件 → checkPidFile 放行
//   2) pid 文件存在但进程已死（stale） → 清理 + 放行
//   3) pid 文件存在且进程存活 → exit(1) + 错误信息含 pid 和端口
//   4) attachPortGuard 收到 EADDRINUSE → exit(1) + 错误信息含端口
//   5) writePidFile / removePidFile 基本文件操作
// 注入 exit/stderr/isAlive 避免真退进程。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPidFile,
  attachPortGuard,
  writePidFile,
  removePidFile,
} from '../singleton-guard.js';

class ExitCalled extends Error {
  constructor(public code: number) { super(`exit(${code})`); }
}

function mkHarness(overrides: { isAlive?: (pid: number) => boolean } = {}) {
  const stderrBuf: string[] = [];
  const exits: number[] = [];
  const exit = ((c: number): never => { exits.push(c); throw new ExitCalled(c); }) as (c: number) => never;
  const stderr = (m: string): void => { stderrBuf.push(m); };
  return {
    deps: { exit, stderr, ...overrides },
    stderrBuf,
    exits,
    getOutput: () => stderrBuf.join(''),
  };
}

describe('singleton-guard', () => {
  let pidPath: string;

  beforeEach(() => {
    pidPath = join(tmpdir(), `singleton-guard-${process.pid}-${Math.random().toString(36).slice(2)}.pid`);
  });

  afterEach(() => {
    try { fs.unlinkSync(pidPath); } catch { /* 忽略 */ }
  });

  describe('checkPidFile', () => {
    it('pid 文件不存在 → 放行不抛', () => {
      const h = mkHarness();
      expect(() => checkPidFile(58590, { pidPath, ...h.deps })).not.toThrow();
      expect(h.exits.length).toBe(0);
    });

    it('pid 文件存在但进程已死（stale） → 清理旧文件 + 放行', () => {
      fs.writeFileSync(pidPath, '999999', 'utf8');
      const h = mkHarness({ isAlive: () => false });
      expect(() => checkPidFile(58590, { pidPath, ...h.deps })).not.toThrow();
      expect(h.exits.length).toBe(0);
      expect(fs.existsSync(pidPath)).toBe(false);
    });

    it('pid 文件存在且进程存活 → exit(1) + 错误包含 pid 和端口', () => {
      fs.writeFileSync(pidPath, '12345', 'utf8');
      const h = mkHarness({ isAlive: () => true });
      expect(() => checkPidFile(58590, { pidPath, ...h.deps })).toThrow(ExitCalled);
      expect(h.exits).toEqual([1]);
      const out = h.getOutput();
      expect(out).toContain('FATAL');
      expect(out).toContain('port 58590');
      expect(out).toContain('pid=12345');
      expect(out).toContain('kill 12345');
      expect(out).toContain('V2_PORT=58591');
      // 存活情况下不能删 pid 文件（否则 next 启动会误判）。
      expect(fs.existsSync(pidPath)).toBe(true);
    });

    it('pid 文件内容非法 → 当作 stale 清理 + 放行', () => {
      fs.writeFileSync(pidPath, 'not-a-number', 'utf8');
      const h = mkHarness({ isAlive: () => true });
      expect(() => checkPidFile(58590, { pidPath, ...h.deps })).not.toThrow();
      expect(fs.existsSync(pidPath)).toBe(false);
    });
  });

  describe('attachPortGuard', () => {
    // 不用真占端口触发 EADDRINUSE（事件发射路径里调注入的 exit() 会被 EventEmitter 视为未处理异常）。
    // 直接手动 emit('error') 覆盖逻辑；端口占用路径已被同一回调覆盖。
    it('收到 EADDRINUSE → exit(1) + 错误包含端口', () => {
      const h = mkHarness();
      // 把 exit 改成非 throw 的记录型，避免 emit 里抛出导致未处理异常。
      const exits: number[] = [];
      const stderrBuf: string[] = [];
      const deps = {
        exit: ((c: number): never => { exits.push(c); return undefined as never; }) as (c: number) => never,
        stderr: (m: string) => { stderrBuf.push(m); },
      };
      const srv = http.createServer();
      attachPortGuard(srv, 58590, deps);
      const err: NodeJS.ErrnoException = new Error('listen EADDRINUSE');
      err.code = 'EADDRINUSE';
      srv.emit('error', err);
      expect(exits).toEqual([1]);
      const out = stderrBuf.join('');
      expect(out).toContain('FATAL');
      expect(out).toContain('port 58590');
      expect(out).toContain('already in use');
      expect(out).toContain('V2_PORT=58591');
    });

    it('其他 error code → 仍 exit(1) 并报清晰原因', () => {
      const exits: number[] = [];
      const stderrBuf: string[] = [];
      const deps = {
        exit: ((c: number): never => { exits.push(c); return undefined as never; }) as (c: number) => never,
        stderr: (m: string) => { stderrBuf.push(m); },
      };
      const srv = http.createServer();
      attachPortGuard(srv, 58590, deps);
      const err: NodeJS.ErrnoException = new Error('EACCES bind failed');
      err.code = 'EACCES';
      srv.emit('error', err);
      expect(exits).toEqual([1]);
      const out = stderrBuf.join('');
      expect(out).toContain('listen failed on port 58590');
      expect(out).toContain('EACCES bind failed');
    });
  });

  describe('writePidFile / removePidFile', () => {
    it('writePidFile 写入当前 pid，removePidFile 清理', () => {
      writePidFile(pidPath);
      expect(fs.existsSync(pidPath)).toBe(true);
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(String(process.pid));
      removePidFile(pidPath);
      expect(fs.existsSync(pidPath)).toBe(false);
    });

    it('removePidFile 对不存在文件不抛', () => {
      expect(() => removePidFile(pidPath)).not.toThrow();
    });
  });
});
