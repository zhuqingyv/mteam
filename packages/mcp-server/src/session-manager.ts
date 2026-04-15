import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { scanOrphanLocks, releaseLock, readLock } from "./lock-manager.js";
import { cleanupAll as cleanupAllMcps } from "./mcp-proxy.js";
import { removeHeartbeat } from "./heartbeat.js";

export interface SessionData {
  pid: number;
  lstart: string;
  cwd: string;
  started_at: string;
}

let hubDir: string;
let sessionFilePath: string;
let myNonces: Map<string, string> = new Map(); // memberName -> nonce

// ── activate 状态追踪 ──
const activatedMembers = new Set<string>();

export function markActivated(member: string): void {
  activatedMembers.add(member);
}

export function isActivated(member: string): boolean {
  return activatedMembers.has(member);
}

// ── 经验保存追踪 ──
const membersSavedMemory = new Set<string>();

export function markMemorySaved(member: string): void {
  membersSavedMemory.add(member);
}

export function hasMemorySaved(member: string): boolean {
  return membersSavedMemory.has(member);
}

export function clearMemberTracking(member: string): void {
  activatedMembers.delete(member);
  membersSavedMemory.delete(member);
}

export function initSession(hub: string): { pid: number; lstart: string } {
  hubDir = hub;
  const sessionsDir = path.join(hub, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const ppid = process.ppid;
  let lstart = "";
  try {
    lstart = execSync(`ps -p ${ppid} -o lstart=`, { encoding: "utf-8" }).trim();
  } catch {
    lstart = new Date().toString();
  }

  const sessionData: SessionData = {
    pid: ppid,
    lstart,
    cwd: process.cwd(),
    started_at: new Date().toISOString(),
  };

  sessionFilePath = path.join(sessionsDir, `${ppid}.json`);
  fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf-8");

  // 清理孤儿锁
  const membersDir = path.join(hub, "members");
  const cleaned = scanOrphanLocks(membersDir);
  if (cleaned.length > 0) {
    process.stderr.write(`[session-manager] cleaned orphan locks: ${cleaned.join(", ")}\n`);
  }

  // 监听 stdin 关闭，触发 graceful shutdown
  process.stdin.on("close", gracefulShutdown);
  process.stdin.on("end", gracefulShutdown);

  return { pid: ppid, lstart };
}

export function registerLockNonce(memberName: string, nonce: string): void {
  myNonces.set(memberName, nonce);
}

export function unregisterLockNonce(memberName: string): void {
  myNonces.delete(memberName);
}

export function getLockNonce(memberName: string): string | undefined {
  return myNonces.get(memberName);
}

function gracefulShutdown(): void {
  // 清理所有子 MCP 进程
  cleanupAllMcps().catch(() => {});

  const membersDir = path.join(hubDir, "members");
  const ppid = process.ppid;

  // 释放本 session 持有的所有锁
  if (fs.existsSync(membersDir)) {
    const entries = fs.readdirSync(membersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lock = readLock(membersDir, entry.name);
      if (lock && lock.session_pid === ppid) {
        const nonce = myNonces.get(entry.name) ?? lock.nonce;
        releaseLock(membersDir, entry.name, nonce);
      }
    }
  }

  // 清理所有已激活成员的心跳
  for (const member of activatedMembers) {
    removeHeartbeat(membersDir, member);
  }

  // 删 session 文件
  if (sessionFilePath) {
    try {
      fs.unlinkSync(sessionFilePath);
    } catch {
      // 忽略
    }
  }

  process.exit(0);
}
