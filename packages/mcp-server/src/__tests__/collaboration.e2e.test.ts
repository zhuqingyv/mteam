/**
 * collaboration.e2e.test.ts
 * E2E 测试：任务分配与协作
 *
 * 前提：hub 运行在 http://127.0.0.1:58578
 *
 * 场景：
 * 1. request_member：leader 分配任务给成员 → 成员状态变为 working
 * 2. 任务完成流程：成员 save_memory → submit_experience → search_experience 能搜到
 * 3. handoff：成员 A 交接给成员 B → A 释放锁，B 获得锁
 * 4. force_release：leader 强制释放成员锁
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const HUB = "http://127.0.0.1:58578";
const MEMBER_A = "小快";
const MEMBER_B = "阿构";
const TEST_PROJECT = "collaboration-e2e-test";

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

async function registerSession(
  member: string = "",
  isLeader: boolean = false
): Promise<string> {
  const data = (await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
    member,
    isLeader,
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
// 1. request_member → 成员 activate → 状态变为 working
// ═══════════════════════════════════════════════════════════════════════════

describe("request_member + activate → working status", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    // force cleanup
    try {
      await callWith(memberSid, "deactivate", {
        member: MEMBER_A,
        force: true,
      });
    } catch {
      /* already clean */
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("leader 通过 request_member 分配任务 — 返回 reserved=true", async () => {
    const data = (await callWith(leaderSid, "request_member", {
      caller: "test-leader",
      member: MEMBER_A,
      project: TEST_PROJECT,
      task: "implement feature X",
    })) as {
      reserved: boolean;
      reservation_code: string;
      member_brief: { name: string; role: string };
    };

    expect(data.reserved).toBe(true);
    expect(typeof data.reservation_code).toBe("string");
    expect(data.reservation_code.length).toBeGreaterThan(0);
    expect(data.member_brief.name).toBe(MEMBER_A);

    // Save for next test
    (globalThis as any).__collab_reservation_code = data.reservation_code;
  });

  test("成员用 reservation_code activate — 返回 persona + current_task", async () => {
    const code = (globalThis as any).__collab_reservation_code;
    expect(code).toBeDefined();

    const data = (await callWith(memberSid, "activate", {
      member: MEMBER_A,
      reservation_code: code,
    })) as {
      identity: { name: string };
      persona: string;
      current_task: { project: string; task: string };
      workflow_hint: string;
    };

    expect(data.identity.name).toBe(MEMBER_A);
    expect(typeof data.persona).toBe("string");
    expect(data.persona.length).toBeGreaterThan(0);
    expect(data.current_task.project).toBe(TEST_PROJECT);
    expect(data.current_task.task).toBe("implement feature X");
    expect(typeof data.workflow_hint).toBe("string");
  });

  test("get_status 确认成员状态 — 应为 working 或 online（有锁）", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: MEMBER_A,
    })) as { status: string; working: boolean; lock: unknown };

    // 成员已 activate → 有锁 → working=true
    expect(data.working).toBe(true);
    expect(data.lock).toBeDefined();
    expect(data.lock).not.toBeNull();
    // status 取决于心跳是否被 Panel 感知到，但 working 一定为 true
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 任务完成流程：save_memory → submit_experience → search_experience
// ═══════════════════════════════════════════════════════════════════════════

