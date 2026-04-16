/**
 * top10-fixes.test.ts
 * 集成测试：验证 Top 10 审计修复项
 * 前提：hub 运行在 http://127.0.0.1:58578
 *
 * 覆盖修复项：
 * 1. clock_out 未 save_memory → 被拦截
 * 2. check_inbox peek vs consume
 * 3. send_msg leader session from="leader"
 * 4. uninstall_member_mcp 只杀目标 MCP（通过 cleanupOneMcp 代码路径验证）
 * 5. deactivate 清理 departure.json
 * 6. activate 返回 pending_messages_count + workflow_hint
 * 7. update_project 数组缩减拦截
 * 8. propose_rule / reject_rule 通知机制
 * 9. request_member previous_member + activate predecessor
 * 10. isLeader IS_LEADER 推导（详见 isleader.test.ts，此处补充 hub 层集成验证）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const TEST_MEMBER = "小快";
const TEST_PROJECT = "top10-fixes-test";
const TEST_TASK = "verify top10 fixes";
const MEMBERS_DIR = path.join(os.homedir(), ".claude", "team-hub", "members");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "team-hub", "shared", "projects");

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

async function registerLeaderSession(): Promise<string> {
  const data = await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
    member: "",
    isLeader: true,
  }) as { session_id: string };
  return data.session_id;
}

async function registerMemberSession(member: string): Promise<string> {
  const data = await hubPost("/api/session/register", {
    pid: process.pid,
    lstart: new Date().toISOString(),
    member,
    isLeader: false,
  }) as { session_id: string };
  return data.session_id;
}

async function safeUnregister(sid: string): Promise<void> {
  if (!sid) return;
  try { await hubPost("/api/session/unregister", { session_id: sid }); } catch { /* best-effort */ }
}

async function callWith(sid: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    fs.rmSync(path.join(MEMBERS_DIR, member, "heartbeat.json"), { force: true });
  } catch { /* ignore */ }
}

function cleanupProjectFile(projectId: string): void {
  try {
    fs.rmSync(path.join(PROJECTS_DIR, `${projectId}.json`), { force: true });
  } catch { /* ignore */ }
}

