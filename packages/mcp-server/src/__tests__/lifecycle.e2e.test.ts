/**
 * lifecycle.e2e.test.ts
 * E2E 测试：成员生命周期
 * hire_temp → request_member → activate → save_memory → submit_experience → deactivate
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const MEMBERS_DIR = path.join(os.homedir(), ".claude", "team-hub", "members");
const TEST_MEMBER = "生命周期测试员";
const TEST_PROJECT = "lifecycle-e2e-test";
const TEST_TASK = "verify lifecycle workflow";
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

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
  // 清理可能残留的测试成员
  cleanupMemberDir(TEST_MEMBER);
});

// ═══════════════════════════════════════════════════════════════════════════
// 完整生命周期流程
// ═══════════════════════════════════════════════════════════════════════════

describe("full member lifecycle", () => {
  let leaderSid: string;
  let memberSid: string;
  let reservationCode: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupMemberDir(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  // 1. hire_temp 雇佣临时成员
  test("1. hire_temp 雇佣临时成员", async () => {
    const data = (await callWith(leaderSid, "hire_temp", {
      caller: LEADER_CALLER,
      name: TEST_MEMBER,
      role: "测试工程师",
      skills: ["testing", "automation"],
      description: "E2E 测试用临时成员",
    })) as { success: boolean; profile: { uid: string; name: string; role: string; type: string } };

    expect(data.success).toBe(true);
    expect(data.profile.name).toBe(TEST_MEMBER);
    expect(data.profile.role).toBe("测试工程师");
    expect(data.profile.type).toBe("temporary");
  });

  // 验证 roster 包含该成员
  test("1b. get_roster 能看到新雇佣的成员", async () => {
    const data = (await callWith(leaderSid, "get_roster", {})) as {
      roster: Array<{ name: string; role: string }>;
    };

    const found = data.roster.find((m) => m.name === TEST_MEMBER);
    expect(found).toBeDefined();
    expect(found!.role).toBe("测试工程师");
  });

  // 2. request_member 预约成员
  test("2. request_member 预约成员", async () => {
    const data = (await callWith(leaderSid, "request_member", {
      caller: LEADER_CALLER,
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: TEST_TASK,
    })) as { reserved: boolean; reservation_code?: string };

    expect(data.reserved).toBe(true);
    expect(data.reservation_code).toBeDefined();
    reservationCode = data.reservation_code!;
  });

  // 3. activate 激活成员
  test("3. activate 激活成员 → 状态变为 working", async () => {
    const data = (await callWith(memberSid, "activate", {
      member: TEST_MEMBER,
      reservation_code: reservationCode,
    })) as {
      identity: { name: string };
      current_task: { project: string; task: string };
    };

    expect(data.identity.name).toBe(TEST_MEMBER);
    expect(data.current_task.project).toBe(TEST_PROJECT);
    expect(data.current_task.task).toBe(TEST_TASK);

    // 验证状态变为 working
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; online: boolean; working: boolean };

    expect(status.online).toBe(true);
    expect(status.working).toBe(true);
    expect(status.status).toBe("working");
  });

  // 4. save_memory 保存记忆
  test("4. save_memory 保存记忆 → 记忆文件存在", async () => {
    const data = (await callWith(memberSid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "lifecycle e2e test memory content",
    })) as { success: boolean };

    expect(data.success).toBe(true);

    // 验证记忆文件存在（generic scope → memory_generic.md）
    const memoryPath = path.join(MEMBERS_DIR, TEST_MEMBER, "memory_generic.md");
    expect(fs.existsSync(memoryPath)).toBe(true);
    const content = fs.readFileSync(memoryPath, "utf-8");
    expect(content).toContain("lifecycle e2e test memory content");
  });

  // 5. submit_experience 提交经验
  test("5. submit_experience 提交经验 → 经验库有记录", async () => {
    const data = (await callWith(memberSid, "submit_experience", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "lifecycle e2e test experience: always run tests before deploy",
    })) as { success: boolean };

    expect(data.success).toBe(true);

    // 验证共享经验库有记录（generic scope → experience_generic.md）
    const sharedExpPath = path.join(
      os.homedir(),
      ".claude",
      "team-hub",
      "shared",
      "experience_generic.md",
    );
    expect(fs.existsSync(sharedExpPath)).toBe(true);
    const expContent = fs.readFileSync(sharedExpPath, "utf-8");
    expect(expContent).toContain("lifecycle e2e test experience");
  });

  // 6. deactivate 下线
  test("6. deactivate 下线 → 状态变为 offline，锁已释放", async () => {
    const data = (await callWith(memberSid, "deactivate", {
      member: TEST_MEMBER,
      note: "lifecycle test done",
    })) as { success: boolean; member: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(TEST_MEMBER);

    // 验证状态变为 offline
    const status = (await callWith(leaderSid, "get_status", {
      member: TEST_MEMBER,
    })) as { status: string; online: boolean; working: boolean };

    expect(status.status).toBe("offline");
    expect(status.online).toBe(false);
    expect(status.working).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 权限校验：成员不能 hire，只有 leader 可以
// ═══════════════════════════════════════════════════════════════════════════

describe("hire_temp permission checks", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
    memberSid = await registerSession("普通成员");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("普通成员调用 hire_temp — 应报错（无权限）", async () => {
    const data = (await callWith(memberSid, "hire_temp", {
      caller: "普通成员",
      name: "违规雇佣",
      role: "nonexistent",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("permission");
  });

  test("有权限的 leader 调用 hire_temp — 应成功", async () => {
    const tempName = "权限测试临时工";
    const data = (await callWith(leaderSid, "hire_temp", {
      caller: LEADER_CALLER,
      name: tempName,
      role: "临时",
    })) as { success: boolean };

    expect(data.success).toBe(true);

    // 清理
    cleanupMemberDir(tempName);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// save_memory 需要先 activate
// ═══════════════════════════════════════════════════════════════════════════

describe("save_memory requires activation", () => {
  let memberSid: string;

  beforeAll(async () => {
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    await safeUnregister(memberSid);
  });

  test("未激活成员调用 save_memory — 应报错", async () => {
    const data = (await callWith(memberSid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "should fail",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("未激活");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deactivate 需要先 save_memory（除非 force=true）
// ═══════════════════════════════════════════════════════════════════════════

describe("deactivate requires save_memory", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);
    // 清理并重新创建成员
    cleanupMemberDir(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupMemberDir(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("未 save_memory 时 deactivate — 应报错（要求先保存）", async () => {
    // 先雇佣 + 预约 + 激活
    await callWith(leaderSid, "hire_temp", {
      caller: LEADER_CALLER,
      name: TEST_MEMBER,
      role: "测试",
    });

    const reqData = (await callWith(leaderSid, "request_member", {
      caller: LEADER_CALLER,
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: TEST_TASK,
    })) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    await callWith(memberSid, "activate", {
      member: TEST_MEMBER,
      reservation_code: reqData.reservation_code,
    });

    // 不 save_memory 直接 deactivate
    const data = (await callWith(memberSid, "deactivate", {
      member: TEST_MEMBER,
    })) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain("save_memory");
  });

  test("force=true 时可跳过 save_memory 直接 deactivate", async () => {
    const data = (await callWith(memberSid, "deactivate", {
      member: TEST_MEMBER,
      force: true,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// submit_experience 需要先 activate
// ═══════════════════════════════════════════════════════════════════════════

describe("submit_experience requires activation", () => {
  let memberSid: string;

  beforeAll(async () => {
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    await safeUnregister(memberSid);
  });

  test("未激活成员调用 submit_experience — 应报错", async () => {
    const data = (await callWith(memberSid, "submit_experience", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "should fail",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("未激活");
  });
});
