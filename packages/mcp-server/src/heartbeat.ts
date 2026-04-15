/**
 * Heartbeat — Agent 级别心跳管理
 *
 * 每次 agent 调用 MCP 工具时更新 heartbeat.json，
 * 用于检测 agent 是否存活（不依赖 PID）。
 */
import fs from "node:fs";
import path from "node:path";

export interface HeartbeatData {
  /** ISO 8601 时间戳 */
  last_seen: string;
  /** Unix 毫秒时间戳，用于快速比较 */
  last_seen_ms: number;
  /** 持有心跳的 session PID */
  session_pid: number;
  /** 最后调用的工具名 */
  last_tool: string;
}

/** 默认超时：3 分钟 */
export const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 写入/更新心跳文件（原子 rename）
 */
export function touchHeartbeat(
  membersDir: string,
  memberName: string,
  sessionPid: number,
  toolName: string
): void {
  const memberDir = path.join(membersDir, memberName);
  if (!fs.existsSync(memberDir)) return; // 成员目录不存在则跳过

  const hbPath = path.join(memberDir, "heartbeat.json");
  const tmpPath = path.join(memberDir, `heartbeat.tmp.${sessionPid}`);
  const now = Date.now();

  const data: HeartbeatData = {
    last_seen: new Date(now).toISOString(),
    last_seen_ms: now,
    session_pid: sessionPid,
    last_tool: toolName,
  };

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, hbPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * 读取心跳文件
 */
export function readHeartbeat(
  membersDir: string,
  memberName: string
): HeartbeatData | null {
  const hbPath = path.join(membersDir, memberName, "heartbeat.json");
  try {
    const raw = fs.readFileSync(hbPath, "utf-8");
    return JSON.parse(raw) as HeartbeatData;
  } catch {
    return null;
  }
}

/**
 * 删除心跳文件
 */
export function removeHeartbeat(
  membersDir: string,
  memberName: string
): void {
  const hbPath = path.join(membersDir, memberName, "heartbeat.json");
  try {
    fs.unlinkSync(hbPath);
  } catch {
    // ENOENT 或其他错误，忽略
  }
}

/**
 * 检查心跳是否过期。
 * 有心跳且超时 → true
 * 无心跳或心跳新鲜 → false
 */
export function isHeartbeatStale(
  membersDir: string,
  memberName: string,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS
): boolean {
  const hb = readHeartbeat(membersDir, memberName);
  if (!hb) return false; // 没有心跳 ≠ 过期（从没上线过）
  return Date.now() - hb.last_seen_ms > timeoutMs;
}

/**
 * 扫描所有成员，返回心跳过期的成员名列表
 */
export function scanStaleHeartbeats(
  membersDir: string,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS
): string[] {
  const stale: string[] = [];
  if (!fs.existsSync(membersDir)) return stale;

  const entries = fs.readdirSync(membersDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isHeartbeatStale(membersDir, entry.name, timeoutMs)) {
      stale.push(entry.name);
    }
  }
  return stale;
}
