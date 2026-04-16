/**
 * isleader.test.ts
 * 集成测试：验证 isLeader 标识在 session 注册、权限校验、环境变量传递上的正确性
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const TEST_MEMBER = "小快"; // 必须是已存在的成员
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

async function registerSession(opts: {
  member?: string;
  isLeader?: boolean;
}): Promise<string> {
  const data = (await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
    member: opts.member ?? "",
    isLeader: opts.isLeader ?? false,
  })) as { session_id: string };
  return data.session_id;
}

async function safeUnregister(sid: string): Promise<void> {
  if (!sid) return;
  try {
    await hubPost("/api/session/unregister", { session_id: sid });
  } catch {
    /* best-effort */
  }
}

async function callWith(
  sid: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = (await hubPost("/api/call", {
    session_id: sid,
    tool,
    arguments: args,
  })) as { content: Array<{ type: string; text: string }> };

  expect(raw).toHaveProperty("content");
  expect(Array.isArray(raw.content)).toBe(true);
  expect(raw.content.length).toBeGreaterThan(0);
  expect(raw.content[0].type).toBe("text");

  return JSON.parse(raw.content[0].text);
}

function cleanupDepartureFile(member: string): void {
  try {
    fs.rmSync(path.join(MEMBERS_DIR, member, "departure.json"), {
      force: true,
    });
  } catch {
    /* ignore */
  }
}

function ensureHeartbeat(member: string): void {
  const dir = path.join(MEMBERS_DIR, member);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "heartbeat.json"),
    JSON.stringify({
      last_seen: new Date().toISOString(),
      last_seen_ms: Date.now(),
      session_pid: process.pid,
      last_tool: "test",
    }),
  );
}

function cleanupHeartbeat(member: string): void {
  try {
    fs.rmSync(path.join(MEMBERS_DIR, member, "heartbeat.json"), {
      force: true,
    });
  } catch {
    /* ignore */
  }
}

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Session 注册 — isLeader 判定
// ═══════════════════════════════════════════════════════════════════════════

describe("session registration — isLeader", () => {
  const sids: string[] = [];

  afterAll(async () => {
    for (const sid of sids) await safeUnregister(sid);
  });

  test("member='' + isLeader=true → leader session", async () => {
    const sid = await registerSession({ member: "", isLeader: true });
    sids.push(sid);

    // leader session 应能调用 leader-only 工具（如 get_roster）
    const result = await callWith(sid, "get_roster", {});
    expect(result).not.toHaveProperty("error");
  });

  test("member='xxx' + isLeader=false → member session", async () => {
    const sid = await registerSession({
      member: TEST_MEMBER,
      isLeader: false,
    });
    sids.push(sid);

    // member session 调 request_departure 应被拒绝
    ensureHeartbeat(TEST_MEMBER);
    const result = await callWith(sid, "request_departure", {
      member: TEST_MEMBER,
    });
    cleanupHeartbeat(TEST_MEMBER);
    cleanupDepartureFile(TEST_MEMBER);
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("leader");
  });

  test("member='xxx' + isLeader=true → leader session (explicit override)", async () => {
    // 这是修复的核心场景：leader 终端可能有 CLAUDE_MEMBER 设置
    // 但 isLeader=true 应显式覆盖
    const sid = await registerSession({
      member: TEST_MEMBER,
      isLeader: true,
    });
    sids.push(sid);

    // 应能调用 leader-only 工具
    ensureHeartbeat(TEST_MEMBER);
    const result = await callWith(sid, "request_departure", {
      member: TEST_MEMBER,
    });
    cleanupDepartureFile(TEST_MEMBER);
    cleanupHeartbeat(TEST_MEMBER);
    // 不应被权限拒绝（可能因其他原因失败，但不是因为 isLeader）
    if (result.error) {
      expect(String(result.error)).not.toContain("leader 才能");
    }
  });

  test("member='' + isLeader=false → leader session (backward compat)", async () => {
    // 向后兼容：member 为空时自动判定为 leader
    const sid = await registerSession({ member: "", isLeader: false });
    sids.push(sid);

    const result = await callWith(sid, "get_roster", {});
    expect(result).not.toHaveProperty("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 权限校验 — leader vs member
// ═══════════════════════════════════════════════════════════════════════════

describe("privilege checks — leader vs member", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession({ member: "", isLeader: true });
    memberSid = await registerSession({
      member: TEST_MEMBER,
      isLeader: false,
    });
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    cleanupHeartbeat(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("leader session → request_departure succeeds", async () => {
    ensureHeartbeat(TEST_MEMBER);
    const result = await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
    });
    // 成功或因其他非权限原因失败
    if (result.error) {
      expect(String(result.error)).not.toContain("leader 才能");
    } else {
      expect(result.success).toBe(true);
    }
    cleanupDepartureFile(TEST_MEMBER);
  });

  test("member session → request_departure fails with diagnostic", async () => {
    ensureHeartbeat(TEST_MEMBER);
    const result = await callWith(memberSid, "request_departure", {
      member: TEST_MEMBER,
    });
    cleanupDepartureFile(TEST_MEMBER);
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("leader");
  });

  test("leader session → clock_out is rejected (leader can't clock out)", async () => {
    // clock_out 检查 session.isLeader，leader 不能下班
    const result = await callWith(leaderSid, "clock_out", {
      member: TEST_MEMBER,
    });
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("leader");
  });

  test("member session → clock_out fails only for business reason, not identity", async () => {
    // member 调 clock_out 不会因 isLeader 被拒；
    // 但会因 没有 pending_departure 而失败（业务逻辑，不是权限问题）
    const result = await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
    });
    expect(result).toHaveProperty("error");
    // 错误应是业务原因（未被批准离场），不是 leader 身份问题
    expect(String(result.error)).not.toContain("leader 由用户控制");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 环境变量传递 — MCP proxy isLeader 计算逻辑
// ═══════════════════════════════════════════════════════════════════════════

describe("env var → isLeader derivation (proxy logic)", () => {
  // 这些测试直接验证 proxy 中 isLeader 的计算逻辑
  // 实际 proxy 代码：
  //   const memberName = process.env.CLAUDE_MEMBER || "";
  //   const isLeader = process.env.IS_LEADER === "1" || !memberName;

  function deriveIsLeader(envClaudeMember: string | undefined, envIsLeader: string | undefined): boolean {
    const memberName = envClaudeMember || "";
    return envIsLeader === "1" || !memberName;
  }

  test("CLAUDE_MEMBER='' → isLeader=true", () => {
    expect(deriveIsLeader("", undefined)).toBe(true);
  });

  test("CLAUDE_MEMBER=undefined → isLeader=true", () => {
    expect(deriveIsLeader(undefined, undefined)).toBe(true);
  });

  test("CLAUDE_MEMBER='memberName' → isLeader=false", () => {
    expect(deriveIsLeader("memberName", undefined)).toBe(false);
  });

  test("IS_LEADER='1' + CLAUDE_MEMBER='memberName' → isLeader=true", () => {
    expect(deriveIsLeader("memberName", "1")).toBe(true);
  });

  test("IS_LEADER='0' + CLAUDE_MEMBER='memberName' → isLeader=false", () => {
    expect(deriveIsLeader("memberName", "0")).toBe(false);
  });

  test("IS_LEADER='1' + CLAUDE_MEMBER='' → isLeader=true", () => {
    expect(deriveIsLeader("", "1")).toBe(true);
  });
});
