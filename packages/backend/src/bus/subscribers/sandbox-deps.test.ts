// M8 装配层单测：env 切换 runtime kind + docker image/network 透传。
// 不 mock 任何东西，只读 env。
import { describe, it, expect, afterEach } from 'bun:test';
import { readRuntimeConfig, buildRuntime } from './sandbox-deps.js';
import { HostRuntime } from '../../process-runtime/host-runtime.js';
import { DockerRuntime } from '../../process-runtime/docker-runtime.js';

const SAVED = {
  kind: process.env.TEAM_HUB_RUNTIME_KIND,
  image: process.env.TEAM_HUB_DOCKER_IMAGE,
  net: process.env.TEAM_HUB_DOCKER_NETWORK,
};

afterEach(() => {
  process.env.TEAM_HUB_RUNTIME_KIND = SAVED.kind;
  process.env.TEAM_HUB_DOCKER_IMAGE = SAVED.image;
  process.env.TEAM_HUB_DOCKER_NETWORK = SAVED.net;
});

describe('sandbox-deps · readRuntimeConfig', () => {
  it('默认 kind=host，cli path 由 cli-scanner 决定（未扫到则 fallback 到 cliType 字符串）', () => {
    delete process.env.TEAM_HUB_RUNTIME_KIND;
    const cfg = readRuntimeConfig('agent-1', 'claude');
    expect(cfg.runtime).toBe('host');
    expect(typeof cfg.command).toBe('string');
    expect(cfg.args).toEqual([]);
  });

  it('TEAM_HUB_RUNTIME_KIND=docker → runtime=docker，command=cliType（镜像内路径）', () => {
    process.env.TEAM_HUB_RUNTIME_KIND = 'docker';
    const cfg = readRuntimeConfig('agent-1', 'claude');
    expect(cfg.runtime).toBe('docker');
    expect(cfg.command).toBe('claude');
  });

  it('非 docker 的字符串（如 "yes"）一律回退 host', () => {
    process.env.TEAM_HUB_RUNTIME_KIND = 'yes';
    expect(readRuntimeConfig('a', 'claude').runtime).toBe('host');
  });
});

describe('sandbox-deps · buildRuntime', () => {
  it('kind=host → HostRuntime 实例', () => {
    expect(buildRuntime('host', null)).toBeInstanceOf(HostRuntime);
  });

  it('kind=docker → DockerRuntime 实例（image 走 env / 默认 fallback）', () => {
    delete process.env.TEAM_HUB_DOCKER_IMAGE;
    expect(buildRuntime('docker', null)).toBeInstanceOf(DockerRuntime);
    process.env.TEAM_HUB_DOCKER_IMAGE = 'my/custom:tag';
    expect(buildRuntime('docker', null)).toBeInstanceOf(DockerRuntime);
  });
});
