import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  acquireLock,
  releaseLock,
  readLock,
  updateLock,
  forceRelease,
  takeover,
} from "../lock-manager.ts";

let tmpDir: string;
let membersDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  membersDir = path.join(tmpDir, "members");
  fs.mkdirSync(membersDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("succeeds when no existing lock", () => {
    const result = acquireLock(membersDir, "alice", 12345, "Mon Jan 1 00:00:00 2024", "proj-a", "task-1");
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("fails when lock already held (EEXIST)", () => {
    acquireLock(membersDir, "alice", 12345, "Mon Jan 1 00:00:00 2024", "proj-a", "task-1");
    const result = acquireLock(membersDir, "alice", 99999, "Mon Jan 2 00:00:00 2024", "proj-b", "task-2");
    expect(result.success).toBe(false);
    expect(result.error).toBe("lock already held");
  });
});

describe("readLock", () => {
  test("returns data after acquire", () => {
    acquireLock(membersDir, "alice", 12345, "start-time", "proj-a", "task-1");
    const lock = readLock(membersDir, "alice");
    expect(lock).not.toBeNull();
    expect(lock!.session_pid).toBe(12345);
    expect(lock!.session_start).toBe("start-time");
    expect(lock!.project).toBe("proj-a");
    expect(lock!.task).toBe("task-1");
    expect(lock!.nonce).toBeTruthy();
    expect(lock!.locked_at).toBeTruthy();
  });

  test("returns null when no lock", () => {
    const lock = readLock(membersDir, "nonexistent");
    expect(lock).toBeNull();
  });
});

describe("releaseLock", () => {
  test("succeeds with correct nonce", () => {
    acquireLock(membersDir, "alice", 12345, "start-time", "proj-a", "task-1");
    const lock = readLock(membersDir, "alice")!;
    const result = releaseLock(membersDir, "alice", lock.nonce);
    expect(result.success).toBe(true);
    expect(readLock(membersDir, "alice")).toBeNull();
  });

  test("fails with wrong nonce", () => {
    acquireLock(membersDir, "alice", 12345, "start-time", "proj-a", "task-1");
    const result = releaseLock(membersDir, "alice", "wrong-nonce");
    expect(result.success).toBe(false);
    expect(result.error).toBe("nonce mismatch, not the lock owner");
    // Lock should still exist
    expect(readLock(membersDir, "alice")).not.toBeNull();
  });

  test("fails when no lock exists", () => {
    const result = releaseLock(membersDir, "alice", "any-nonce");
    expect(result.success).toBe(false);
    expect(result.error).toBe("no lock found");
  });
});

describe("updateLock", () => {
  test("succeeds with correct nonce and changes project/task", () => {
    acquireLock(membersDir, "alice", 12345, "start-time", "proj-a", "task-1");
    const lock = readLock(membersDir, "alice")!;
    const result = updateLock(membersDir, "alice", lock.nonce, "proj-b", "task-2");
    expect(result.success).toBe(true);

    const updated = readLock(membersDir, "alice")!;
    expect(updated.project).toBe("proj-b");
    expect(updated.task).toBe("task-2");
    // nonce should remain the same
    expect(updated.nonce).toBe(lock.nonce);
  });

  test("fails with wrong nonce", () => {
    acquireLock(membersDir, "alice", 12345, "start-time", "proj-a", "task-1");
    const result = updateLock(membersDir, "alice", "wrong-nonce", "proj-b", "task-2");
    expect(result.success).toBe(false);
    expect(result.error).toBe("nonce mismatch");

    // Original lock unchanged
    const lock = readLock(membersDir, "alice")!;
    expect(lock.project).toBe("proj-a");
  });

  test("fails when no lock exists", () => {
    const result = updateLock(membersDir, "alice", "any-nonce", "proj-b", "task-2");
    expect(result.success).toBe(false);
    expect(result.error).toBe("no lock found");
  });
});

describe("forceRelease", () => {
  test("succeeds when lock exists", () => {
    acquireLock(membersDir, "alice", 12345, "start-time", "proj-a", "task-1");
    const result = forceRelease(membersDir, "alice");
    expect(result.success).toBe(true);
    expect(readLock(membersDir, "alice")).toBeNull();
  });

  test("fails when no lock exists", () => {
    // Ensure member directory exists but no lock file
    fs.mkdirSync(path.join(membersDir, "alice"), { recursive: true });
    const result = forceRelease(membersDir, "alice");
    expect(result.success).toBe(false);
    expect(result.error).toBe("no lock found");
  });
});

describe("takeover", () => {
  test("acquires lock when no existing lock", () => {
    const result = takeover(membersDir, "alice", 99999, "new-start", "proj-b", "task-2");
    expect(result.success).toBe(true);
    const lock = readLock(membersDir, "alice")!;
    expect(lock.session_pid).toBe(99999);
    expect(lock.project).toBe("proj-b");
  });

  test("fails when lock holder is still alive (current process)", () => {
    // Use the current process PID so isProcessAlive returns true
    const myPid = process.pid;
    // Get actual lstart for this process
    const { execSync } = require("node:child_process");
    const myStart = execSync(`ps -p ${myPid} -o lstart=`, { encoding: "utf-8" }).trim();

    acquireLock(membersDir, "alice", myPid, myStart, "proj-a", "task-1");
    const result = takeover(membersDir, "alice", 88888, "other-start", "proj-b", "task-2");
    expect(result.success).toBe(false);
    expect(result.error).toBe("lock holder is still alive");
  });

  test("succeeds when lock holder process is dead", () => {
    // Use a PID that doesn't exist (very high number)
    acquireLock(membersDir, "alice", 999999999, "ancient-start", "proj-a", "task-1");
    const result = takeover(membersDir, "alice", 88888, "new-start", "proj-b", "task-2");
    expect(result.success).toBe(true);
    const lock = readLock(membersDir, "alice")!;
    expect(lock.session_pid).toBe(88888);
    expect(lock.project).toBe("proj-b");
  });
});
