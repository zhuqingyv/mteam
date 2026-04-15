#!/usr/bin/env bun
/**
 * Team Hub CLI — 客户端入口
 *
 * Usage:
 *   team-hub start   启动 Hub 服务 + Panel（后台运行）
 *   team-hub stop    停止 Hub 服务
 *   team-hub status  查看运行状态
 *   team-hub restart 重启
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";

const HUB_DIR = path.join(os.homedir(), ".claude", "team-hub");
const PID_FILE = path.join(HUB_DIR, "hub.pid");
const PORT_FILE = path.join(HUB_DIR, "hub.port");
const DEFAULT_PORT = 58578;
const HUB_SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "hub.ts");

fs.mkdirSync(HUB_DIR, { recursive: true });

// ── helpers ──

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getPort(): number {
  try {
    const port = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
    return isNaN(port) ? DEFAULT_PORT : port;
  } catch {
    return DEFAULT_PORT;
  }
}

async function isHubHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function cleanup(): void {
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  try { fs.rmSync(PORT_FILE, { force: true }); } catch {}
}

// ── commands ──

async function start(): Promise<void> {
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    const port = getPort();
    if (await isHubHealthy(port)) {
      console.log(`Hub 已在运行 (pid=${existingPid}, port=${port})`);
      launchPanel(); // Panel 可能已关闭，确保重启
      return;
    }
    // PID 活着但 health 不通 → 杀掉重启
    console.log(`Hub 进程存在但无响应，重启...`);
    try { process.kill(existingPid, "SIGTERM"); } catch {}
    cleanup();
  }

  // 检查 hub.ts 存在
  if (!fs.existsSync(HUB_SCRIPT)) {
    console.error(`Hub 脚本不存在: ${HUB_SCRIPT}`);
    process.exit(1);
  }

  // 找 bun 路径
  let bunPath = "bun";
  try {
    bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {}

  // 后台启动 hub
  const logFile = path.join(HUB_DIR, "hub.log");
  const logFd = fs.openSync(logFile, "a");

  const child = spawn(bunPath, ["run", HUB_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
    cwd: path.dirname(HUB_SCRIPT),
  });
  child.unref();
  fs.closeSync(logFd);

  // 等待 hub 启动（最多 5 秒）
  const port = DEFAULT_PORT;
  let ready = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isHubHealthy(port)) {
      ready = true;
      break;
    }
  }

  if (ready) {
    const pid = readPid() ?? child.pid;
    console.log(`Hub 已启动 (pid=${pid}, port=${port})`);

    // 尝试启动 Panel
    launchPanel();
  } else {
    console.error(`Hub 启动超时，检查日志: ${logFile}`);
    process.exit(1);
  }
}

function stop(): void {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("Hub 未在运行");
    cleanup();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Hub 已停止 (pid=${pid})`);
  } catch (err) {
    console.error(`停止失败: ${(err as Error).message}`);
  }
  cleanup();
}

async function status(): Promise<void> {
  const pid = readPid();
  const port = getPort();

  if (!pid || !isRunning(pid)) {
    console.log("Hub: 未运行");
    return;
  }

  if (await isHubHealthy(port)) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const data = await res.json() as Record<string, unknown>;
      console.log(`Hub: 运行中 (pid=${pid}, port=${port})`);
      console.log(`  Sessions: ${data.sessions}`);
      console.log(`  Uptime: ${data.uptime}s`);
    } catch {
      console.log(`Hub: 运行中 (pid=${pid}, port=${port})`);
    }
  } else {
    console.log(`Hub: 进程存在但无响应 (pid=${pid})`);
  }
}

function launchPanel(): void {
  // 查找 panel 目录
  const panelCandidates = [
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../panel"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../panel"),
  ];

  let panelDir: string | null = null;
  for (const c of panelCandidates) {
    if (fs.existsSync(path.join(c, "out", "main", "index.js"))) {
      panelDir = c;
      break;
    }
  }
  if (!panelDir) return; // Panel 未构建，跳过

  // 检查 Panel 是否已运行
  const panelPidFile = path.join(HUB_DIR, "panel.pid");
  try {
    const panelPid = parseInt(fs.readFileSync(panelPidFile, "utf-8").trim(), 10);
    if (!isNaN(panelPid) && isRunning(panelPid)) return; // 已在运行
  } catch {}

  // 找 electron
  const electronCandidates = [
    path.join(panelDir, "node_modules", ".bin", "electron"),
    path.resolve(panelDir, "../../node_modules/.bin/electron"),
  ];
  let electronBin: string | null = null;
  for (const c of electronCandidates) {
    if (fs.existsSync(c)) { electronBin = c; break; }
  }
  if (!electronBin) return;

  const mainEntry = path.join(panelDir, "out", "main", "index.js");
  const child = spawn(electronBin, [mainEntry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MCP_HUB_DIR: HUB_DIR, ELECTRON_RENDERER_URL: '' },
    cwd: panelDir,
  });
  child.unref();

  if (child.pid) {
    fs.writeFileSync(panelPidFile, String(child.pid), "utf-8");
  }
}

// ── main ──

const cmd = process.argv[2] ?? "start";

switch (cmd) {
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    stop();
    await new Promise((r) => setTimeout(r, 500));
    await start();
    break;
  case "status":
    await status();
    break;
  default:
    console.log("Usage: team-hub [start|stop|restart|status]");
    process.exit(1);
}