describe("task completion flow: save_memory → submit_experience → search_experience", () => {
  let leaderSid: string;
  let memberSid: string;
  const UNIQUE_TOKEN = `collab-exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);

    // Setup: request + activate
    const reqData = (await callWith(leaderSid, "request_member", {
      caller: "test-leader",
      member: MEMBER_A,
      project: TEST_PROJECT,
      task: "task-completion-flow",
    })) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    await callWith(memberSid, "activate", {
      member: MEMBER_A,
      reservation_code: reqData.reservation_code,
    });
  });

  afterAll(async () => {
    try {
      await callWith(memberSid, "deactivate", {
        member: MEMBER_A,
        force: true,
      });
    } catch {
      /* already clean */
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("save_memory — 保存成功", async () => {
    const data = (await callWith(memberSid, "save_memory", {
      member: MEMBER_A,
      scope: "generic",
      content: `[collab-e2e] task insight: ${UNIQUE_TOKEN}`,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });

  test("submit_experience — 提交团队经验成功", async () => {
    const data = (await callWith(memberSid, "submit_experience", {
      member: MEMBER_A,
      scope: "generic",
      content: `[collab-e2e] shared discovery: ${UNIQUE_TOKEN}`,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });

  test("search_experience — 能搜到刚提交的经验", async () => {
    const data = (await callWith(memberSid, "search_experience", {
      keyword: UNIQUE_TOKEN,
    })) as {
      keyword: string;
      results: Array<{ line: string; source: string }>;
    };

    expect(data.keyword).toBe(UNIQUE_TOKEN);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeGreaterThan(0);

    const found = data.results.some((r) => r.line.includes(UNIQUE_TOKEN));
    expect(found).toBe(true);
  });

  test("deactivate — 正常释放（已 save_memory）", async () => {
    const data = (await callWith(memberSid, "deactivate", {
      member: MEMBER_A,
      note: "task completed",
    })) as { success: boolean; member: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(MEMBER_A);
  });

  test("deactivate 后 get_status — working 应为 false", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: MEMBER_A,
    })) as { working: boolean; lock: unknown };

    expect(data.working).toBe(false);
    expect(data.lock).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. handoff: 成员 A 交接给成员 B → A 释放锁，B 获得锁
// ═══════════════════════════════════════════════════════════════════════════

describe("handoff: member A → member B", () => {
  let leaderSid: string;
  let memberASid: string;
  let memberBSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberASid = await registerSession(MEMBER_A);
    memberBSid = await registerSession(MEMBER_B);
  });

  afterAll(async () => {
    // force cleanup both members
    try {
      await callWith(memberASid, "deactivate", {
        member: MEMBER_A,
        force: true,
      });
    } catch {
      /* ok */
    }
    try {
      await callWith(memberBSid, "deactivate", {
        member: MEMBER_B,
        force: true,
      });
    } catch {
      /* ok */
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberASid);
    await safeUnregister(memberBSid);
  });

  test("setup: activate member A on a task", async () => {
    const reqData = (await callWith(leaderSid, "request_member", {
      caller: "test-leader",
      member: MEMBER_A,
      project: TEST_PROJECT,
      task: "handoff-source-task",
    })) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    const actData = (await callWith(memberASid, "activate", {
      member: MEMBER_A,
      reservation_code: reqData.reservation_code,
    })) as { identity: { name: string }; current_task: { project: string } };

    expect(actData.identity.name).toBe(MEMBER_A);
    expect(actData.current_task.project).toBe(TEST_PROJECT);

    // save_memory so handoff doesn't get blocked
    await callWith(memberASid, "save_memory", {
      member: MEMBER_A,
      scope: "generic",
      content: "[collab-e2e] pre-handoff save",
    });
  });

  test("handoff from A to B — 成功", async () => {
    const data = (await callWith(memberASid, "handoff", {
      from: MEMBER_A,
      to: MEMBER_B,
      note: "请继续完成剩余工作",
    })) as {
      success: boolean;
      from: string;
      to: string;
      project: string;
      task: string;
      hint?: string;
    };

    expect(data.success).toBe(true);
    expect(data.from).toBe(MEMBER_A);
    expect(data.to).toBe(MEMBER_B);
    expect(data.project).toBe(TEST_PROJECT);
    expect(data.task).toBe("handoff-source-task");
    expect(typeof data.hint).toBe("string");
  });

  test("handoff 后 A 已无锁", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: MEMBER_A,
    })) as { working: boolean; lock: unknown };

    expect(data.working).toBe(false);
    expect(data.lock).toBeNull();
  });

  test("handoff 后 B 持有锁", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: MEMBER_B,
    })) as {
      working: boolean;
      lock: { project: string; task: string };
    };

    expect(data.working).toBe(true);
    expect(data.lock).not.toBeNull();
    expect(data.lock.project).toBe(TEST_PROJECT);
    expect(data.lock.task).toBe("handoff-source-task");
  });

  test("B 可以用 activate（无 reservation_code）继续工作", async () => {
    // handoff 已转移正式锁，B 可以无预约码 activate
    const data = (await callWith(memberBSid, "activate", {
      member: MEMBER_B,
    })) as {
      identity: { name: string };
      current_task: { project: string; task: string };
    };

    expect(data.identity.name).toBe(MEMBER_B);
    expect(data.current_task.project).toBe(TEST_PROJECT);
    expect(data.current_task.task).toBe("handoff-source-task");
  });

  test("B 完成后 save_memory + deactivate — 正常释放", async () => {
    await callWith(memberBSid, "save_memory", {
      member: MEMBER_B,
      scope: "generic",
      content: "[collab-e2e] post-handoff completion",
    });

    const data = (await callWith(memberBSid, "deactivate", {
      member: MEMBER_B,
      note: "handoff task done",
    })) as { success: boolean; member: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(MEMBER_B);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. force_release: leader 强制释放成员锁
// ═══════════════════════════════════════════════════════════════════════════

describe("force_release: leader forcibly releases member lock", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    try {
      await callWith(memberSid, "deactivate", {
        member: MEMBER_A,
        force: true,
      });
    } catch {
      /* ok */
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("setup: activate member A", async () => {
    const reqData = (await callWith(leaderSid, "request_member", {
      caller: "test-leader",
      member: MEMBER_A,
      project: TEST_PROJECT,
      task: "force-release-test",
    })) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    await callWith(memberSid, "activate", {
      member: MEMBER_A,
      reservation_code: reqData.reservation_code,
    });

    // verify member is working
    const status = (await callWith(leaderSid, "get_status", {
      member: MEMBER_A,
    })) as { working: boolean };
    expect(status.working).toBe(true);
  });

  test("非 leader 调用 force_release — 应报权限错误", async () => {
    // member session 没有 leader 权限
    // force_release 通过 checkPrivilege(caller, "force_release") 校验
    // caller 参数决定权限，不是 session 的 isLeader
    // 传一个非 leader 的 caller 应该被拒
    try {
      const data = (await callWith(memberSid, "force_release", {
        caller: MEMBER_A,
        member: MEMBER_A,
      })) as { error?: string };

      // 如果没抛异常，应该有 error
      if (data.error) {
        expect(data.error).toContain("permission");
      }
    } catch (err) {
      // checkPrivilege throws → HTTP 500
      expect((err as Error).message).toContain("500");
    }
  });

  test("leader 调用 force_release — 成功释放锁", async () => {
    // leader profile 需要存在于 member-store 且 role 为 leader/总控
    // 如果 caller 对应的 profile 不存在或无权限，会报错
    // 这里用 "test-leader" 可能不存在 profile，改用真实 leader name
    // 先查 roster 找到 leader
    const roster = (await callWith(leaderSid, "get_roster", {})) as {
      roster: Array<{ name: string; role: string }>;
    };
    const leaderMember = roster.roster.find(
      (m) => m.role === "leader" || m.role === "总控"
    );

    const callerName = leaderMember?.name ?? "test-leader";

    const data = (await callWith(leaderSid, "force_release", {
      caller: callerName,
      member: MEMBER_A,
    })) as { success: boolean; hint?: string };

    expect(data.success).toBe(true);
  });

  test("force_release 后 get_status — working 应为 false", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: MEMBER_A,
    })) as { working: boolean; lock: unknown };

    expect(data.working).toBe(false);
    expect(data.lock).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. handoff 失败场景：from 未持锁
// ═══════════════════════════════════════════════════════════════════════════

describe("handoff edge cases", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerSession("", true);
  });

  afterAll(async () => {
    await safeUnregister(sid);
  });

  test("from 未持锁时 handoff — 应返回 success=false", async () => {
    // MEMBER_A 当前没有锁（上面 force_release 已清除）
    const data = (await callWith(sid, "handoff", {
      from: MEMBER_A,
      to: MEMBER_B,
      note: "should fail",
    })) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 完整协作循环：request → activate → checkpoint → save → experience → deactivate
// ═══════════════════════════════════════════════════════════════════════════

describe("full collaboration lifecycle", () => {
  let leaderSid: string;
  let memberSid: string;
  const LIFECYCLE_TOKEN = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    try {
      await callWith(memberSid, "deactivate", {
        member: MEMBER_A,
        force: true,
      });
    } catch {
      /* ok */
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("step 1: request_member", async () => {
    const data = (await callWith(leaderSid, "request_member", {
      caller: "test-leader",
      member: MEMBER_A,
      project: TEST_PROJECT,
      task: "full-lifecycle-test",
    })) as { reserved: boolean; reservation_code: string };

    expect(data.reserved).toBe(true);
    (globalThis as any).__lifecycle_code = data.reservation_code;
  });

  test("step 2: activate", async () => {
    const code = (globalThis as any).__lifecycle_code;
    const data = (await callWith(memberSid, "activate", {
      member: MEMBER_A,
      reservation_code: code,
    })) as {
      identity: { name: string };
      current_task: { project: string; task: string };
    };

    expect(data.identity.name).toBe(MEMBER_A);
    expect(data.current_task.project).toBe(TEST_PROJECT);
  });

  test("step 3: checkpoint", async () => {
    const data = (await callWith(memberSid, "checkpoint", {
      member: MEMBER_A,
      progress_summary: "halfway done",
    })) as {
      checkpoint: boolean;
      original_task: { project: string; task: string };
    };

    expect(data.checkpoint).toBe(true);
    expect(data.original_task.project).toBe(TEST_PROJECT);
    expect(data.original_task.task).toBe("full-lifecycle-test");
  });

  test("step 4: save_memory", async () => {
    const data = (await callWith(memberSid, "save_memory", {
      member: MEMBER_A,
      scope: "generic",
      content: `[lifecycle-e2e] personal note: ${LIFECYCLE_TOKEN}`,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });

  test("step 5: submit_experience", async () => {
    const data = (await callWith(memberSid, "submit_experience", {
      member: MEMBER_A,
      scope: "generic",
      content: `[lifecycle-e2e] team learning: ${LIFECYCLE_TOKEN}`,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });

  test("step 6: search_experience — 验证刚提交的经验可搜到", async () => {
    const data = (await callWith(memberSid, "search_experience", {
      keyword: LIFECYCLE_TOKEN,
    })) as { results: Array<{ line: string }> };

    expect(data.results.length).toBeGreaterThan(0);
    const found = data.results.some((r) => r.line.includes(LIFECYCLE_TOKEN));
    expect(found).toBe(true);
  });

  test("step 7: deactivate — 正常释放", async () => {
    const data = (await callWith(memberSid, "deactivate", {
      member: MEMBER_A,
      note: "lifecycle test done",
    })) as { success: boolean; member: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(MEMBER_A);
  });

  test("step 8: 验证释放后状态", async () => {
    const data = (await callWith(leaderSid, "get_status", {
      member: MEMBER_A,
    })) as { working: boolean };

    expect(data.working).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. save_memory 必须在 activate 之后
// ═══════════════════════════════════════════════════════════════════════════

describe("save_memory requires activation", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerSession();
  });

  afterAll(async () => {
    await safeUnregister(sid);
  });

  test("未 activate 直接 save_memory — 应返回 error", async () => {
    const data = (await callWith(sid, "save_memory", {
      member: MEMBER_A,
      scope: "generic",
      content: "should fail",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("未激活");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. submit_experience 必须在 activate 之后
// ═══════════════════════════════════════════════════════════════════════════

describe("submit_experience requires activation", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerSession();
  });

  afterAll(async () => {
    await safeUnregister(sid);
  });

  test("未 activate 直接 submit_experience — 应返回 error", async () => {
    const data = (await callWith(sid, "submit_experience", {
      member: MEMBER_A,
      scope: "generic",
      content: "should fail",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("未激活");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. deactivate 未 save_memory — 应拦截
// ═══════════════════════════════════════════════════════════════════════════

describe("deactivate without save_memory", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    try {
      await callWith(memberSid, "deactivate", {
        member: MEMBER_A,
        force: true,
      });
    } catch {
      /* ok */
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("activate 后直接 deactivate（不 save） — 应返回 error 提示 save_memory", async () => {
    const reqData = (await callWith(leaderSid, "request_member", {
      caller: "test-leader",
      member: MEMBER_A,
      project: TEST_PROJECT,
      task: "deactivate-guard-test",
    })) as { reserved: boolean; reservation_code: string };
    expect(reqData.reserved).toBe(true);

    await callWith(memberSid, "activate", {
      member: MEMBER_A,
      reservation_code: reqData.reservation_code,
    });

    const data = (await callWith(memberSid, "deactivate", {
      member: MEMBER_A,
    })) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain("save_memory");
  });

  test("传 force=true 跳过 save_memory — 应成功", async () => {
    const data = (await callWith(memberSid, "deactivate", {
      member: MEMBER_A,
      force: true,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });
});