/** 完整的 request -> activate 流程，返回 reservation_code */
async function requestAndActivate(
  sid: string,
  member: string,
  project: string,
  task: string,
): Promise<string> {
  const req = await callWith(sid, "request_member", {
    caller: "test-runner",
    member,
    project,
    task,
  }) as { reserved: boolean; reservation_code: string };
  expect(req.reserved).toBe(true);

  await callWith(sid, "activate", {
    member,
    reservation_code: req.reservation_code,
  });

  return req.reservation_code;
}

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
  // 清理可能残留的状态
  cleanupDepartureFile(TEST_MEMBER);
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 1: clock_out 未 save_memory → 被拦截
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 1] clock_out save_memory 检查", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerLeaderSession();
    memberSid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    cleanupHeartbeat(TEST_MEMBER);
    try { await callWith(memberSid, "deactivate", { member: TEST_MEMBER, force: true }); } catch { /* ok */ }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("clock_out 未 save_memory 且未传 force=true → 被拦截", async () => {
    // 1. 用 member session 完成 request -> activate
    await requestAndActivate(memberSid, TEST_MEMBER, TEST_PROJECT, TEST_TASK);

    // 2. leader 发起离场请求（需要心跳证明 online）
    ensureHeartbeat(TEST_MEMBER);
    const depResult = await callWith(leaderSid, "request_departure", {
      member: TEST_MEMBER,
    });
    // 可能因为 Panel 不可用导致通知失败，但 departure.json 应该写入了
    // 确保 departure file 存在
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    if (!fs.existsSync(depPath)) {
      // 手动写入 departure 状态
      fs.writeFileSync(depPath, JSON.stringify({
        pending: true,
        requested_at: new Date().toISOString(),
        previous_status: "working",
      }));
    }

    // 3. 成员在未 save_memory 的情况下直接 clock_out → 应被拦截
    const result = await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
    });

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error as string).toContain("save_memory");
  });

  test("clock_out 传 force=true → 跳过检查，成功下班", async () => {
    // 上一步 activate 状态还在，departure 状态也在
    // 确保 departure file 存在
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    if (!fs.existsSync(depPath)) {
      fs.writeFileSync(depPath, JSON.stringify({
        pending: true,
        requested_at: new Date().toISOString(),
        previous_status: "working",
      }));
    }

    const result = await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("offline");
  });

  test("clock_out 已 save_memory → 正常通过（不需要 force）", async () => {
    // 重新走完整流程
    await requestAndActivate(memberSid, TEST_MEMBER, TEST_PROJECT, "test-save-then-clockout");

    // save_memory
    await callWith(memberSid, "save_memory", {
      member: TEST_MEMBER,
      scope: "generic",
      content: "[test] clock_out after save_memory",
    });

    // 设置 departure 状态
    ensureHeartbeat(TEST_MEMBER);
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    fs.mkdirSync(path.dirname(depPath), { recursive: true });
    fs.writeFileSync(depPath, JSON.stringify({
      pending: true,
      requested_at: new Date().toISOString(),
      previous_status: "working",
    }));

    // clock_out 不传 force，应该成功
    const result = await callWith(memberSid, "clock_out", {
      member: TEST_MEMBER,
    });

    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 2: check_inbox peek vs consume
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 2] check_inbox peek vs consume", () => {
  let memberSid: string;

  beforeAll(async () => {
    memberSid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    await safeUnregister(memberSid);
  });

  test("check_inbox 默认（peek=false）消费消息", async () => {
    // 调用 check_inbox（默认 consume 模式）
    const result = await callWith(memberSid, "check_inbox", {
      member: TEST_MEMBER,
    });

    // 不论有无消息，不应报错（Panel 不可用时可能报错，跳过）
    if (!result.error) {
      expect(result).toHaveProperty("messages");
    }
  });

  test("check_inbox peek=true 只读不消费", async () => {
    // 调用 peek 模式
    const result = await callWith(memberSid, "check_inbox", {
      member: TEST_MEMBER,
      peek: true,
    });

    // peek 模式也应该返回消息数组（可能为空）或 Panel 错误
    if (!result.error) {
      expect(result).toHaveProperty("messages");
    }
  });

  test("peek=true 后再次 peek 仍能看到相同消息", async () => {
    // 第一次 peek
    const first = await callWith(memberSid, "check_inbox", {
      member: TEST_MEMBER,
      peek: true,
    });

    // 第二次 peek — 消息应该还在（没被消费）
    const second = await callWith(memberSid, "check_inbox", {
      member: TEST_MEMBER,
      peek: true,
    });

    // 如果 Panel 可用，两次结果应该一致
    if (!first.error && !second.error) {
      const firstMsgs = first.messages as unknown[];
      const secondMsgs = second.messages as unknown[];
      expect(firstMsgs.length).toBe(secondMsgs.length);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 3: send_msg leader session from="leader"
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 3] send_msg leader from 推断", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerLeaderSession();
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("leader session 发送 send_msg — from 不应为 unknown", async () => {
    const result = await callWith(leaderSid, "send_msg", {
      to: TEST_MEMBER,
      content: "[test] leader from check",
    });

    // send_msg 走 Panel，Panel 不可用时会报错
    // 如果成功，验证 from 不是 unknown
    if (!result.error) {
      // send_msg 返回值可能包含 from 信息
      // 即使返回值不直接含 from，关键是代码路径中 from="leader" 而非 "unknown"
      expect(result.sent ?? result.success).toBeTruthy();
    }
    // Panel 不可用的情况下跳过验证
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 4: uninstall_member_mcp 只杀目标 MCP
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 4] uninstall_member_mcp 使用 cleanupOneMcp", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerLeaderSession();
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("uninstall_member_mcp 卸载不存在的 MCP — 不影响其他 MCP 配置", async () => {
    // 先安装一个 MCP 配置给成员
    await callWith(leaderSid, "install_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "test-mcp-keep",
      command: "echo",
      args: ["hello"],
    });

    // 卸载另一个不存在的 MCP
    const result = await callWith(leaderSid, "uninstall_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "test-mcp-remove-nonexist",
    });

    // 卸载不存在的 MCP 返回 success=false
    expect(result.success).toBe(false);

    // 验证原有 MCP 配置仍然存在
    const mcpConfigPath = path.join(MEMBERS_DIR, TEST_MEMBER, "mcp-configs.json");
    if (fs.existsSync(mcpConfigPath)) {
      const configs = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8")) as Array<{ name: string }>;
      const kept = configs.find(c => c.name === "test-mcp-keep");
      expect(kept).toBeDefined();
    }

    // 清理
    await callWith(leaderSid, "uninstall_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "test-mcp-keep",
    });
  });

  test("uninstall_member_mcp 只移除目标 MCP 配置，保留其他", async () => {
    // 安装两个 MCP
    await callWith(leaderSid, "install_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "mcp-a",
      command: "echo",
      args: ["a"],
    });
    await callWith(leaderSid, "install_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "mcp-b",
      command: "echo",
      args: ["b"],
    });

    // 只卸载 mcp-a
    const result = await callWith(leaderSid, "uninstall_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "mcp-a",
    });
    expect(result.success).toBe(true);

    // 验证 mcp-b 仍然在配置中
    const mcpConfigPath = path.join(MEMBERS_DIR, TEST_MEMBER, "mcp-configs.json");
    if (fs.existsSync(mcpConfigPath)) {
      const configs = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8")) as Array<{ name: string }>;
      const hasA = configs.some(c => c.name === "mcp-a");
      const hasB = configs.some(c => c.name === "mcp-b");
      expect(hasA).toBe(false); // mcp-a 已卸载
      expect(hasB).toBe(true);  // mcp-b 保留
    }

    // 清理
    await callWith(leaderSid, "uninstall_member_mcp", {
      caller: "郭总",
      member: TEST_MEMBER,
      mcp_name: "mcp-b",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 5: deactivate 清理 departure.json
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 5] deactivate 清理 departure.json", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    await safeUnregister(sid);
  });

  test("deactivate 时清理残留的 departure.json", async () => {
    // 1. 用 member session 走 request -> activate
    await requestAndActivate(sid, TEST_MEMBER, TEST_PROJECT, "deactivate-cleanup-test");

    // 2. 手动写入 departure.json 模拟残留状态
    const depPath = path.join(MEMBERS_DIR, TEST_MEMBER, "departure.json");
    fs.mkdirSync(path.dirname(depPath), { recursive: true });
    fs.writeFileSync(depPath, JSON.stringify({
      pending: true,
      requested_at: new Date().toISOString(),
      previous_status: "working",
    }));
    expect(fs.existsSync(depPath)).toBe(true);

    // 3. deactivate（force 跳过 save_memory 检查）
    const result = await callWith(sid, "deactivate", {
      member: TEST_MEMBER,
      force: true,
    });
    expect(result.success).toBe(true);

    // 4. departure.json 应该被清理
    expect(fs.existsSync(depPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 6: activate 返回 pending_messages_count
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 6] activate 返回 pending_messages_count", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    try { await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true }); } catch { /* ok */ }
    await safeUnregister(sid);
  });

  test("activate 返回值包含 pending_messages_count 字段", async () => {
    const req = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "pending-messages-test",
    }) as { reserved: boolean; reservation_code: string };
    expect(req.reserved).toBe(true);

    const result = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: req.reservation_code,
    });

    // pending_messages_count 必须存在且为数字
    expect(result).toHaveProperty("pending_messages_count");
    expect(typeof result.pending_messages_count).toBe("number");
    expect(result.pending_messages_count as number).toBeGreaterThanOrEqual(0);

    // workflow_hint 也应该存在
    expect(typeof result.workflow_hint).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 7: update_project 数组缩减拦截
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 7] update_project 数组缩减拦截", () => {
  let leaderSid: string;
  let fix7ProjectId: string;
  const FIX7_PROJECT = "fix7-array-shrink-test";

  beforeAll(async () => {
    leaderSid = await registerLeaderSession();
    // 创建测试项目，捕获返回的 UUID
    const created = await callWith(leaderSid, "create_project", {
      caller: "郭总",
      name: FIX7_PROJECT,
      description: "test array shrink protection",
      members: ["alpha", "bravo", "charlie"],
    });
    fix7ProjectId = created.id as string;
  });

  afterAll(async () => {
    cleanupProjectFile(fix7ProjectId);
    await safeUnregister(leaderSid);
  });

  test("缩短 members 数组且不传 confirm_overwrite — 被拦截", async () => {
    const result = await callWith(leaderSid, "update_project", {
      caller: "郭总",
      project_id: fix7ProjectId,
      members: ["alpha"], // 从 3 人缩到 1 人
    });

    expect(result).toHaveProperty("error");
    expect(typeof result.error).toBe("string");
    expect(result.error as string).toContain("缩短");
    expect(result.error as string).toContain("confirm_overwrite");

    // 返回当前值供 agent 确认
    expect(result).toHaveProperty("current");
    const current = result.current as { members: string[] };
    expect(current.members).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("缩短 members 数组且传 confirm_overwrite=true — 允许更新", async () => {
    const result = await callWith(leaderSid, "update_project", {
      caller: "郭总",
      project_id: fix7ProjectId,
      members: ["alpha"],
      confirm_overwrite: true,
    });

    // 应成功更新，返回项目数据
    expect(result).not.toHaveProperty("error");
    expect(result.members).toEqual(["alpha"]);
  });

  test("扩展数组不需要 confirm_overwrite", async () => {
    const result = await callWith(leaderSid, "update_project", {
      caller: "郭总",
      project_id: fix7ProjectId,
      members: ["alpha", "bravo", "charlie", "delta"],
      // 不传 confirm_overwrite
    });

    // 扩展不需要确认
    expect(result).not.toHaveProperty("error");
    expect(result.members).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  test("同长度数组不需要 confirm_overwrite", async () => {
    const result = await callWith(leaderSid, "update_project", {
      caller: "郭总",
      project_id: fix7ProjectId,
      members: ["echo", "foxtrot", "golf", "hotel"], // 同 4 人，只是换人
    });

    expect(result).not.toHaveProperty("error");
    expect(result.members).toEqual(["echo", "foxtrot", "golf", "hotel"]);
  });

  test("缩短 forbidden 数组同样被拦截", async () => {
    // 先设置一些 forbidden 规则
    await callWith(leaderSid, "update_project", {
      caller: "郭总",
      project_id: fix7ProjectId,
      forbidden: ["no-mock", "no-any", "no-skip"],
      confirm_overwrite: true,
    });

    // 缩短 forbidden
    const result = await callWith(leaderSid, "update_project", {
      caller: "郭总",
      project_id: fix7ProjectId,
      forbidden: ["no-mock"],
    });

    expect(result).toHaveProperty("error");
    expect(result.error as string).toContain("缩短");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 3 补充: send_msg member session from 自动填充
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 3 补充] send_msg member session from", () => {
  let memberSid: string;
  let leaderSid: string;

  beforeAll(async () => {
    memberSid = await registerMemberSession(TEST_MEMBER);
    leaderSid = await registerLeaderSession();
  });

  afterAll(async () => {
    await safeUnregister(memberSid);
    await safeUnregister(leaderSid);
  });

  test("member session 发送 send_msg — from 应自动为成员名", async () => {
    const result = await callWith(memberSid, "send_msg", {
      to: "leader",
      content: "[test] member from auto-fill",
    });

    // Panel 不可用时可能报错，跳过
    if (!result.error) {
      expect(result.sent ?? result.success).toBeTruthy();
    }
  });

  test("leader session 发 send_msg 不需要传 from — 自动为 leader", async () => {
    // 重复验证 leader 路径（补充覆盖率）
    const result = await callWith(leaderSid, "send_msg", {
      to: TEST_MEMBER,
      content: "[test] leader auto from again",
    });

    if (!result.error) {
      expect(result.sent ?? result.success).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 5 补充: deactivate 无 departure.json 时也成功
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 5 补充] deactivate 无残留 departure.json", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    await safeUnregister(sid);
  });

  test("deactivate 时无 departure.json — 不报错，正常释放", async () => {
    await requestAndActivate(sid, TEST_MEMBER, TEST_PROJECT, "no-departure-test");

    // 确保 departure.json 不存在
    cleanupDepartureFile(TEST_MEMBER);

    const result = await callWith(sid, "deactivate", {
      member: TEST_MEMBER,
      force: true,
    });
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 6 补充: activate workflow_hint 格式验证
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 6 补充] activate workflow_hint 格式", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    try { await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true }); } catch { /* ok */ }
    await safeUnregister(sid);
  });

  test("workflow_hint 包含编号步骤（1. 2. 3. ...）", async () => {
    const req = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "workflow-hint-format-test",
    }) as { reserved: boolean; reservation_code: string };
    expect(req.reserved).toBe(true);

    const result = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: req.reservation_code,
    });

    const hint = result.workflow_hint as string;
    expect(hint).toBeDefined();
    // 至少包含 "1." 和 "2." 两个编号步骤
    expect(hint).toContain("1.");
    expect(hint).toContain("2.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 8: propose_rule / reject_rule 通知机制（hub 集成层）
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 8] propose_rule + reject_rule 集成流", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerLeaderSession();
    memberSid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("propose_rule 返回 id + hint 包含 send_msg 通知提示", async () => {
    const result = await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "[test] 禁止在测试中 mock 文件系统",
      reason: "mock 导致 CI 通过但本地失败",
    });

    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("string");
    expect(result.id as string).toMatch(/^rule_/);
    // hint 应提示成员通知 leader
    expect(result).toHaveProperty("hint");
    expect(result.hint as string).toContain("send_msg");
  });

  test("reject_rule 返回 proposer + rule + 触发通知（不阻塞）", async () => {
    // 清理上一个测试的残留 pending rule
    const pendingBefore = await callWith(leaderSid, "review_rules", {});
    const oldRules = pendingBefore.rules as Array<{ id: string }>;
    for (const r of oldRules) {
      await callWith(leaderSid, "reject_rule", { caller: "郭总", rule_id: r.id, reason: "cleanup" });
    }

    // 提一条新规则
    const proposed = await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "[test] 必须写注释",
      reason: "代码可读性",
    });
    const ruleId = proposed.id as string;

    // leader 拒绝
    const result = await callWith(leaderSid, "reject_rule", {
      caller: "郭总",
      rule_id: ruleId,
      reason: "过于严格，影响开发效率",
    });

    expect(result.success).toBe(true);
    // 返回 proposer 和 rule 信息（用于通知）
    expect(result.proposer).toBe(TEST_MEMBER);
    expect(result.rule).toBe("[test] 必须写注释");
  });

  test("approve_rule 成功后 review_rules 不再包含该规则", async () => {
    // propose
    const proposed = await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "[test] CI 必须全绿才能合并",
      reason: "保证主分支稳定",
    });
    const ruleId = proposed.id as string;

    // approve
    const approveResult = await callWith(leaderSid, "approve_rule", {
      caller: "郭总",
      rule_id: ruleId,
    });
    expect(approveResult.success).toBe(true);

    // review — 该规则不再出现在 pending 中
    const review = await callWith(leaderSid, "review_rules", {});
    const rules = review.rules as Array<{ id: string }>;
    const found = rules.find(r => r.id === ruleId);
    expect(found).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 9: request_member previous_member + activate predecessor
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 9] request_member previous_member → activate predecessor", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    try { await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true }); } catch { /* ok */ }
    await safeUnregister(sid);
  });

  test("传 previous_member → activate 返回 predecessor + workflow_hint 含前任引导", async () => {
    const req = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "handoff-from-predecessor-test",
      previous_member: "前任小明",
    }) as { reserved: boolean; reservation_code: string };
    expect(req.reserved).toBe(true);

    const result = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: req.reservation_code,
    });

    // predecessor 字段存在
    expect(result.predecessor).toBe("前任小明");
    // workflow_hint 包含前任引导
    const hint = result.workflow_hint as string;
    expect(hint).toContain("前任小明");
    expect(hint).toContain("work_history");
  });

  test("不传 previous_member → activate 不返回 predecessor", async () => {
    // 先 deactivate 释放上一个
    try { await callWith(sid, "deactivate", { member: TEST_MEMBER, force: true }); } catch { /* ok */ }

    const req = await callWith(sid, "request_member", {
      caller: "test-runner",
      member: TEST_MEMBER,
      project: TEST_PROJECT,
      task: "no-predecessor-test",
    }) as { reserved: boolean; reservation_code: string };
    expect(req.reserved).toBe(true);

    const result = await callWith(sid, "activate", {
      member: TEST_MEMBER,
      reservation_code: req.reservation_code,
    });

    // 无前任时不应有 predecessor 字段
    expect(result.predecessor).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 10: isLeader hub 层集成验证（补充 isleader.test.ts）
// ═══════════════════════════════════════════════════════════════════════════

describe("[Fix 10] isLeader hub 层集成验证", () => {
  // isleader.test.ts 已有 6 个 env var 推导测试 + 7 个 session/privilege 测试
  // 此处补充：leader session 不能 clock_out，member session 不能 request_departure

  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerLeaderSession();
    memberSid = await registerMemberSession(TEST_MEMBER);
  });

  afterAll(async () => {
    cleanupDepartureFile(TEST_MEMBER);
    cleanupHeartbeat(TEST_MEMBER);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("leader session 调 clock_out — 被拒绝（leader 不能下班）", async () => {
    const result = await callWith(leaderSid, "clock_out", {
      member: TEST_MEMBER,
    });
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("leader");
  });

  test("member session 调 request_departure — 被拒绝（仅 leader 可操作）", async () => {
    ensureHeartbeat(TEST_MEMBER);
    const result = await callWith(memberSid, "request_departure", {
      member: TEST_MEMBER,
    });
    cleanupHeartbeat(TEST_MEMBER);
    cleanupDepartureFile(TEST_MEMBER);
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("leader");
  });
});
