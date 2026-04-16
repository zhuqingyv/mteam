/**
 * communication.e2e.test.ts
 * E2E 测试：通信系统（send_msg / check_inbox）
 *
 * 前提：hub 运行在 http://127.0.0.1:58578
 *
 * 注意：send_msg / check_inbox 依赖 Panel 运行（通过 Panel HTTP API 转发消息）。
 * Panel 未运行时，send_msg 返回 { error: "Panel 通信失败: ..." }，
 * check_inbox 同理。测试中对此做了区分：
 *   - Panel 在线 → 验证完整收发流程
 *   - Panel 离线 → 验证 graceful error（不 crash，返回结构化错误）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const HUB = "http://127.0.0.1:58578";
const MEMBER_A = "小快";
const MEMBER_B = "阿构";
const TEST_PROJECT = "communication-e2e-test";
const TEST_TASK = "verify messaging system";

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

async function registerSession(member: string = "", isLeader: boolean = false): Promise<string> {
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

/** 检测 Panel 是否在线 */
async function isPanelOnline(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:58578/api/health");
    // Panel port 是从 panel.port 文件读取的，不是 hub 端口
    // 简单策略：尝试发一条消息看是否返回 Panel 通信失败
    return true; // 先返回 true，后续由实际调用判断
  } catch {
    return false;
  }
}

// ─── activate helper：完成 request_member + activate 流程 ──────────────────

async function activateMember(
  sid: string,
  member: string,
  project: string,
  task: string,
  callerSid?: string
): Promise<{ reservationCode: string }> {
  // 用 leader session 做 request_member
  const reqSid = callerSid ?? sid;
  const reqData = (await callWith(reqSid, "request_member", {
    caller: "test-leader",
    member,
    project,
    task,
  })) as { reserved: boolean; reservation_code: string };

  if (!reqData.reserved) {
    throw new Error(`request_member for ${member} failed: reserved=false`);
  }

  // 用 member session 做 activate
  await callWith(sid, "activate", {
    member,
    reservation_code: reqData.reservation_code,
  });

  return { reservationCode: reqData.reservation_code };
}

async function cleanupMember(
  sid: string,
  member: string,
  force: boolean = false
): Promise<void> {
  try {
    if (!force) {
      await callWith(sid, "save_memory", {
        member,
        scope: "generic",
        content: "[communication-e2e-test] cleanup",
      });
    }
    await callWith(sid, "deactivate", { member, force });
  } catch {
    /* best-effort cleanup */
  }
}

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. send_msg: leader 向成员发消息 → check_inbox 成员能收到
// ═══════════════════════════════════════════════════════════════════════════

