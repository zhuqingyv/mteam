#!/usr/bin/env bun
/**
 * MCP Team Hub — Thin Proxy
 *
 * stdio MCP server，所有工具调用转发到 Hub HTTP 服务。
 * Hub 不在运行时自动通过 CLI 唤起。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Hub 发现 ──
const HUB_DIR = path.join(os.homedir(), ".claude", "team-hub");
const DEFAULT_PORT = 58578;
const CLI_SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.ts");

function getHubPort(): number {
  try {
    const port = parseInt(fs.readFileSync(path.join(HUB_DIR, "hub.port"), "utf-8").trim(), 10);
    if (!isNaN(port)) return port;
  } catch {}
  return DEFAULT_PORT;
}

function getHubUrl(): string {
  return `http://127.0.0.1:${getHubPort()}`;
}

async function isHubAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function launchHub(): void {
  let bunPath = "bun";
  try { bunPath = execSync("which bun", { encoding: "utf-8" }).trim(); } catch {}
  // 用 CLI 的 start 命令启动（后台 detached，包含 panel）
  spawnSync(bunPath, ["run", CLI_SCRIPT, "start"], {
    stdio: "ignore",
    env: { ...process.env },
    timeout: 10_000,
  });
}

// ── 连接 Hub（自动唤起）──
let HUB_URL = getHubUrl();

if (!(await isHubAlive(HUB_URL))) {
  process.stderr.write(`[mcp-team-hub] Hub 未运行，自动唤起...\n`);
  launchHub();

  // 等 hub 起来（最多 8 秒）
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    HUB_URL = getHubUrl(); // port 文件可能刚写入
    if (await isHubAlive(HUB_URL)) { ready = true; break; }
  }
  if (!ready) {
    process.stderr.write(`[mcp-team-hub] ⚠️ Hub 启动超时，检查日志: ${path.join(HUB_DIR, "hub.log")}\n`);
    process.exit(1);
  }
  process.stderr.write(`[mcp-team-hub] Hub 已唤起 (${HUB_URL})\n`);
} else {
  // Hub 已在运行，但 Panel 可能已关闭 — 调 cli.ts start 确保 Panel 也在
  launchHub();
}

// ── Session 注册 ──
const ppid = process.ppid;
let lstart = "";
try {
  lstart = execSync(`ps -p ${ppid} -o lstart=`, { encoding: "utf-8" }).trim();
} catch {
  lstart = new Date().toString();
}

let sessionId: string;
try {
  const res = await fetch(`${HUB_URL}/api/session/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid: ppid, lstart }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { session_id: string };
  sessionId = data.session_id;
  process.stderr.write(`[mcp-team-hub] registered session=${sessionId}\n`);
} catch (err) {
  process.stderr.write(`[mcp-team-hub] ⚠️ Session 注册失败: ${(err as Error).message}\n`);
  process.exit(1);
}

// ── MCP Server ──
const MCP_INSTRUCTIONS = [
  "# Team Hub — 团队记忆持久化系统",
  "",
  "## team-hub 是什么",
  "team-hub 不创建 agent（创建 agent 用你自己的 Agent tool）。",
  "team-hub 是成员的记忆仓库，管理：人设模板、工作记忆、工作锁。",
  "",
  "## 你（Leader）的用法",
  "1. get_roster() → 查看成员花名册：名称、职业、简介、忙闲",
  "2. request_member(member, project, task) → 预约成员，返回预约码(reservation_code)和 spawn 指令",
  "3. 按 spawn_hint 用 Agent tool 创建 teammate",
  "4. teammate 启动后用预约码自己 activate，加载记忆和人设，你不用管",
  "5. team_report() 监控进展",
  "",
  "## 成员（teammate）启动后自己做的事",
  "activate(预约码→加载记忆) → 执行任务 → save_memory(保存记忆) → deactivate(释放工作区)",
  "",
  "## 重要",
  "- activate / save_memory / deactivate 是成员自己调的，leader 不要调",
  "- request_member 返回 reserved=true + reservation_code，预约 2 分钟内有效",
  "- 预约超时未激活自动释放，无需手动清理",
].join("\n");

const server = new Server(
  { name: "mcp-team-hub", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
);

// ListTools → 转发到 hub
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const res = await fetch(`${HUB_URL}/api/tools`);
  return await res.json();
});

// CallTool → 转发到 hub
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const res = await fetch(`${HUB_URL}/api/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      tool: request.params.name,
      arguments: request.params.arguments ?? {},
    }),
  });
  return await res.json();
});

// ── Graceful shutdown ──
let exiting = false;
async function cleanup() {
  if (exiting) return;
  exiting = true;
  try {
    await fetch(`${HUB_URL}/api/session/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch {}
  process.exit(0);
}
process.stdin.on("close", cleanup);
process.stdin.on("end", cleanup);

// ── 启动 ──
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mcp-team-hub] proxy ready, hub=${HUB_URL}, session=${sessionId}\n`);
