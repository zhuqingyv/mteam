/**
 * monitoring.e2e.test.ts
 * E2E 测试：监控与状态系统 (get_status / get_roster / team_report / work_history / stuck_scan / project_dashboard)
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const TEST_MEMBER = "小快";
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
  const data = (await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
    member,
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
  args: Record<string, unknown>
): Promise<unknown> {
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

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. get_status — 返回所有成员状态
// ═══════════════════════════════════════════════════════════════════════════

describe("get_status", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("get_status 不传 member — 返回全员状态数组", async () => {
    const data = (await callWith(leaderSid, "get_status", {})) as Array<{
      uid: string;
      member: string;
      role: string;
      status: string;
      online: boolean;
      working: boolean;
      pending_departure: boolean;
    }>;

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    // 每个成员都有必要字段
    for (const m of data) {
      expect(m).toHaveProperty("uid");
      expect(m).toHaveProperty("member");
      expect(m).toHaveProperty("status");
      expect(m).toHaveProperty("online");
      expect(m).toHaveProperty("working");
      expect(typeof m.member).toBe("string");
      expect(["working", "online", "offline", "pending_departure"]).toContain(
        m.status
      );
    }
  });

  test("get_status 传 member — 返回单个成员状态", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as {
      member: string;
      status: string;
      online: boolean;
      working: boolean;
      pending_departure: boolean;
      profile: unknown;
    };

    expect(data.member).toBe(TEST_MEMBER);
    expect(["working", "online", "offline", "pending_departure"]).toContain(
      data.status
    );
    expect(typeof data.online).toBe("boolean");
    expect(typeof data.working).toBe("boolean");
    expect(typeof data.pending_departure).toBe("boolean");
  });

  test("get_status 传不存在的 member — 返回 offline", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: "不存在的成员xyz",
    })) as { member: string; status: string };

    expect(data.member).toBe("不存在的成员xyz");
    expect(data.status).toBe("offline");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. get_roster — 花名册信息完整
// ═══════════════════════════════════════════════════════════════════════════

describe("get_roster", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("get_roster 返回花名册 + 摘要", async () => {
    const data = (await callWith(leaderSid, "get_roster", {})) as {
      roster: Array<{
        uid: string;
        name: string;
        role: string;
        type: string;
        status: string;
        description: string;
        current_project: string | null;
        current_task: string | null;
        last_seen: string | null;
      }>;
      governance: unknown;
      summary: {
        total: number;
        working: number;
        reserved: number;
        online: number;
        offline: number;
        available_roles: string[];
        hint: string;
      };
    };

    // roster 是数组
    expect(Array.isArray(data.roster)).toBe(true);
    expect(data.roster.length).toBeGreaterThan(0);

    // 每个成员有完整字段
    for (const m of data.roster) {
      expect(m).toHaveProperty("uid");
      expect(m).toHaveProperty("name");
      expect(m).toHaveProperty("role");
      expect(m).toHaveProperty("type");
      expect(m).toHaveProperty("status");
      expect(typeof m.name).toBe("string");
      expect(typeof m.role).toBe("string");
      expect([
        "working",
        "online",
        "offline",
        "reserved",
        "pending_departure",
      ]).toContain(m.status);
    }

    // summary
    expect(data.summary).toHaveProperty("total");
    expect(data.summary.total).toBe(data.roster.length);
    expect(typeof data.summary.hint).toBe("string");

    // governance
    expect(data.governance).toBeDefined();
  });

  test("get_roster 包含已知成员", async () => {
    const data = (await callWith(leaderSid, "get_roster", {})) as {
      roster: Array<{ name: string }>;
    };

    const names = data.roster.map((m) => m.name);
    expect(names).toContain(TEST_MEMBER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. team_report — 报告内容合理
// ═══════════════════════════════════════════════════════════════════════════

describe("team_report", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("team_report 返回 working / idle / total", async () => {
    const data = (await callWith(leaderSid, "team_report", {})) as {
      working: unknown[];
      idle: unknown[];
      total: number;
    };

    expect(Array.isArray(data.working)).toBe(true);
    expect(Array.isArray(data.idle)).toBe(true);
    expect(typeof data.total).toBe("number");
    expect(data.total).toBe(data.working.length + data.idle.length);
    expect(data.total).toBeGreaterThan(0);
  });

  test("working 和 idle 中的成员有 name 和 role", async () => {
    const data = (await callWith(leaderSid, "team_report", {})) as {
      working: Array<{ name: string; role: string; lock?: unknown }>;
      idle: Array<{ name: string; role: string }>;
    };

    for (const m of [...data.working, ...data.idle]) {
      expect(m).toHaveProperty("name");
      expect(m).toHaveProperty("role");
      expect(typeof m.name).toBe("string");
    }

    // working 成员应该有 lock
    for (const m of data.working) {
      expect(m).toHaveProperty("lock");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. work_history — 有 worklog 记录
// ═══════════════════════════════════════════════════════════════════════════

describe("work_history", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");

    // 确保测试成员有 worklog 条目
    const logDir = path.join(MEMBERS_DIR, TEST_MEMBER);
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "work_log.jsonl");
    const testEntry = {
      event: "check_in",
      timestamp: new Date().toISOString(),
      project: "e2e-test-project",
      task: "monitoring test",
      note: "E2E test entry",
    };
    fs.appendFileSync(logPath, JSON.stringify(testEntry) + "\n", "utf-8");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("work_history 返回成员历史记录", async () => {
    const data = (await callWith(leaderSid, "work_history", {
      member: TEST_MEMBER,
    })) as {
      member: string;
      history: Array<{
        event: string;
        timestamp: string;
        project?: string;
        task?: string;
      }>;
    };

    expect(data.member).toBe(TEST_MEMBER);
    expect(Array.isArray(data.history)).toBe(true);
    expect(data.history.length).toBeGreaterThan(0);

    // 检查至少有一条记录有 event 字段
    const hasEvent = data.history.some(
      (h) => typeof h.event === "string" && h.event.length > 0
    );
    expect(hasEvent).toBe(true);
  });

  test("work_history 支持 limit 参数", async () => {
    const data = (await callWith(leaderSid, "work_history", {
      member: TEST_MEMBER,
      limit: 1,
    })) as { history: unknown[] };

    expect(data.history.length).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. stuck_scan — 检测卡住的成员
// ═══════════════════════════════════════════════════════════════════════════

describe("stuck_scan", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("stuck_scan 返回合理结构", async () => {
    const data = (await callWith(leaderSid, "stuck_scan", {})) as {
      stuck: Array<{
        name: string;
        lock: unknown;
        elapsed_minutes: number;
      }>;
      timeout_minutes: number;
    };

    expect(Array.isArray(data.stuck)).toBe(true);
    expect(typeof data.timeout_minutes).toBe("number");
    // 默认超时 120 分钟
    expect(data.timeout_minutes).toBeGreaterThan(0);
  });

  test("stuck_scan 支持自定义 timeout_minutes", async () => {
    const data = (await callWith(leaderSid, "stuck_scan", {
      timeout_minutes: 1,
    })) as {
      stuck: unknown[];
      timeout_minutes: number;
    };

    expect(data.timeout_minutes).toBe(1);
    // stuck 可能为空也可能有成员，取决于当前锁状态
    expect(Array.isArray(data.stuck)).toBe(true);
  });

  test("stuck_scan timeout=0 — 所有持锁成员都算 stuck", async () => {
    const data = (await callWith(leaderSid, "stuck_scan", {
      timeout_minutes: 0,
    })) as {
      stuck: Array<{ name: string; elapsed_minutes: number }>;
      timeout_minutes: number;
    };

    expect(data.timeout_minutes).toBe(0);
    // 如果有人持锁，elapsed_minutes >= 0
    for (const s of data.stuck) {
      expect(s).toHaveProperty("name");
      expect(s).toHaveProperty("elapsed_minutes");
      expect(s.elapsed_minutes).toBeGreaterThanOrEqual(0);
    }
  });

  test("无卡住时返回 hint", async () => {
    // 用很大的 timeout 确保没人 stuck
    const data = (await callWith(leaderSid, "stuck_scan", {
      timeout_minutes: 999999,
    })) as { stuck: unknown[]; hint?: string; action_hint?: string };

    expect(data.stuck.length).toBe(0);
    expect(data.hint).toBeDefined();
    expect(data.hint).toContain("正常");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. project_dashboard — 项目看板
// ═══════════════════════════════════════════════════════════════════════════

describe("project_dashboard", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("project_dashboard 返回项目下成员列表", async () => {
    const data = (await callWith(leaderSid, "project_dashboard", {
      project: "e2e-test-project",
    })) as {
      project: string;
      members: Array<{
        uid: string;
        name: string;
        task: string;
        locked_at: string;
      }>;
    };

    expect(data.project).toBe("e2e-test-project");
    expect(Array.isArray(data.members)).toBe(true);
    // 可能为空（没人在这个项目上工作），结构正确即可
  });

  test("project_dashboard 对不存在的项目 — 返回空成员列表", async () => {
    const data = (await callWith(leaderSid, "project_dashboard", {
      project: "nonexistent-project-xyz-12345",
    })) as { project: string; members: unknown[] };

    expect(data.project).toBe("nonexistent-project-xyz-12345");
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. get_status 与 check_in 联动 — 有锁则 working
// ═══════════════════════════════════════════════════════════════════════════

describe("get_status reflects lock state", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    // 清理锁
    try {
      await callWith(memberSid, "check_out", {
        member: TEST_MEMBER,
        force: true,
      });
    } catch {
      /* ignore */
    }
    await safeUnregister(memberSid);
    await safeUnregister(leaderSid);
  });

  test("check_in 后 get_status 为 working 或 online（取决于心跳）", async () => {
    // check_in 给成员加锁
    const checkInData = (await callWith(memberSid, "check_in", {
      member: TEST_MEMBER,
      project: "monitoring-e2e",
      task: "status linkage test",
    })) as { success: boolean };
    expect(checkInData.success).toBe(true);

    // 查状态
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; working: boolean };

    // 有锁但可能没心跳（未 activate），所以状态可能是 offline 但 working=true
    // 实际上 check_in 会获取锁但不会更新心跳
    expect(status.working).toBe(true);
  });
});
