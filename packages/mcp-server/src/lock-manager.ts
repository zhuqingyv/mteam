import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";

export interface LockData {
  nonce: string;
  session_pid: number;
  session_start: string;
  project: string;
  task: string;
  locked_at: string;
}

function readLockFile(lockPath: string): LockData | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    return JSON.parse(raw) as LockData;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number, sessionStart: string): boolean {
  try {
    execSync(`kill -0 ${pid}`, { stdio: "pipe" });
    const actualStart = execSync(`ps -p ${pid} -o lstart=`, {
      encoding: "utf-8",
    }).trim();
    return actualStart === sessionStart;
  } catch (err) {
    // kill -0 失败有两种情况：
    // 1. "Operation not permitted" (EPERM) — 进程存在但无权发信号，视为存活
    // 2. "No such process" — 进程确实不存在，视为死亡
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (stderr.includes("Operation not permitted") || stderr.includes("not permitted")) {
      return true;
    }
    return false;
  }
}

export function acquireLock(
  membersDir: string,
  name: string,
  sessionPid: number,
  sessionStart: string,
  project: string,
  task: string
): { success: boolean; error?: string } {
  const memberDir = path.join(membersDir, name);
  fs.mkdirSync(memberDir, { recursive: true });

  const lockPath = path.join(memberDir, "lock.json");
  const nonce = uuidv4();
  const tmpPath = path.join(memberDir, `lock.tmp.${nonce}`);

  const lockData: LockData = {
    nonce,
    session_pid: sessionPid,
    session_start: sessionStart,
    project,
    task,
    locked_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), "utf-8");
    try {
      // linkSync 目标存在会 EEXIST 失败
      fs.linkSync(tmpPath, lockPath);
      fs.unlinkSync(tmpPath);
      return { success: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        return { success: false, error: "lock already held" };
      }
      throw err;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // 已经被 unlink 或 rename 了，忽略
    }
  }
}

export function takeover(
  membersDir: string,
  name: string,
  myPid: number,
  mySessionStart: string,
  project: string,
  task: string
): { success: boolean; error?: string } {
  const memberDir = path.join(membersDir, name);
  fs.mkdirSync(memberDir, { recursive: true });

  const lockPath = path.join(memberDir, "lock.json");
  const existing = readLockFile(lockPath);

  if (!existing) {
    // 锁不存在，直接抢
    return acquireLock(membersDir, name, myPid, mySessionStart, project, task);
  }

  if (isProcessAlive(existing.session_pid, existing.session_start)) {
    return { success: false, error: "lock holder is still alive" };
  }

  const myNonce = uuidv4();
  const tmpPath = path.join(memberDir, `lock.tmp.${myNonce}`);

  const lockData: LockData = {
    nonce: myNonce,
    session_pid: myPid,
    session_start: mySessionStart,
    project,
    task,
    locked_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), "utf-8");
    // renameSync 原子覆盖
    fs.renameSync(tmpPath, lockPath);

    // 读回验证 nonce 是自己的
    const verify = readLockFile(lockPath);
    if (verify?.nonce !== myNonce) {
      return { success: false, error: "nonce mismatch after takeover, race condition" };
    }
    return { success: true };
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // 忽略
    }
    const e = err as Error;
    return { success: false, error: e.message };
  }
}

export function releaseLock(
  membersDir: string,
  name: string,
  expectedNonce: string
): { success: boolean; error?: string } {
  const lockPath = path.join(membersDir, name, "lock.json");
  const lock = readLockFile(lockPath);

  if (!lock) {
    return { success: false, error: "no lock found" };
  }
  if (lock.nonce !== expectedNonce) {
    return { success: false, error: "nonce mismatch, not the lock owner" };
  }

  const ts = Date.now();
  const removingPath = `${lockPath}.removing.${ts}`;
  try {
    fs.renameSync(lockPath, removingPath);
    fs.unlinkSync(removingPath);
    return { success: true };
  } catch (err) {
    const e = err as Error;
    return { success: false, error: e.message };
  }
}

export function readLock(membersDir: string, name: string): LockData | null {
  return readLockFile(path.join(membersDir, name, "lock.json"));
}

export function scanOrphanLocks(membersDir: string): string[] {
  const cleaned: string[] = [];
  if (!fs.existsSync(membersDir)) return cleaned;

  const entries = fs.readdirSync(membersDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lockPath = path.join(membersDir, entry.name, "lock.json");
    const lock = readLockFile(lockPath);
    if (!lock) continue;
    if (!isProcessAlive(lock.session_pid, lock.session_start)) {
      const ts = Date.now();
      const removingPath = `${lockPath}.removing.${ts}`;
      try {
        fs.renameSync(lockPath, removingPath);
        fs.unlinkSync(removingPath);
        cleaned.push(entry.name);
      } catch {
        // 并发清理，忽略
      }
    }
  }
  return cleaned;
}

/**
 * 更新自己持有的锁的 project/task（nonce 不变，原子 renameSync 覆盖）。
 * expectedNonce 必须匹配，防止意外覆盖他人锁。
 */
export function updateLock(
  membersDir: string,
  name: string,
  expectedNonce: string,
  project: string,
  task: string
): { success: boolean; error?: string } {
  const memberDir = path.join(membersDir, name);
  const lockPath = path.join(memberDir, "lock.json");
  const existing = readLockFile(lockPath);

  if (!existing) return { success: false, error: "no lock found" };
  if (existing.nonce !== expectedNonce) return { success: false, error: "nonce mismatch" };

  const updated: LockData = { ...existing, project, task, locked_at: new Date().toISOString() };
  const tmpPath = path.join(memberDir, `lock.tmp.${expectedNonce}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
    fs.renameSync(tmpPath, lockPath);
    return { success: true };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { success: false, error: (err as Error).message };
  }
}

export function forceRelease(membersDir: string, name: string): { success: boolean; error?: string } {
  const lockPath = path.join(membersDir, name, "lock.json");
  if (!fs.existsSync(lockPath)) {
    return { success: false, error: "no lock found" };
  }
  const ts = Date.now();
  const removingPath = `${lockPath}.removing.${ts}`;
  try {
    fs.renameSync(lockPath, removingPath);
    fs.unlinkSync(removingPath);
    return { success: true };
  } catch (err) {
    const e = err as Error;
    return { success: false, error: e.message };
  }
}
