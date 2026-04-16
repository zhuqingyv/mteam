/**
 * departure.e2e.test.ts
 * E2E 测试：离场系统完整流程
 * hire → activate → request_departure → clock_out → 验证状态
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const MEMBERS_DIR = path.join(os.homedir(), ".claude", "team-hub", "members");
const TEST_MEMBER = "离场测试员";
const TEST_PROJECT = "departure-e2e-test";
const TEST_TASK = "verify departure workflow";
// 使用真实有权限的 caller（郭总 role=总控，通过 checkPrivilege）
const LEADER_CALLER = "郭总";

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
  args: Record<string, unknown>,
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

function cleanupMemberDir(member: string): void {
  const dir = path.join(MEMBERS_DIR, member);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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

/**
 * 完整的 hire → request_member → activate 流水线
 */
async function setupActiveMember(
  member: string,
): Promise<{ leaderSid: string; memberSid: string }> {
  const leaderSid = await registerSession("");
  const memberSid = await registerSession(member);

  // hire_temp
  await callWith(leaderSid, "hire_temp", {
    caller: LEADER_CALLER,
    name: member,
    role: "测试",
  });

  // request_member
  const reqData = (await callWith(leaderSid, "request_member", {
    caller: LEADER_CALLER,
    member,
    project: TEST_PROJECT,
    task: TEST_TASK,
  })) as { reserved: boolean; reservation_code: string };

  if (!reqData.reserved) {
    throw new Error(`request_member failed for ${member}: ${JSON.stringify(reqData)}`);
  }

  // activate
  await callWith(memberSid, "activate", {
    member,
    reservation_code: reqData.reservation_code,
  });

  return { leaderSid, memberSid };
}

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
  cleanupMemberDir(TEST_MEMBER);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. 完整离场流程：hire → activate → request_departure → clock_out
// ═══════════════════════════════════════════════════════════════════════════

describe("complete departure flow", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    cleanupMemberDir(TEST_MEMBER);
    const sids = await setupActiveMember(TEST_MEMBER);
    leaderSid = sids.leaderSid;
    memberSid = sids.memberSid;
  });

  afterAll(async () => {
    cleanupMemberDir(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("成员激活后状态为 working", async () => {
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; online: boolean; working: boolean };

    expect(status.status).toBe("working");
    expect(status.online).toBe(true);
    expect(status.working).toBe(true);
  });

  test("leader 发起 request_departure — 成功", async () => {
    const data = (await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
      requirement: "请先保存代码再下班",
    })) as { success: boolean; status: string };

    expect(data.success).toBe(true);
    expect(data.status).toBe("pending_departure");
  });

  test("request_departure 后状态变为 pending_departure", async () => {
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; pending_departure: boolean };

    expect(status.status).toBe("pending_departure");
    expect(status.pending_departure).toBe(true);
  });

  test("departure.json 已写入且包含 requirement", () => {
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    expect(fs.existsSync(depPath)).toBe(true);
    const dep = JSON.parse(fs.readFileSync(depPath, "utf-8"));
    expect(dep.pending).toBe(true);
    expect(dep.requirement).toBe("请先保存代码再下班");
  });

  test("成员 save_memory 后 clock_out — 成功下班", async () => {
    // 先保存记忆（clock_out 前的正常收尾）
    await callWith(memberSid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "departure e2e test memory",
    });

    const data = (await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
      note: "收尾完成，正常下班",
    })) as { success: boolean; status: string };

    expect(data.success).toBe(true);
    expect(data.status).toBe("offline");
  });

  test("clock_out 后状态变为 offline", async () => {
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; online: boolean; working: boolean; pending_departure: boolean };

    expect(status.status).toBe("offline");
    expect(status.online).toBe(false);
    expect(status.working).toBe(false);
    expect(status.pending_departure).toBe(false);
  });

  test("clock_out 后 departure.json 已清理", () => {
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    expect(fs.existsSync(depPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 撤销流程：request_departure → request_departure(pending=false) → 恢复 working
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel departure flow", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    cleanupMemberDir(TEST_MEMBER);
    const sids = await setupActiveMember(TEST_MEMBER);
    leaderSid = sids.leaderSid;
    memberSid = sids.memberSid;
  });

  afterAll(async () => {
    cleanupMemberDir(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("发起离场请求", async () => {
    const data = (await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
      requirement: "收尾",
    })) as { success: boolean };

    expect(data.success).toBe(true);

    // 确认状态为 pending_departure
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string };
    expect(status.status).toBe("pending_departure");
  });

  test("撤销离场请求 — pending=false", async () => {
    const data = (await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
      pending: false,
    })) as { success: boolean; status: string };

    expect(data.success).toBe(true);
    expect(data.status).toBe("working");
  });

  test("撤销后状态恢复为 working", async () => {
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; pending_departure: boolean };

    expect(status.status).toBe("working");
    expect(status.pending_departure).toBe(false);
  });

  test("撤销后 departure.json 已删除", () => {
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    expect(fs.existsSync(depPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 权限拦截：成员调 request_departure → 报错
// ═══════════════════════════════════════════════════════════════════════════

describe("request_departure permission: member cannot call", () => {
  let memberSid: string;

  beforeAll(async () => {
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    await safeUnregister(memberSid);
  });

  test("成员调用 request_departure — 应报错", async () => {
    const data = (await callWith(memberSid, "request_departure", {
      member: TEST_MEMBER,
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("leader");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. 权限拦截：leader 调 clock_out → 报错
// ═══════════════════════════════════════════════════════════════════════════

describe("clock_out permission: leader cannot call", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("leader 调用 clock_out — 应报错", async () => {
    const data = (await callWith(leaderSid, "clock_out", {
      member: TEST_MEMBER,
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("leader");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. 身份校验：成员 A 调 clock_out(member=B) → 报错
// ═══════════════════════════════════════════════════════════════════════════

describe("clock_out identity: member A cannot clock_out as B", () => {
  let memberASid: string;

  beforeAll(async () => {
    memberASid = await registerSession("成员A");
  });

  afterAll(async () => {
    await safeUnregister(memberASid);
  });

  test("成员A 调用 clock_out(member=成员B) — 应报错", async () => {
    const data = (await callWith(memberASid, "clock_out", {
      member: "成员B",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("自己");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 非待离场状态调 clock_out → 报错
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
    const data = (await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("未被批准离场");
  });
});
