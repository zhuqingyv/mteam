// Stage 5 M8 装配：container.subscriber 的生产 deps 默认实现。
// primary_agent 表没有 runtime_kind 字段，用 TEAM_HUB_RUNTIME_KIND env 控制；
// docker image/network 走 TEAM_HUB_DOCKER_IMAGE / TEAM_HUB_DOCKER_NETWORK env。
import { HostRuntime } from '../../process-runtime/host-runtime.js';
import { createDockerRuntime } from '../../process-runtime/docker-runtime.js';
import type { ProcessRuntime } from '../../process-runtime/types.js';
import { cliManager } from '../../cli-scanner/manager.js';
import type { RuntimeConfigResolved } from './container.subscriber.js';

export function readRuntimeConfig(_agentId: string, cliType: string): RuntimeConfigResolved {
  const kind: 'host' | 'docker' = process.env.TEAM_HUB_RUNTIME_KIND === 'docker' ? 'docker' : 'host';
  const command = kind === 'host' ? (cliManager.getInfo(cliType)?.path ?? cliType) : cliType;
  return { runtime: kind, command, args: [], env: {}, cwd: process.cwd() };
}

export function buildRuntime(kind: 'host' | 'docker', _opts: unknown): ProcessRuntime {
  if (kind !== 'docker') return new HostRuntime();
  return createDockerRuntime({ image: process.env.TEAM_HUB_DOCKER_IMAGE ?? 'ghcr.io/anthropic/claude-sandbox:latest', network: process.env.TEAM_HUB_DOCKER_NETWORK });
}
