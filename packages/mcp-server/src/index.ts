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

// ── 连接 Hub（按需唤起）──
// Panel 内 spawn 的成员终端设置 TEAM_HUB_NO_LAUNCH=1，跳过自动唤起
const skipLaunch = process.env.TEAM_HUB_NO_LAUNCH === "1";
let HUB_URL = getHubUrl();

if (!(await isHubAlive(HUB_URL))) {
  if (skipLaunch) {
    // Panel 内启动，Hub 应该已在运行，等一下再试
    process.stderr.write(`[mcp-team-hub] Hub 未就绪，等待中（Panel 模式）...\n`);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      HUB_URL = getHubUrl();
      if (await isHubAlive(HUB_URL)) { ready = true; break; }
    }
    if (!ready) {
      process.stderr.write(`[mcp-team-hub] ⚠️ Hub 连接超时\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write(`[mcp-team-hub] Hub 未运行，自动唤起...\n`);
    launchHub();

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      HUB_URL = getHubUrl();
      if (await isHubAlive(HUB_URL)) { ready = true; break; }
    }
    if (!ready) {
      process.stderr.write(`[mcp-team-hub] ⚠️ Hub 启动超时，检查日志: ${path.join(HUB_DIR, "hub.log")}\n`);
      process.exit(1);
    }
    process.stderr.write(`[mcp-team-hub] Hub 已唤起 (${HUB_URL})\n`);
  }
} else if (!skipLaunch) {
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

const memberName = process.env.CLAUDE_MEMBER || "";
// IS_LEADER 显式标记优先；向后兼容：无 CLAUDE_MEMBER 视为 leader
const isLeader = process.env.IS_LEADER === "1" || !memberName;

let sessionId: string;
try {
  const res = await fetch(`${HUB_URL}/api/session/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid: ppid, lstart, member: memberName, isLeader }),
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
  "## 你是谁",
  "- 如果你有 reservation_code（来自 spawn 提示词），你是成员，第一步调 activate",
  "- 如果你没有 reservation_code，你是 leader，直接使用 leader 工具",
  "",
  "## team-hub 是什么",
  "team-hub 不创建 agent（创建 agent 用你自己的 Agent tool）。",
  "team-hub 是成员的记忆仓库，管理：人设模板、工作记忆、工作锁、MCP 代理、项目管理。",
  "",
  "## Leader 用法",
  "1. get_roster() → 查看花名册，选人",
  "2. request_member(member, project, task, auto_spawn=true) → 预约成员，自动创建终端窗口",
  "3. send_msg(to=member, content=任务描述) → 给成员下达指令",
  "4. team_report() / project_dashboard(project) → 监控进展",
  "",
  "## 成员生命周期",
  "activate(reservation_code) → 执行任务 → checkpoint() → save_memory() → deactivate()",
  "",
  "## 离场流程",
  "leader: request_departure(member) → 成员收到通知 → 成员收尾 → clock_out(member=自己)",
  "- request_departure(pending=false) 可撤销离场请求",
  "- clock_out 只有 pending_departure 状态的成员才能调用",
  "- ⚠️ release_member 是异常清理工具（成员进程已死时用），不会通知成员，不要用于正常退场！",
  "",
  "## 成员专用工具（leader 不要调）",
  "activate, save_memory, read_memory, deactivate, submit_experience, checkpoint, check_in（极少使用，仅应急）, check_out（极少使用，仅应急）, check_inbox, clock_out",
  "",
  "## 跨 Agent 通信",
  "- send_msg(to, content) → 消息写入目标 agent 终端 stdin",
  "- check_inbox(member) → 查看收到的消息",
  "",
  "## 治理流程",
  "propose_rule → review_rules → approve_rule / reject_rule（leader 审批）",
  "",
  "## 项目管理",
  "create_project → request_member 时指定 project → add_project_rule 设约束 → update_project 更新进度",
  "",
  "## MCP 代理",
  "install_store_mcp（团队商店）→ 成员 mount_mcp 挂载 → proxy_tool 调用。leader 也可 install_member_mcp 为指定成员安装。",
  "",
  "## 权限模型",
  "- leader：request_member, force_release, release_member（异常清理专用）, hire_temp, evaluate_temp, approve/reject_rule, install/uninstall MCP, request_departure（正常退场用这个）",
  "- 成员：activate, save_memory, read_memory, deactivate, submit_experience, checkpoint, check_in/out, mount/unmount_mcp, proxy_tool, clock_out",
  "- 所有人：get_roster, get_status, team_report, search_experience, read_shared, send_msg, check_inbox",
  "",
  "## 错误恢复",
  "- activate 失败 → 检查 get_status 确认状态，通知 leader 重新 request_member",
  "- save_memory 失败 → 重试一次，仍失败则 deactivate(force=true) 避免死锁",
  "- deactivate 失败 → check_out(force=true) 兜底释放锁",
  "- 权限不足 → 用 send_msg 联系 leader 请求操作",
  "- 预约过期 → 通知 leader 重新 request_member",
  "",
  "## 重要",
  "- activate / save_memory / deactivate 是成员自己调的，leader 不要调",
  "- request_member 返回 reserved=true + reservation_code + usage_hint，预约 3 分 30 秒内有效",
  "- 预约超时未激活自动释放，无需手动清理",
].join("\n");

const server = new Server(
  { name: "teamhub", version: "0.1.0" },
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
