import { describe, it, expect } from 'vitest';
import { resolveRuntimeKindFromEnv } from './driver-config.js';

describe('resolveRuntimeKindFromEnv', () => {
  it('TEAM_HUB_RUNTIME_KIND=docker → docker', () => {
    expect(resolveRuntimeKindFromEnv({ TEAM_HUB_RUNTIME_KIND: 'docker' })).toBe(
      'docker',
    );
  });

  it('TEAM_HUB_RUNTIME_KIND=host → host', () => {
    expect(resolveRuntimeKindFromEnv({ TEAM_HUB_RUNTIME_KIND: 'host' })).toBe(
      'host',
    );
  });

  it('未设置 → host', () => {
    expect(resolveRuntimeKindFromEnv({})).toBe('host');
  });

  it('非法值 → host（安全兜底）', () => {
    expect(resolveRuntimeKindFromEnv({ TEAM_HUB_RUNTIME_KIND: 'wasm' })).toBe(
      'host',
    );
  });
});