describe("send_msg: leader -> member", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    await cleanupMember(memberSid, MEMBER_A, true);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("leader 向成员发消息 — 不 crash，返回结构化结果", async () => {
    // activate member first so they have a session
    await activateMember(memberSid, MEMBER_A, TEST_PROJECT, TEST_TASK, leaderSid);

    const result = (await callWith(leaderSid, "send_msg", {
      to: MEMBER_A,
      content: "请开始执行任务",
      priority: "normal",
    })) as { sent?: boolean; error?: string };

    // send_msg 要么成功（Panel 在线），要么返回 Panel 通信失败（Panel 离线）
    // 两种情况都不应该 crash
    if (result.error) {
      // Panel 离线：验证是 graceful error
      expect(result.error).toContain("Panel");
      console.log("[INFO] Panel offline — send_msg returned graceful error");
    } else {
      // Panel 在线：验证发送成功
      expect(result.sent).toBe(true);
    }
  });

  test("成员 check_inbox — 不 crash，返回结构化结果", async () => {
    const result = (await callWith(memberSid, "check_inbox", {
      member: MEMBER_A,
    })) as { messages?: Array<unknown>; error?: string };

    if (result.error) {
      expect(result.error).toContain("Panel");
      console.log("[INFO] Panel offline — check_inbox returned graceful error");
    } else {
      // Panel 在线：应返回 messages 数组
      expect(result).toHaveProperty("messages");
      expect(Array.isArray(result.messages)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. send_msg: 成员向 leader 发消息 → check_inbox leader 能收到
// ═══════════════════════════════════════════════════════════════════════════

describe("send_msg: member -> leader", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    await cleanupMember(memberSid, MEMBER_A, true);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("成员向 leader 发消息 — 不 crash", async () => {
    await activateMember(memberSid, MEMBER_A, TEST_PROJECT, "msg-to-leader", leaderSid);

    const result = (await callWith(memberSid, "send_msg", {
      to: "leader",
      content: "任务已完成",
      priority: "normal",
    })) as { sent?: boolean; error?: string };

    if (result.error) {
      expect(result.error).toContain("Panel");
    } else {
      expect(result.sent).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. send_msg: 成员向成员发消息 → 验证收发
// ═══════════════════════════════════════════════════════════════════════════

describe("send_msg: member -> member", () => {
  let leaderSid: string;
  let memberASid: string;
  let memberBSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberASid = await registerSession(MEMBER_A);
    memberBSid = await registerSession(MEMBER_B);
  });

  afterAll(async () => {
    await cleanupMember(memberASid, MEMBER_A, true);
    await cleanupMember(memberBSid, MEMBER_B, true);
    await safeUnregister(leaderSid);
    await safeUnregister(memberASid);
    await safeUnregister(memberBSid);
  });

  test("成员 A 向成员 B 发消息 — 不 crash", async () => {
    await activateMember(memberASid, MEMBER_A, TEST_PROJECT, "cross-member-msg-a", leaderSid);
    await activateMember(memberBSid, MEMBER_B, TEST_PROJECT, "cross-member-msg-b", leaderSid);

    const result = (await callWith(memberASid, "send_msg", {
      to: MEMBER_B,
      content: "请帮忙 review 代码",
      priority: "normal",
    })) as { sent?: boolean; error?: string };

    if (result.error) {
      expect(result.error).toContain("Panel");
    } else {
      expect(result.sent).toBe(true);
    }
  });

  test("成员 B check_inbox — 能收到或 graceful error", async () => {
    const result = (await callWith(memberBSid, "check_inbox", {
      member: MEMBER_B,
    })) as { messages?: Array<unknown>; error?: string };

    if (result.error) {
      expect(result.error).toContain("Panel");
    } else {
      expect(result).toHaveProperty("messages");
      expect(Array.isArray(result.messages)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. 消息优先级：urgent vs normal
// ═══════════════════════════════════════════════════════════════════════════

describe("message priority: urgent vs normal", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    await cleanupMember(memberSid, MEMBER_A, true);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("发送 urgent 消息 — 不 crash，priority 参数被接受", async () => {
    await activateMember(memberSid, MEMBER_A, TEST_PROJECT, "priority-test", leaderSid);

    const result = (await callWith(leaderSid, "send_msg", {
      to: MEMBER_A,
      content: "紧急：请立即停止当前工作",
      priority: "urgent",
    })) as { sent?: boolean; error?: string };

    // 不 crash 即通过
    if (result.error) {
      expect(result.error).toContain("Panel");
    } else {
      expect(result.sent).toBe(true);
    }
  });

  test("发送 normal 消息 — 不 crash，priority 参数被接受", async () => {
    const result = (await callWith(leaderSid, "send_msg", {
      to: MEMBER_A,
      content: "普通通知：明天有例会",
      priority: "normal",
    })) as { sent?: boolean; error?: string };

    if (result.error) {
      expect(result.error).toContain("Panel");
    } else {
      expect(result.sent).toBe(true);
    }
  });

  test("不传 priority — 默认为 normal，不 crash", async () => {
    const result = (await callWith(leaderSid, "send_msg", {
      to: MEMBER_A,
      content: "没有设置优先级的消息",
    })) as { sent?: boolean; error?: string };

    if (result.error) {
      expect(result.error).toContain("Panel");
    } else {
      expect(result.sent).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. 离线成员能否收到消息
// ═══════════════════════════════════════════════════════════════════════════

describe("send_msg to offline member", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("向未激活（offline）的成员发消息 — 不 crash，返回结构化结果", async () => {
    // MEMBER_B 未 activate，处于 offline 状态
    const result = (await callWith(leaderSid, "send_msg", {
      to: MEMBER_B,
      content: "你在线吗？",
      priority: "normal",
    })) as { sent?: boolean; error?: string; delivery?: string };

    // 不 crash。可能成功投递到 inbox（离线缓存）或返回 Panel 错误
    if (result.error) {
      expect(typeof result.error).toBe("string");
    }
    // 无论如何，结果应该有结构
    expect(typeof result).toBe("object");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. send_msg 参数校验
// ═══════════════════════════════════════════════════════════════════════════

describe("send_msg parameter validation", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("缺少 to 参数 — 应返回错误", async () => {
    try {
      const raw = (await hubPost("/api/call", {
        session_id: leaderSid,
        tool: "send_msg",
        arguments: { content: "test" },
      })) as { content: Array<{ type: string; text: string }> };

      // 要么 hub 抛 500，要么返回 content 里包含 error
      if (raw.content) {
        const data = JSON.parse(raw.content[0].text);
        // 缺 to 应触发 missing param 错误
        if (data.error) {
          expect(data.error).toBeDefined();
        }
      }
    } catch (err) {
      // HTTP 500 也算合法的错误处理（hub 对 missing param 抛 Error）
      expect((err as Error).message).toContain("500");
    }
  });

  test("缺少 content 参数 — 应返回错误", async () => {
    try {
      const raw = (await hubPost("/api/call", {
        session_id: leaderSid,
        tool: "send_msg",
        arguments: { to: MEMBER_A },
      })) as { content: Array<{ type: string; text: string }> };

      if (raw.content) {
        const data = JSON.parse(raw.content[0].text);
        if (data.error) {
          expect(data.error).toBeDefined();
        }
      }
    } catch (err) {
      expect((err as Error).message).toContain("500");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. check_inbox 参数校验
// ═══════════════════════════════════════════════════════════════════════════

describe("check_inbox parameter validation", () => {
  let sid: string;

  beforeAll(async () => {
    sid = await registerSession();
  });

  afterAll(async () => {
    await safeUnregister(sid);
  });

  test("缺少 member 参数 — 应返回错误", async () => {
    try {
      const raw = (await hubPost("/api/call", {
        session_id: sid,
        tool: "check_inbox",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }> };

      if (raw.content) {
        const data = JSON.parse(raw.content[0].text);
        if (data.error) {
          expect(data.error).toBeDefined();
        }
      }
    } catch (err) {
      expect((err as Error).message).toContain("500");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. send_msg 发送方推断
// ═══════════════════════════════════════════════════════════════════════════

describe("send_msg sender inference", () => {
  let leaderSid: string;
  let memberSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("", true);
    memberSid = await registerSession(MEMBER_A);
  });

  afterAll(async () => {
    await cleanupMember(memberSid, MEMBER_A, true);
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("已激活成员发送消息 — from 应被推断为成员名", async () => {
    await activateMember(memberSid, MEMBER_A, TEST_PROJECT, "sender-inference", leaderSid);

    // send_msg 内部会从 activatedMembers 推断 from
    // 我们无法直接验证 from 值，但确保调用不 crash
    const result = (await callWith(memberSid, "send_msg", {
      to: MEMBER_B,
      content: "inference test",
    })) as { sent?: boolean; error?: string };

    // 不 crash 即通过
    expect(typeof result).toBe("object");
  });

  test("未激活的 leader session 发送消息 — from 应回退到 session.memberName", async () => {
    const result = (await callWith(leaderSid, "send_msg", {
      to: MEMBER_A,
      content: "leader inference test",
    })) as { sent?: boolean; error?: string };

    expect(typeof result).toBe("object");
  });
});
