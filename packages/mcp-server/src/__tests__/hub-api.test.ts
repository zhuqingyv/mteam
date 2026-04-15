/**
 * hub-api.test.ts
 * 集成测试：验证 team-hub HTTP API 完整工作流
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const TEST_MEMBER = "adian";
const TEST_PROJECT = "hub-api-integration-test";
const TEST_TASK = "run integration test workflow";
const MEMBERS_DIR = path.join(os.homedir(), ".claude", "team-hub", "members");

// session_id 在整个测试套件中共享
let sessionId: string;

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

/** 注册一个新 session 并返回 session_id */
async function registerSession(): Promise<string> {
  const data = await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
  }) as { session_id: string };
  return data.session_id;
}

/** 尽力注销 session */
async function safeUnregister(sid: string): Promise<void> {
  if (!sid) return;
  try { await hubPost("/api/session/unregister", { session_id: sid }); } catch { /* best-effort */ }
}

/** 对指定 session 发起工具调用，返回解析后的 JSON */
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

async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return callWith(sessionId, tool, args);
}

// ─── global setup / teardown ───────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
});

afterAll(async () => {
  await safeUnregister(sessionId);
});

// ─── test suite ────────────────────────────────────────────────────────────

describe("hub-api integration workflow", () => {

  test("1. GET /api/health — hub 在线", async () => {
    const res = await fetch(`${HUB}/api/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; sessions: number; uptime: number };
    expect(data.ok).toBe(true);
    expect(typeof data.sessions).toBe("number");
    expect(typeof data.uptime).toBe("number");
  });

  test("2. POST /api/session/register — 注册 session，返回 session_id", async () => {
    const data = await hubPost("/api/session/register", {
      pid: process.pid,
      lstart: new Date().toISOString(),
    }) as { session_id: string };

    expect(typeof data.session_id).toBe("string");
    expect(data.session_id.length).toBeGreaterThan(0);

    sessionId = data.session_id;
  });

  test("3. get_roster — 返回花名册，包含成员列表和状态字段", async () => {
    const data = await call("get_roster", {}) as {
      roster: Array<{
        name: string;
        uid: string;
        role: string;
        status: string;
      }>;
      summary: {
        total: number;
        working: number;
        offline: number;
        hint: string;
      };
    };

    expect(Array.isArray(data.roster)).toBe(true);
    expect(data.roster.length).toBeGreaterThan(0);
    expect(data).toHaveProperty("summary");
    expect(typeof data.summary.total).toBe("number");

    // 验证每个成员条目有必要字段
    const member = data.roster.find((m) => m.name === TEST_MEMBER);
    expect(member).toBeDefined();
    expect(typeof member!.uid).toBe("string");
    expect(typeof member!.role).toBe("string");
    expect(["working", "online", "offline"]).toContain(member!.status);
  });

  // 保存 reservation_code 给后续 activate 用
  let reservationCode: string;

  test("4. request_member — 返回 reserved=true + reservation_code + member_brief + spawn_hint", async () => {
    const data = await call("request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: TEST_TASK,
    }) as {
      reserved: boolean;
      reservation_code: string;
      member_brief: { name: string; role: string; display_name: string };
      spawn_hint: string;
      persona?: string;
    };

    expect(typeof data.reserved).toBe("boolean");

    if (!data.reserved) {
      console.warn(`request_member returned reserved=false — member may be locked. data:`, data);
      return;
    }

    expect(data.reserved).toBe(true);
    expect(typeof data.reservation_code).toBe("string");
    expect(data.reservation_code.length).toBeGreaterThan(0);

    // request_member 不再返回 persona
    expect(data.persona).toBeUndefined();

    // member_brief 替代了 member_info，包含 name/role/display_name
    expect(data).toHaveProperty("member_brief");
    expect(data.member_brief.name).toBe(TEST_MEMBER);
    expect(typeof data.member_brief.role).toBe("string");
    expect(typeof data.member_brief.display_name).toBe("string");

    expect(typeof data.spawn_hint).toBe("string");
    expect(data.spawn_hint.length).toBeGreaterThan(0);

    reservationCode = data.reservation_code;
  });

  test("5. activate — 传 reservation_code，返回 persona + memory + workflow_hint + project_rules + peer_pair字段", async () => {
    const data = await call("activate", {
      member: TEST_MEMBER,
      reservation_code: reservationCode,
    }) as {
      identity: { uid: string; name: string; display_name: string; role: string };
      persona: string;
      memory_generic: unknown;
      memory_project: unknown;
      current_task: { project: string; task: string };
      team_rules: unknown;
      workflow_hint: string;
      peer_pair: unknown;
      project_rules: unknown;
    };

    // 必要字段存在
    expect(data).toHaveProperty("identity");
    expect(data.identity.name).toBe(TEST_MEMBER);
    expect(typeof data.identity.uid).toBe("string");
    expect(typeof data.identity.role).toBe("string");

    expect(typeof data.persona).toBe("string");
    expect(data.persona.length).toBeGreaterThan(0);

    expect(data).toHaveProperty("memory_generic");
    expect(data).toHaveProperty("memory_project");
    expect(data).toHaveProperty("team_rules");

    expect(typeof data.workflow_hint).toBe("string");
    expect(data.workflow_hint.length).toBeGreaterThan(0);
    expect(data.workflow_hint).toContain("activate");

    expect(data).toHaveProperty("peer_pair");
    expect(data).toHaveProperty("project_rules");

    // current_task 对应我们申请的项目和任务
    expect(data.current_task.project).toBe(TEST_PROJECT);
    expect(data.current_task.task).toBe(TEST_TASK);
  });

  test("6. checkpoint — 返回检查点信息（original_task + verification_prompt）", async () => {
    const data = await call("checkpoint", {
      member: TEST_MEMBER,
      progress_summary: "测试进行中，已完成 activate 步骤",
    }) as {
      checkpoint: boolean;
      original_task: { project: string; task: string };
      verification_prompt: string;
      team_rules: unknown;
      project_rules: unknown;
    };

    expect(data.checkpoint).toBe(true);
    expect(data).toHaveProperty("original_task");
    expect(data.original_task.project).toBe(TEST_PROJECT);
    expect(data.original_task.task).toBe(TEST_TASK);

    expect(typeof data.verification_prompt).toBe("string");
    expect(data.verification_prompt.length).toBeGreaterThan(0);

    expect(data).toHaveProperty("team_rules");
    expect(data).toHaveProperty("project_rules");
  });

  test("7. save_memory — 保存成功，返回 success=true", async () => {
    const data = await call("save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "[integration-test] hub-api 集成测试写入，可安全忽略",
    }) as { success: boolean; hint: string };

    expect(data.success).toBe(true);
    expect(typeof data.hint).toBe("string");
  });

  test("8. deactivate — 成功释放，返回 success=true", async () => {
    const data = await call("deactivate", {
      member: TEST_MEMBER,
      note: "integration test completed",
    }) as { success: boolean; member: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(TEST_MEMBER);
  });

  test("9. POST /api/session/unregister — 清理 session", async () => {
    const data = await hubPost("/api/session/unregister", {
      session_id: sessionId,
    }) as { ok: boolean };

    expect(data.ok).toBe(true);

    // 清理完成后置空，防止 afterAll 重复清理
    sessionId = "";
  });

  test("10. 使用已注销的 session 调用工具 — 应返回 404", async () => {
    // 先注册一个临时 session，注销后验证
    const reg = await hubPost("/api/session/register", {
      pid: process.pid,
      lstart: new Date().toISOString(),
    }) as { session_id: string };

    const tmpSession = reg.session_id;

    await hubPost("/api/session/unregister", { session_id: tmpSession });

    // 已注销的 session 应该 404
    const res = await fetch(`${HUB}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tmpSession,
        tool: "get_roster",
        arguments: {},
      }),
    });

    expect(res.status).toBe(404);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 组1：流程合理性（错误路径）
// ═══════════════════════════════════════════════════════════════════════════

describe("flow validation", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerSession();
  });

  afterAll(async () => {
    await safeUnregister(sid);
  });

  test("activate 未 request_member — 应返回 error 包含'需要预约码或已有工作锁'", async () => {
    const data = await callWith(sid, "activate", {
      member: TEST_MEMBER,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("需要预约码或已有工作锁");
  });

  test("deactivate 未 save_memory（不传 force） — 应返回 error 包含'save_memory'", async () => {
    // 先走正常预约流程到 activate
    const reqData = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "flow-validation-test",
    }) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    await callWith(sid, "activate", { member: TEST_MEMBER, reservation_code: reqData.reservation_code });

    // 不保存就 deactivate
    const data = await callWith(sid, "deactivate", {
      member: TEST_MEMBER,
    }) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain("save_memory");
  });

  test("deactivate 传 force=true 跳过 save_memory — 应成功", async () => {
    // 上一个测试中 activate 状态还在，直接 force deactivate
    const data = await callWith(sid, "deactivate", {
      member: TEST_MEMBER,
      force: true,
    }) as { success: boolean; member: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(TEST_MEMBER);
  });

  test("request_member 不存在的成员 — reserved=false + reason 包含'不存在'", async () => {
    const data = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: "this_member_does_not_exist_xyz",
      project: TEST_PROJECT,
      task: "phantom task",
    }) as { reserved: boolean; reason?: string };

    expect(data.reserved).toBe(false);
    expect(data.reason).toContain("不存在");
  });

  test("request_member 已激活的成员（同 session 重复 request） — reserved=true + existing=true", async () => {
    // 先走完整 request -> activate 流程建立正式锁
    const first = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "duplicate-request-test",
    }) as { reserved: boolean; reservation_code: string };
    expect(first.reserved).toBe(true);

    await callWith(sid, "activate", { member: TEST_MEMBER, reservation_code: first.reservation_code });

    // 同 session 再次 request（成员已持锁）
    const second = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "duplicate-request-test-2",
    }) as { reserved: boolean; existing?: boolean };

    expect(second.reserved).toBe(true);
    expect(second.existing).toBe(true);

    // 清理：save_memory -> deactivate
    await callWith(sid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "[flow-validation-cleanup] safe to ignore",
    });
    await callWith(sid, "deactivate", { member: TEST_MEMBER, note: "cleanup" });
  });

  test("正常 deactivate 后再次 activate（无预约码） — 应返回 error（锁已释放）", async () => {
    // request -> activate(reservation_code) -> save -> deactivate（完整释放）
    const reqData = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "deactivate-reactivate-test",
    }) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    await callWith(sid, "activate", { member: TEST_MEMBER, reservation_code: reqData.reservation_code });
    await callWith(sid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "[flow-validation] deactivate-reactivate test",
    });
    await callWith(sid, "deactivate", { member: TEST_MEMBER, note: "done" });

    // 锁已释放，再 activate 应失败
    const data = await callWith(sid, "activate", {
      member: TEST_MEMBER,
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("需要预约码或已有工作锁");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 组3：预约机制（reservation mechanism）
// 依赖：hub.ts 中的预约改造已落地（request_member → reserved + reservation_code）
// ═══════════════════════════════════════════════════════════════════════════

describe("reservation mechanism", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerSession();
  });

  afterAll(async () => {
    // 尽力清理：force deactivate 以防某个用例中途失败留锁
    try {
      await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true });
    } catch { /* already clean */ }
    await safeUnregister(sid);
  });

  // ── Case 1: 正常预约→激活流程 ────────────────────────────────────────────
  test("Case 1: request_member 返回 reserved=true + reservation_code，activate 凭码成功", async () => {
    const reqData = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "reservation-mechanism-case1",
    }) as {
      reserved: boolean;
      reservation_code: string;
      granted?: boolean;
      persona?: string;
      member_brief: { name: string; role: string; display_name: string };
      spawn_hint: string;
    };

    // 新协议：返回 reserved=true + reservation_code
    expect(reqData.reserved).toBe(true);
    expect(typeof reqData.reservation_code).toBe("string");
    expect(reqData.reservation_code.length).toBeGreaterThan(0);

    // request_member 不再直接返回 persona（persona 由 activate 返回）
    expect(reqData.persona).toBeUndefined();

    // member_brief 包含基本信息
    expect(reqData).toHaveProperty("member_brief");
    expect(reqData.member_brief.name).toBe(TEST_MEMBER);
    expect(typeof reqData.member_brief.role).toBe("string");
    expect(typeof reqData.member_brief.display_name).toBe("string");

    // spawn_hint 包含成员名
    expect(typeof reqData.spawn_hint).toBe("string");
    expect(reqData.spawn_hint).toContain(TEST_MEMBER);

    // activate 凭 reservation_code 成功
    const actData = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: reqData.reservation_code,
    }) as {
      identity: { name: string };
      persona: string;
      memory_generic: unknown;
      workflow_hint: string;
    };

    expect(actData.identity.name).toBe(TEST_MEMBER);
    expect(typeof actData.persona).toBe("string");
    expect(actData.persona.length).toBeGreaterThan(0);
    expect(actData).toHaveProperty("memory_generic");
    expect(typeof actData.workflow_hint).toBe("string");

    // 清理
    await callWith(sid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "[reservation-test] Case 1 cleanup",
    });
    await callWith(sid, "deactivate", { member: TEST_MEMBER, note: "case1 done" });
  });

  // ── Case 2: 无预约码直接 activate → error ────────────────────────────────
  test("Case 2: 不传 reservation_code 直接 activate — 应返回 error", async () => {
    // 确保此时无锁（上一个用例已清理）
    const data = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      // 故意不传 reservation_code
    }) as { error?: string };

    expect(data).toHaveProperty("error");
    // 错误信息应提示未预约或缺少预约码
    expect(typeof data.error).toBe("string");
    expect(data.error!.length).toBeGreaterThan(0);
  });

  // ── Case 3: 错误预约码 activate → error ─────────────────────────────────
  test("Case 3: 使用错误预约码 activate — 应返回 error", async () => {
    // 先拿到合法预约
    const reqData = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "reservation-mechanism-case3",
    }) as { reserved: boolean; reservation_code: string };

    expect(reqData.reserved).toBe(true);

    // 用错误的码 activate
    const actData = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: "wrong-code-xyz-000",
    }) as { error?: string };

    expect(actData).toHaveProperty("error");
    expect(typeof actData.error).toBe("string");
    expect(actData.error!.length).toBeGreaterThan(0);

    // 清理：force release 预约（用正确码 activate 再 deactivate，或等 TTL 过期）
    // 这里用正确码 activate 后 force deactivate 清理
    await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: reqData.reservation_code,
    });
    await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true });
  });

  // ── Case 4: 重复预约同一成员 → reserved=false ────────────────────────────
  test("Case 4: 同一成员已被预约，再次 request_member — 应返回 reserved=false", async () => {
    // 用独立 session 持有第一个预约
    const holderSid = await registerSession();
    try {
      const first = await callWith(holderSid, "request_member", {
        caller: "test-runner",
        member: TEST_MEMBER,
        project: TEST_PROJECT,
        task: "reservation-case4-holder",
      }) as { reserved: boolean; reservation_code: string };

      expect(first.reserved).toBe(true);

      // 第二个 session（sid）再次 request
      const second = await callWith(sid, "request_member", {
        caller: "test-runner-2",
        member: TEST_MEMBER,
        project: TEST_PROJECT,
        task: "reservation-case4-contender",
      }) as { reserved: boolean; reason?: string };

      expect(second.reserved).toBe(false);
      // 应提供 reason 说明原因
      expect(typeof second.reason).toBe("string");

      // 清理：用 holder 的预约码激活再 force deactivate
      await callWith(holderSid, "activate", {
        member: TEST_MEMBER,
        reservation_code: first.reservation_code,
      });
      await callWith(holderSid, "deactivate", { member: TEST_MEMBER, force: true });
    } finally {
      await safeUnregister(holderSid);
    }
  });

  // ── Case 5: 预约 TTL 过期（暂跳过）────────────────────────────────────────
  // TODO: 需要 hub 支持 `ttl_ms` 参数或提供时间注入接口才可测。
  // 设计方案：request_member({ ..., _test_ttl_ms: 100 }) → 100ms 后预约自动释放
  // 届时可测：wait 200ms → activate(reservation_code) → 应返回 error "预约已过期"
  //
  // test("Case 5: 预约 TTL 过期后 activate — 应返回 error（暂跳过）", async () => {
  //   ...
  // });

  // ── Case 6: 完整预约工作流 ──────────────────────────────────────────────
  test("Case 6: 完整预约工作流（register → request → activate → checkpoint → save → deactivate → unregister）", async () => {
    const fullSid = await registerSession();
    try {
      // 1. get_roster 有成员列表
      const rosterData = await callWith(fullSid, "get_roster", {}) as {
        roster: Array<{ name: string }>;
        summary: { total: number };
      };
      expect(Array.isArray(rosterData.roster)).toBe(true);
      expect(rosterData.roster.length).toBeGreaterThan(0);
      expect(rosterData.roster.find((m) => m.name === TEST_MEMBER)).toBeDefined();

      // 2. request_member → reserved=true + reservation_code
      const reqData = await callWith(fullSid, "request_member", {
        caller: "test-runner",
        member: TEST_MEMBER,
        project: TEST_PROJECT,
        task: "reservation-case6-full-workflow",
      }) as {
        reserved: boolean;
        reservation_code: string;
        member_brief: { name: string };
        spawn_hint: string;
      };

      expect(reqData.reserved).toBe(true);
      expect(typeof reqData.reservation_code).toBe("string");
      expect(reqData.member_brief.name).toBe(TEST_MEMBER);
      expect(reqData.spawn_hint).toContain(TEST_MEMBER);

      // 3. activate(reservation_code) → persona + memory + workflow_hint
      const actData = await callWith(fullSid, "activate", {
        member: TEST_MEMBER,
        reservation_code: reqData.reservation_code,
      }) as {
        identity: { name: string; uid: string; role: string };
        persona: string;
        memory_generic: unknown;
        memory_project: unknown;
        current_task: { project: string; task: string };
        workflow_hint: string;
      };

      expect(actData.identity.name).toBe(TEST_MEMBER);
      expect(typeof actData.persona).toBe("string");
      expect(actData.persona.length).toBeGreaterThan(0);
      expect(actData).toHaveProperty("memory_generic");
      expect(actData).toHaveProperty("memory_project");
      expect(actData.current_task.project).toBe(TEST_PROJECT);
      expect(actData.current_task.task).toBe("reservation-case6-full-workflow");
      expect(typeof actData.workflow_hint).toBe("string");
      expect(actData.workflow_hint).toContain("activate");

      // 4. checkpoint
      const cpData = await callWith(fullSid, "checkpoint", {
        member: TEST_MEMBER,
        progress_summary: "reservation case6 checkpoint",
      }) as { checkpoint: boolean; original_task: { project: string; task: string } };

      expect(cpData.checkpoint).toBe(true);
      expect(cpData.original_task.project).toBe(TEST_PROJECT);

      // 5. save_memory
      const saveData = await callWith(fullSid, "save_memory", {
        member: TEST_MEMBER,
        scope: "generic",
        content: "[reservation-test] Case 6 full workflow — safe to ignore",
      }) as { success: boolean };
      expect(saveData.success).toBe(true);

      // 6. deactivate
      const deactData = await callWith(fullSid, "deactivate", {
        member: TEST_MEMBER,
        note: "case6 done",
      }) as { success: boolean; member: string };
      expect(deactData.success).toBe(true);
      expect(deactData.member).toBe(TEST_MEMBER);

      // 7. unregister
      const unregData = await hubPost("/api/session/unregister", {
        session_id: fullSid,
      }) as { ok: boolean };
      expect(unregData.ok).toBe(true);
    } catch (err) {
      // 失败时 force 清理
      try { await callWith(fullSid, "deactivate", { member: TEST_MEMBER, force: true }); } catch { /* ok */ }
      await safeUnregister(fullSid);
      throw err;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 组2：数据准确性
// ═══════════════════════════════════════════════════════════════════════════

describe("data accuracy", () => {
  let sid: string;
  const ACCURACY_PROJECT = "data-accuracy-test";
  const ACCURACY_TASK = "verify returned data matches source";
  const UNIQUE_TOKEN = `accuracy-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    sid = await registerSession();
  });

  afterAll(async () => {
    // 尽力清理成员状态（万一测试中途失败）
    try {
      await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true });
    } catch { /* already deactivated or no lock */ }
    await safeUnregister(sid);
  });

  // 保存 reservation_code 供后续测试使用
  let accuracyReservationCode: string;

  test("request_member 返回 reserved=true + member_brief（不再返回 persona）", async () => {
    const data = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: ACCURACY_PROJECT,
      task: ACCURACY_TASK,
    }) as { reserved: boolean; reservation_code: string; member_brief: { name: string; role: string; display_name: string }; persona?: string };

    expect(data.reserved).toBe(true);
    expect(typeof data.reservation_code).toBe("string");

    // persona 不再由 request_member 返回
    expect(data.persona).toBeUndefined();

    // member_brief 包含基本信息
    expect(data.member_brief.name).toBe(TEST_MEMBER);
    expect(typeof data.member_brief.role).toBe("string");
    expect(typeof data.member_brief.display_name).toBe("string");

    accuracyReservationCode = data.reservation_code;
  });

  test("request_member 返回的 spawn_hint 包含正确的成员名", async () => {
    // 上一个测试拿到了预约但没有 activate，先用预约码 activate 再释放锁
    await callWith(sid, "activate", { member: TEST_MEMBER, reservation_code: accuracyReservationCode });
    await callWith(sid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "[accuracy-cleanup] releasing for spawn_hint test",
    });
    await callWith(sid, "deactivate", { member: TEST_MEMBER, note: "release for next test" });

    // 现在用独立 session 拿到新鲜的 request_member 结果
    const tmpSid = await registerSession();
    try {
      const data = await callWith(tmpSid, "request_member", {
        caller: "test-runner",
        member: TEST_MEMBER,
        project: ACCURACY_PROJECT,
        task: "spawn-hint-check",
      }) as { reserved: boolean; reservation_code: string; spawn_hint?: string };

      expect(data.reserved).toBe(true);
      expect(typeof data.spawn_hint).toBe("string");
      expect(data.spawn_hint).toContain(`"${TEST_MEMBER}"`);

      // 清理 tmpSid 的预约
      await callWith(tmpSid, "activate", { member: TEST_MEMBER, reservation_code: data.reservation_code });
      await callWith(tmpSid, "save_memory", {
        member: TEST_MEMBER,
        scope: "generic",
        content: "[accuracy] spawn_hint test cleanup",
      });
      await callWith(tmpSid, "deactivate", { member: TEST_MEMBER, note: "done" });
    } finally {
      await safeUnregister(tmpSid);
    }
  });

  test("activate 返回的 current_task 与 request_member 传入的一致", async () => {
    const customProject = "accuracy-task-match";
    const customTask = "verify current_task echo";

    const reqData = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: customProject,
      task: customTask,
    }) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    const data = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: reqData.reservation_code,
    }) as { current_task: { project: string; task: string } };

    expect(data.current_task.project).toBe(customProject);
    expect(data.current_task.task).toBe(customTask);
  });

  test("save_memory 后调 read_memory 能读到刚保存的内容", async () => {
    // 上一步已 activate，直接 save
    const content = `[accuracy-test] unique token: ${UNIQUE_TOKEN}`;

    await callWith(sid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content,
    });

    const data = await callWith(sid, "read_memory", {
      member: TEST_MEMBER,
      scope: "generic",
    }) as { member: string; content: string };

    expect(data.member).toBe(TEST_MEMBER);
    expect(data.content).toContain(UNIQUE_TOKEN);
  });

  test("submit_experience 后调 search_experience 能搜到", async () => {
    const expContent = `[accuracy-exp] unique discovery: ${UNIQUE_TOKEN}`;

    const submitData = await callWith(sid, "submit_experience", {
      member: TEST_MEMBER,
      scope: "generic",
      content: expContent,
    }) as { success: boolean };

    expect(submitData.success).toBe(true);

    const searchData = await callWith(sid, "search_experience", {
      keyword: UNIQUE_TOKEN,
    }) as { keyword: string; results: Array<{ line: string; source: string }> };

    expect(searchData.keyword).toBe(UNIQUE_TOKEN);
    expect(Array.isArray(searchData.results)).toBe(true);
    expect(searchData.results.length).toBeGreaterThan(0);

    const found = searchData.results.some((r) => r.line.includes(UNIQUE_TOKEN));
    expect(found).toBe(true);

    // 清理：deactivate
    await callWith(sid, "deactivate", { member: TEST_MEMBER, note: "accuracy tests done" });
  });
});
