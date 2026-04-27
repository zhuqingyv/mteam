// isLaunchSpec 守卫测试。覆盖 REGRESSION.md §1.1 A1~A16。

import { describe, it, expect } from 'bun:test';
import { isLaunchSpec } from '../types.js';

const validSpec = () => ({
  runtime: 'host' as const,
  command: 'node',
  args: ['-e', 'process.exit(0)'],
  env: { FOO: 'bar' },
  cwd: '/tmp',
});

describe('isLaunchSpec', () => {
  it('A1: 完整合法 LaunchSpec 返回 true', () => {
    expect(isLaunchSpec(validSpec())).toBe(true);
  });

  it('A2: null 返回 false', () => {
    expect(isLaunchSpec(null)).toBe(false);
  });

  it('A3: undefined 返回 false', () => {
    expect(isLaunchSpec(undefined)).toBe(false);
  });

  it('A4: 字符串输入返回 false', () => {
    expect(isLaunchSpec('string')).toBe(false);
  });

  it('A5: runtime=k8s 返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), runtime: 'k8s' })).toBe(false);
  });

  it('A6: command 空字符串返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), command: '' })).toBe(false);
  });

  it('A7: args 非字符串数组返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), args: [1, 2] })).toBe(false);
  });

  it('A8: env 的 value 非字符串返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), env: { FOO: 42 } })).toBe(false);
  });

  it('A9: cwd 空字符串返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), cwd: '' })).toBe(false);
  });

  it('A10: stdio.stdin 非法枚举值返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), stdio: { stdin: 'weird' } })).toBe(false);
  });

  it('A11: 缺 runtime 返回 false', () => {
    const { runtime: _r, ...rest } = validSpec();
    expect(isLaunchSpec(rest)).toBe(false);
  });

  it('A12: 缺 command 返回 false', () => {
    const { command: _c, ...rest } = validSpec();
    expect(isLaunchSpec(rest)).toBe(false);
  });

  it('A13: 缺 args 返回 false', () => {
    const { args: _a, ...rest } = validSpec();
    expect(isLaunchSpec(rest)).toBe(false);
  });

  it('A14: 缺 env 返回 false', () => {
    const { env: _e, ...rest } = validSpec();
    expect(isLaunchSpec(rest)).toBe(false);
  });

  it('A15: 缺 cwd 返回 false', () => {
    const { cwd: _w, ...rest } = validSpec();
    expect(isLaunchSpec(rest)).toBe(false);
  });

  it('A16: stdio=undefined 合法返回 true', () => {
    expect(isLaunchSpec({ ...validSpec(), stdio: undefined })).toBe(true);
  });

  it('runtime=docker 合法返回 true', () => {
    expect(isLaunchSpec({ ...validSpec(), runtime: 'docker' })).toBe(true);
  });

  it('stdio 全字段齐全合法返回 true', () => {
    expect(isLaunchSpec({
      ...validSpec(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    })).toBe(true);
  });

  it('env 数组形态返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), env: ['a', 'b'] })).toBe(false);
  });

  it('env=null 返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), env: null })).toBe(false);
  });

  it('args=null 返回 false', () => {
    expect(isLaunchSpec({ ...validSpec(), args: null })).toBe(false);
  });
});
