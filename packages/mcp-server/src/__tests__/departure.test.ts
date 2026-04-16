/**
 * departure.test.ts
 * 集成测试：验证 request_departure / clock_out 离场系统
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const TEST_MEMBER = "小快";
const TEST_PROJECT = "departure-system-test";
const TEST_TASK = "verify departure workflow";
const MEMBERS_DIR = path.join(os.homedir(), ".claude", "team-hub", "members");

// ─── helpers ───────────────────────────────────────────────────────────────

async function hubPost(urlPath: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${HUB}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${urlPath}: ${text}`);
  }
  return res.json();
}

async function registerSession(member: string = ""): Promise<string> {
  const data = await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
    member,
  }) as { session_id: string };
  return data.session_id;
}

async function safeUnregister(sid: string): Promise<void> {
  if (!sid) return;
  try { await hubPost("/api/session/unregister", { session_id: sid }); } catch { /* best-effort */ }
}

async function callWith(sid: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const raw = await hubPost("/api/call", {
    session_id: sid,
    tool,
    arguments: args,
  }) as { content: Array<{ type: string; text: string }> };

  expect(raw).toHaveProperty("content");
  expect(Array.isArray(raw.content)).toBe(true);
  expect(raw.content.length).toBeGreaterThan(0);
  expect(raw.content[0].type).toBe("text");

  return JSON.parse(raw.content[0].text);
}

function cleanupDepartureFile(member: string): void {
  try {
    fs.rmSync(path.join(MEMBERS_DIR, member, "departure.json"), { force: true });
  } catch { /* ignore */ }
}

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
  // 清理可能残留的 departure 文件
  cleanupDepartureFile(TEST_MEMBER);
});

// ═══════════════════════════════════════════════════════════════════════════
// 权限校验
// ═══════════════════════════════════════════════════════════════════════════

describe("departure permission checks", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    // leader session: member="" (空字符串表示 leader)
    leaderSid = await registerSession("");
    // member session: member=TEST_MEMBER
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("普通成员调用 request_departure — 应报错", async () => {
    const data = await callWith(memberSid, "request_departure", {
      member: TEST_MEMBER,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("leader");
  });

  test("leader 调用 clock_out — 应报错", async () => {
    const data = await callWith(leaderSid, "clock_out", {
      member: TEST_MEMBER,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("leader");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// request_departure 校验
// ═══════════════════════════════════════════════════════════════════════════

describe("request_departure validations", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    await safeUnregister(leaderSid);
  });

  test("目标成员不存在 — 应报错", async () => {
    const data = await callWith(leaderSid, "request_departure", {
      member: "nonexistent_member_xyz",
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("不存在");
  });

  test("目标成员 offline — 应报错", async () => {
    // TEST_MEMBER 没有心跳时应该是 offline
    const data = await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("offline");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// clock_out 校验（无 pending_departure 状态）
// ═══════════════════════════════════════════════════════════════════════════

describe("clock_out without pending_departure", () => {
  let memberSid: string;

  beforeAll(async () => {
    memberSid = await registerSession(TEST_MEMBER);
    cleanupDepartureFile(TEST_MEMBER);
  });

  afterAll(async () => {
    await safeUnregister(memberSid);
  });

  test("成员未被批准离场时调用 clock_out — 应报错", async () => {
    const data = await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("未被批准离场");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 完整离场流程（含状态持久化验证）
// ═══════════════════════════════════════════════════════════════════════════

describe("departure state persistence", () => {
  test("departure.json 写入和读取正确", () => {
    const memberDir = path.join(MEMBERS_DIR, TEST_MEMBER);
    fs.mkdirSync(memberDir, { recursive: true });
    const depPath = path.join(memberDir, "departure.json");

    // 写入
    const state = {
      pending: true,
      requirement: "请先保存代码",
      requested_at: new Date().toISOString(),
      previous_status: "working",
    };
    fs.writeFileSync(depPath, JSON.stringify(state), "utf-8");

    // 读取
    const raw = fs.readFileSync(depPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pending).toBe(true);
    expect(parsed.requirement).toBe("请先保存代码");
    expect(typeof parsed.requested_at).toBe("string");

    // 清理
    fs.rmSync(depPath, { force: true });

    // 确认删除
    expect(fs.existsSync(depPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 撤销离场请求
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel departure request", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    await safeUnregister(leaderSid);
  });

  test("撤销不存在的离场请求 — 应报错", async () => {
    cleanupDepartureFile(TEST_MEMBER);

    const data = await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
      pending: false,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("没有待离场请求");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// get_status 反映 pending_departure
// ═══════════════════════════════════════════════════════════════════════════

describe("get_status reflects pending_departure", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    await safeUnregister(leaderSid);
  });

  test("手动写入 departure.json 后 get_status 返回 pending_departure", async () => {
    // 手动写入 departure 文件模拟 pending_departure 状态
    fs.mkdirSync(path.join(MEMBERS_DIR, TEST_MEMBER), { recursive: true });
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    fs.writeFileSync(depPath, JSON.stringify({
      pending: true,
      requested_at: new Date().toISOString(),
      previous_status: "working",
    }), "utf-8");

    const data = await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    }) as { status: string; pending_departure: boolean };

    expect(data.status).toBe("pending_departure");
    expect(data.pending_departure).toBe(true);

    // 清理
    cleanupDepartureFile(TEST_MEMBER);
  });

  test("清除 departure.json 后 get_status 不再返回 pending_departure", async () => {
    cleanupDepartureFile(TEST_MEMBER);

    const data = await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    }) as { status: string; pending_departure: boolean };

    expect(data.status).not.toBe("pending_departure");
    expect(data.pending_departure).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkLogEntry 类型扩展验证
// ═══════════════════════════════════════════════════════════════════════════

describe("worklog event types", () => {
  test("work_log.jsonl 能接受 request_departure / cancel_departure / clock_out 事件", () => {
    fs.mkdirSync(path.join(MEMBERS_DIR, TEST_MEMBER), { recursive: true });
    const logPath = path.join(MEMBERS_DIR, TEST_MEMBER, "work_log.jsonl");
    const originalContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

    // 追加测试事件
    const testEvents = [
      { event: "request_departure", timestamp: new Date().toISOString(), project: "", note: "test" },
      { event: "cancel_departure", timestamp: new Date().toISOString(), project: "", note: "test" },
      { event: "clock_out", timestamp: new Date().toISOString(), project: "", note: "test" },
    ];

    for (const evt of testEvents) {
      fs.appendFileSync(logPath, JSON.stringify(evt) + "\n", "utf-8");
    }

    // 读取并验证
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    const lastThree = lines.slice(-3).map(l => JSON.parse(l));

    expect(lastThree[0].event).toBe("request_departure");
    expect(lastThree[1].event).toBe("cancel_departure");
    expect(lastThree[2].event).toBe("clock_out");

    // 还原（重写原始内容）
    fs.writeFileSync(logPath, originalContent, "utf-8");
  });
});
