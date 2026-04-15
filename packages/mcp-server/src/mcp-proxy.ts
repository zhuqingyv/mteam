/**
 * MCP Proxy — 子 MCP 进程管理器
 *
 * 为每个成员按需 spawn 子 MCP 进程，代理工具调用，空闲自动回收。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface McpConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

interface ChildMcp {
  config: McpConfig;
  client: Client;
  transport: StdioClientTransport;
  process: ChildProcess | null;
  lastUsed: number;
  tools: string[]; // 缓存的工具名列表
}

// memberName -> mcpName -> ChildMcp
const pool = new Map<string, Map<string, ChildMcp>>();

const IDLE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let pidFilePath: string | null = null;

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initProxy(hubDir: string): void {
  pidFilePath = path.join(hubDir, "children_pids.json");
  setSharedDir(path.join(hubDir, "shared"));

  // 启动时清理残留子进程
  cleanupStaleProcesses();

  // 定时扫描空闲子 MCP
  sweepTimer = setInterval(sweepIdle, 10_000);
}

// ── 团队 MCP 商店 ────────────────────────────────────────────────────────────

let sharedDir: string = "";

export function setSharedDir(dir: string): void {
  sharedDir = dir;
}

function getStorePath(): string {
  return path.join(sharedDir, "mcp_store.json");
}

export function loadStore(): McpConfig[] {
  try {
    return JSON.parse(fs.readFileSync(getStorePath(), "utf-8")) as McpConfig[];
  } catch {
    return [];
  }
}

function saveStore(store: McpConfig[]): void {
  fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

export function addToStore(config: McpConfig): void {
  const store = loadStore();
  const idx = store.findIndex((m) => m.name === config.name);
  if (idx >= 0) {
    store[idx] = config;
  } else {
    store.push(config);
  }
  saveStore(store);
}

export function removeFromStore(mcpName: string): boolean {
  const store = loadStore();
  const filtered = store.filter((m) => m.name !== mcpName);
  if (filtered.length === store.length) return false;
  saveStore(filtered);
  return true;
}

// ── 成员 mount/unmount（从商店挂载到个人）─────────────────────────────────────

export function mountMcp(membersDir: string, memberName: string, mcpName: string): { success: boolean; error?: string } {
  const store = loadStore();
  const storeItem = store.find((m) => m.name === mcpName);
  if (!storeItem) return { success: false, error: `MCP "${mcpName}" 不在团队商店中` };

  const mcps = loadMemberMcps(membersDir, memberName);
  if (mcps.some((m) => m.name === mcpName)) {
    return { success: true, error: "已挂载" };
  }
  mcps.push(storeItem);
  saveMemberMcps(membersDir, memberName, mcps);
  return { success: true };
}

export function unmountMcp(membersDir: string, memberName: string, mcpName: string): { success: boolean } {
  const mcps = loadMemberMcps(membersDir, memberName);
  const filtered = mcps.filter((m) => m.name !== mcpName);
  if (filtered.length === mcps.length) return { success: false };
  saveMemberMcps(membersDir, memberName, filtered);
  return { success: true };
}

// ── 成员 MCP 配置管理 ─────────────────────────────────────────────────────────

function getMcpConfigPath(membersDir: string, memberName: string): string {
  return path.join(membersDir, memberName, "mcps.json");
}

export function loadMemberMcps(membersDir: string, memberName: string): McpConfig[] {
  const configPath = getMcpConfigPath(membersDir, memberName);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as McpConfig[];
  } catch {
    return [];
  }
}

export function saveMemberMcps(membersDir: string, memberName: string, mcps: McpConfig[]): void {
  const configPath = getMcpConfigPath(membersDir, memberName);
  fs.writeFileSync(configPath, JSON.stringify(mcps, null, 2), "utf-8");
}

export function installMcp(membersDir: string, memberName: string, config: McpConfig): void {
  const mcps = loadMemberMcps(membersDir, memberName);
  const idx = mcps.findIndex((m) => m.name === config.name);
  if (idx >= 0) {
    mcps[idx] = config;
  } else {
    mcps.push(config);
  }
  saveMemberMcps(membersDir, memberName, mcps);
}

export function uninstallMcp(membersDir: string, memberName: string, mcpName: string): boolean {
  const mcps = loadMemberMcps(membersDir, memberName);
  const filtered = mcps.filter((m) => m.name !== mcpName);
  if (filtered.length === mcps.length) return false;
  saveMemberMcps(membersDir, memberName, filtered);
  return true;
}

// ── 子 MCP 生命周期 ──────────────────────────────────────────────────────────

async function spawnChild(memberName: string, config: McpConfig): Promise<ChildMcp> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
  });

  const client = new Client(
    { name: `team-hub-proxy/${memberName}/${config.name}`, version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // 缓存工具列表
  let tools: string[] = [];
  try {
    const toolList = await client.listTools();
    tools = toolList.tools.map((t) => t.name);
  } catch {
    // ignore
  }

  // 获取子进程 PID
  const proc = (transport as unknown as { _process?: ChildProcess })._process ?? null;

  const child: ChildMcp = {
    config,
    client,
    transport,
    process: proc,
    lastUsed: Date.now(),
    tools,
  };

  // 记录 PID
  persistPids();

  return child;
}

async function getOrSpawnChild(memberName: string, mcpName: string, membersDir: string): Promise<ChildMcp> {
  let memberPool = pool.get(memberName);
  if (!memberPool) {
    memberPool = new Map();
    pool.set(memberName, memberPool);
  }

  const existing = memberPool.get(mcpName);
  if (existing) {
    // 检查进程是否还活着
    if (existing.process && existing.process.exitCode !== null) {
      // 已退出，清理并重新 spawn
      memberPool.delete(mcpName);
    } else {
      existing.lastUsed = Date.now();
      return existing;
    }
  }

  // 查找配置
  const mcps = loadMemberMcps(membersDir, memberName);
  const config = mcps.find((m) => m.name === mcpName);
  if (!config) {
    throw new Error(`成员 ${memberName} 没有配置名为 ${mcpName} 的 MCP`);
  }

  const child = await spawnChild(memberName, config);
  memberPool.set(mcpName, child);
  persistPids();
  return child;
}

// ── 代理调用 ──────────────────────────────────────────────────────────────────

export async function proxyToolCall(
  membersDir: string,
  memberName: string,
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const child = await getOrSpawnChild(memberName, mcpName, membersDir);

  // 带超时调用
  const result = await Promise.race([
    child.client.callTool({ name: toolName, arguments: args }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`调用超时 (${CALL_TIMEOUT_MS}ms): ${mcpName}/${toolName}`)), CALL_TIMEOUT_MS)
    ),
  ]);

  child.lastUsed = Date.now();
  return result;
}

export async function listChildTools(
  membersDir: string,
  memberName: string,
  mcpName: string
): Promise<string[]> {
  const child = await getOrSpawnChild(memberName, mcpName, membersDir);
  return child.tools;
}

// ── 清理 ─────────────────────────────────────────────────────────────────────

async function killChild(child: ChildMcp): Promise<void> {
  try {
    await child.client.close();
  } catch {
    // 强制杀进程
    if (child.process && child.process.exitCode === null) {
      child.process.kill("SIGKILL");
    }
  }
}

export async function cleanupMember(memberName: string): Promise<string[]> {
  const memberPool = pool.get(memberName);
  if (!memberPool) return [];

  const cleaned: string[] = [];
  for (const [mcpName, child] of memberPool) {
    await killChild(child);
    cleaned.push(mcpName);
  }
  pool.delete(memberName);
  persistPids();
  return cleaned;
}

export async function cleanupOneMcp(memberName: string, mcpName: string): Promise<boolean> {
  const memberPool = pool.get(memberName);
  if (!memberPool) return false;
  const child = memberPool.get(mcpName);
  if (!child) return false;
  await killChild(child);
  memberPool.delete(mcpName);
  if (memberPool.size === 0) pool.delete(memberName);
  persistPids();
  return true;
}

export async function preSpawnMcp(membersDir: string, memberName: string, mcpName: string): Promise<string[]> {
  const child = await getOrSpawnChild(memberName, mcpName, membersDir);
  return child.tools;
}

export function isChildRunning(memberName: string, mcpName: string): boolean {
  const memberPool = pool.get(memberName);
  if (!memberPool) return false;
  const child = memberPool.get(mcpName);
  if (!child) return false;
  return child.process === null || child.process.exitCode === null;
}

export async function cleanupAll(): Promise<void> {
  for (const [memberName] of pool) {
    await cleanupMember(memberName);
  }
  pool.clear();
  persistPids();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// ── 空闲回收 ──────────────────────────────────────────────────────────────────

function sweepIdle(): void {
  const now = Date.now();
  for (const [memberName, memberPool] of pool) {
    for (const [mcpName, child] of memberPool) {
      if (now - child.lastUsed > IDLE_TIMEOUT_MS) {
        killChild(child).catch(() => {});
        memberPool.delete(mcpName);
      }
    }
    if (memberPool.size === 0) {
      pool.delete(memberName);
    }
  }
  persistPids();
}

// ── PID 持久化（崩溃恢复用）──────────────────────────────────────────────────

function collectPids(): number[] {
  const pids: number[] = [];
  for (const [, memberPool] of pool) {
    for (const [, child] of memberPool) {
      if (child.process?.pid) pids.push(child.process.pid);
    }
  }
  return pids;
}

function persistPids(): void {
  if (!pidFilePath) return;
  try {
    const pids = collectPids();
    fs.writeFileSync(pidFilePath, JSON.stringify(pids), "utf-8");
  } catch {
    // ignore
  }
}

function cleanupStaleProcesses(): void {
  if (!pidFilePath || !fs.existsSync(pidFilePath)) return;
  try {
    const raw = fs.readFileSync(pidFilePath, "utf-8");
    const pids = JSON.parse(raw) as number[];
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程已不存在，忽略
      }
    }
    fs.writeFileSync(pidFilePath, "[]", "utf-8");
  } catch {
    // ignore
  }
}

// ── 状态查询 ──────────────────────────────────────────────────────────────────

export function getProxyStatus(): {
  members: { name: string; mcps: { name: string; tools: string[]; idleSeconds: number }[] }[];
  totalChildren: number;
} {
  const now = Date.now();
  const members: { name: string; mcps: { name: string; tools: string[]; idleSeconds: number }[] }[] = [];
  let totalChildren = 0;

  for (const [memberName, memberPool] of pool) {
    const mcps: { name: string; tools: string[]; idleSeconds: number }[] = [];
    for (const [mcpName, child] of memberPool) {
      mcps.push({
        name: mcpName,
        tools: child.tools,
        idleSeconds: Math.round((now - child.lastUsed) / 1000),
      });
      totalChildren++;
    }
    members.push({ name: memberName, mcps });
  }

  return { members, totalChildren };
}
