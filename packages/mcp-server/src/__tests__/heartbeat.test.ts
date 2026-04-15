import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  touchHeartbeat,
  readHeartbeat,
  removeHeartbeat,
  isHeartbeatStale,
  scanStaleHeartbeats,
  HEARTBEAT_TIMEOUT_MS,
} from "../heartbeat.ts";

let tmpDir: string;
let membersDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-test-"));
  membersDir = path.join(tmpDir, "members");
  fs.mkdirSync(membersDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createMemberDir(name: string): void {
  fs.mkdirSync(path.join(membersDir, name), { recursive: true });
}

function writeHeartbeat(name: string, data: Record<string, unknown>): void {
  const hbPath = path.join(membersDir, name, "heartbeat.json");
  fs.writeFileSync(hbPath, JSON.stringify(data), "utf-8");
}

describe("touchHeartbeat", () => {
  test("创建 heartbeat.json", () => {
    createMemberDir("alice");
    touchHeartbeat(membersDir, "alice", 12345, "check_in");

    const hbPath = path.join(membersDir, "alice", "heartbeat.json");
    expect(fs.existsSync(hbPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(hbPath, "utf-8"));
    expect(data.session_pid).toBe(12345);
    expect(data.last_tool).toBe("check_in");
    expect(typeof data.last_seen).toBe("string");
    expect(typeof data.last_seen_ms).toBe("number");
  });

  test("更新已存在的 heartbeat", () => {
    createMemberDir("alice");
    touchHeartbeat(membersDir, "alice", 12345, "activate");

    const hb1 = readHeartbeat(membersDir, "alice");
    expect(hb1!.last_tool).toBe("activate");

    touchHeartbeat(membersDir, "alice", 12345, "save_memory");

    const hb2 = readHeartbeat(membersDir, "alice");
    expect(hb2!.last_tool).toBe("save_memory");
    expect(hb2!.last_seen_ms).toBeGreaterThanOrEqual(hb1!.last_seen_ms);
  });

  test("成员目录不存在时不报错", () => {
    // 不创建目录，直接调用
    expect(() => touchHeartbeat(membersDir, "ghost", 12345, "activate")).not.toThrow();
    expect(readHeartbeat(membersDir, "ghost")).toBeNull();
  });

  test("last_seen_ms 接近当前时间", () => {
    createMemberDir("alice");
    const before = Date.now();
    touchHeartbeat(membersDir, "alice", 99, "test");
    const after = Date.now();

    const hb = readHeartbeat(membersDir, "alice")!;
    expect(hb.last_seen_ms).toBeGreaterThanOrEqual(before);
    expect(hb.last_seen_ms).toBeLessThanOrEqual(after);
  });
});

describe("readHeartbeat", () => {
  test("无文件返回 null", () => {
    createMemberDir("bob");
    expect(readHeartbeat(membersDir, "bob")).toBeNull();
  });

  test("正常读取", () => {
    createMemberDir("bob");
    touchHeartbeat(membersDir, "bob", 111, "activate");

    const hb = readHeartbeat(membersDir, "bob");
    expect(hb).not.toBeNull();
    expect(hb!.session_pid).toBe(111);
    expect(hb!.last_tool).toBe("activate");
  });

  test("损坏文件返回 null", () => {
    createMemberDir("bob");
    fs.writeFileSync(
      path.join(membersDir, "bob", "heartbeat.json"),
      "not json!!!",
      "utf-8"
    );
    expect(readHeartbeat(membersDir, "bob")).toBeNull();
  });
});

describe("removeHeartbeat", () => {
  test("删除已存在的心跳", () => {
    createMemberDir("carol");
    touchHeartbeat(membersDir, "carol", 222, "activate");
    expect(readHeartbeat(membersDir, "carol")).not.toBeNull();

    removeHeartbeat(membersDir, "carol");
    expect(readHeartbeat(membersDir, "carol")).toBeNull();
  });

  test("文件不存在时不报错", () => {
    createMemberDir("carol");
    expect(() => removeHeartbeat(membersDir, "carol")).not.toThrow();
  });

  test("成员目录不存在时不报错", () => {
    expect(() => removeHeartbeat(membersDir, "nobody")).not.toThrow();
  });
});

describe("isHeartbeatStale", () => {
  test("新鲜心跳不过期", () => {
    createMemberDir("dave");
    touchHeartbeat(membersDir, "dave", 333, "check_in");
    expect(isHeartbeatStale(membersDir, "dave")).toBe(false);
  });

  test("过期心跳检测为 stale", () => {
    createMemberDir("dave");
    // 手动写一个过去的时间戳
    writeHeartbeat("dave", {
      last_seen: "2020-01-01T00:00:00.000Z",
      last_seen_ms: new Date("2020-01-01").getTime(),
      session_pid: 333,
      last_tool: "old_tool",
    });
    expect(isHeartbeatStale(membersDir, "dave")).toBe(true);
  });

  test("无心跳文件返回 false（不是过期，是从没上线）", () => {
    createMemberDir("dave");
    expect(isHeartbeatStale(membersDir, "dave")).toBe(false);
  });

  test("自定义超时", () => {
    createMemberDir("dave");
    // 写一个 2 秒前的心跳
    const twoSecondsAgo = Date.now() - 2000;
    writeHeartbeat("dave", {
      last_seen: new Date(twoSecondsAgo).toISOString(),
      last_seen_ms: twoSecondsAgo,
      session_pid: 333,
      last_tool: "test",
    });

    // 1 秒超时 → 应该过期
    expect(isHeartbeatStale(membersDir, "dave", 1000)).toBe(true);
    // 10 秒超时 → 不应该过期
    expect(isHeartbeatStale(membersDir, "dave", 10000)).toBe(false);
  });
});

describe("scanStaleHeartbeats", () => {
  test("空目录返回空数组", () => {
    expect(scanStaleHeartbeats(membersDir)).toEqual([]);
  });

  test("目录不存在返回空数组", () => {
    expect(scanStaleHeartbeats("/nonexistent/path")).toEqual([]);
  });

  test("全部新鲜返回空数组", () => {
    createMemberDir("a");
    createMemberDir("b");
    touchHeartbeat(membersDir, "a", 1, "t1");
    touchHeartbeat(membersDir, "b", 2, "t2");

    expect(scanStaleHeartbeats(membersDir)).toEqual([]);
  });

  test("过期成员被检测出", () => {
    createMemberDir("alive");
    createMemberDir("dead");
    createMemberDir("never");

    touchHeartbeat(membersDir, "alive", 1, "t1");
    writeHeartbeat("dead", {
      last_seen: "2020-01-01T00:00:00.000Z",
      last_seen_ms: new Date("2020-01-01").getTime(),
      session_pid: 2,
      last_tool: "old",
    });
    // "never" 没有心跳文件

    const stale = scanStaleHeartbeats(membersDir);
    expect(stale).toEqual(["dead"]);
  });

  test("自定义超时混合场景", () => {
    createMemberDir("recent");
    createMemberDir("old");

    const fiveSecondsAgo = Date.now() - 5000;
    const oneSecondAgo = Date.now() - 1000;

    writeHeartbeat("old", {
      last_seen: new Date(fiveSecondsAgo).toISOString(),
      last_seen_ms: fiveSecondsAgo,
      session_pid: 1,
      last_tool: "t1",
    });
    writeHeartbeat("recent", {
      last_seen: new Date(oneSecondAgo).toISOString(),
      last_seen_ms: oneSecondAgo,
      session_pid: 2,
      last_tool: "t2",
    });

    // 3 秒超时：old 过期，recent 不过期
    const stale = scanStaleHeartbeats(membersDir, 3000);
    expect(stale).toEqual(["old"]);
  });
});

describe("常量", () => {
  test("HEARTBEAT_TIMEOUT_MS = 3 分钟", () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBe(180000);
  });
});
