/**
 * governance.e2e.test.ts
 * E2E 测试：治理与规则系统 (propose_rule / review_rules / approve_rule / reject_rule)
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const SHARED_DIR = path.join(os.homedir(), ".claude", "team-hub", "shared");
const TEST_MEMBER = "小快";
const LEADER_CALLER = "郭总"; // 总控角色，有 approve_rule/reject_rule 权限

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

// ─── 备份 & 恢复 pending_rules ──────────────────────────────────────────

const pendingRulesPath = path.join(SHARED_DIR, "pending_rules.json");
let pendingRulesBackup: string | null = null;

function backupPendingRules(): void {
  try {
    pendingRulesBackup = fs.readFileSync(pendingRulesPath, "utf-8");
  } catch {
    pendingRulesBackup = null;
  }
}

function restorePendingRules(): void {
  if (pendingRulesBackup !== null) {
    fs.writeFileSync(pendingRulesPath, pendingRulesBackup, "utf-8");
  } else {
    try {
      fs.rmSync(pendingRulesPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ─── global setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. propose_rule → review_rules 能看到提案
// ═══════════════════════════════════════════════════════════════════════════

describe("propose_rule and review_rules", () => {
  let leaderSid: string;
  let memberSid: string;
  let proposedRuleId: string;

  beforeAll(async () => {
    backupPendingRules();
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);
  });

  afterAll(async () => {
    restorePendingRules();
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("成员提议规则 — 返回 id", async () => {
    const data = (await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "E2E测试必须覆盖权限校验",
      reason: "避免权限漏洞上线",
    })) as { id: string; duplicate: boolean; hint: string };

    expect(data).toHaveProperty("id");
    expect(typeof data.id).toBe("string");
    expect(data.id).toMatch(/^rule_/);
    proposedRuleId = data.id;
  });

  test("review_rules 能看到刚提议的规则", async () => {
    const rules = (await callWith(leaderSid, "review_rules", {})) as Array<{
      id: string;
      member: string;
      rule: string;
      reason: string;
    }>;

    expect(Array.isArray(rules)).toBe(true);
    const found = rules.find((r) => r.id === proposedRuleId);
    expect(found).toBeDefined();
    expect(found!.member).toBe(TEST_MEMBER);
    expect(found!.rule).toBe("E2E测试必须覆盖权限校验");
    expect(found!.reason).toBe("避免权限漏洞上线");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. approve_rule → 规则生效
// ═══════════════════════════════════════════════════════════════════════════

describe("approve_rule", () => {
  let leaderSid: string;
  let memberSid: string;
  let ruleId: string;
  const rulesPath = path.join(SHARED_DIR, "rules.md");
  let rulesBackup: string | null = null;

  beforeAll(async () => {
    backupPendingRules();
    // 备份 rules.md
    try {
      rulesBackup = fs.readFileSync(rulesPath, "utf-8");
    } catch {
      rulesBackup = null;
    }
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);

    // 先提议一条规则
    const data = (await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "approve-test-rule-唯一标识",
      reason: "测试批准流程",
    })) as { id: string };
    ruleId = data.id;
  });

  afterAll(async () => {
    restorePendingRules();
    // 恢复 rules.md
    if (rulesBackup !== null) {
      fs.writeFileSync(rulesPath, rulesBackup, "utf-8");
    } else {
      try {
        fs.rmSync(rulesPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("leader 批准规则 — 成功", async () => {
    const data = (await callWith(leaderSid, "approve_rule", {
      caller: LEADER_CALLER,
      rule_id: ruleId,
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });

  test("批准后 pending 中不再有该规则", async () => {
    const rules = (await callWith(leaderSid, "review_rules", {})) as Array<{
      id: string;
    }>;
    const found = rules.find((r) => r.id === ruleId);
    expect(found).toBeUndefined();
  });

  test("批准后 rules.md 包含该规则", () => {
    const content = fs.readFileSync(rulesPath, "utf-8");
    expect(content).toContain("approve-test-rule-唯一标识");
    expect(content).toContain(ruleId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. reject_rule → 规则被否决
// ═══════════════════════════════════════════════════════════════════════════

describe("reject_rule", () => {
  let leaderSid: string;
  let memberSid: string;
  let ruleId: string;
  const rejectedPath = path.join(SHARED_DIR, "rejected_rules.jsonl");
  let rejectedBackup: string | null = null;

  beforeAll(async () => {
    backupPendingRules();
    // 备份 rejected_rules.jsonl
    try {
      rejectedBackup = fs.readFileSync(rejectedPath, "utf-8");
    } catch {
      rejectedBackup = null;
    }
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);

    // 先提议一条规则
    const data = (await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "reject-test-rule-唯一标识",
      reason: "测试拒绝流程",
    })) as { id: string };
    ruleId = data.id;
  });

  afterAll(async () => {
    restorePendingRules();
    // 恢复 rejected_rules.jsonl
    if (rejectedBackup !== null) {
      fs.writeFileSync(rejectedPath, rejectedBackup, "utf-8");
    } else {
      try {
        fs.rmSync(rejectedPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("leader 拒绝规则 — 成功", async () => {
    const data = (await callWith(leaderSid, "reject_rule", {
      caller: LEADER_CALLER,
      rule_id: ruleId,
      reason: "不符合当前需求",
    })) as { success: boolean };

    expect(data.success).toBe(true);
  });

  test("拒绝后 pending 中不再有该规则", async () => {
    const rules = (await callWith(leaderSid, "review_rules", {})) as Array<{
      id: string;
    }>;
    const found = rules.find((r) => r.id === ruleId);
    expect(found).toBeUndefined();
  });

  test("拒绝历史已记录", () => {
    const content = fs.readFileSync(rejectedPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.ruleId).toBe(ruleId);
    expect(last.reason).toBe("不符合当前需求");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. 权限校验：成员不能 approve / reject
// ═══════════════════════════════════════════════════════════════════════════

describe("governance permission checks", () => {
  let leaderSid: string;
  let memberSid: string;
  let ruleId: string;

  beforeAll(async () => {
    backupPendingRules();
    leaderSid = await registerSession("");
    memberSid = await registerSession(TEST_MEMBER);

    // 提议一条规则用于权限测试
    const data = (await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "权限测试规则",
      reason: "测试权限校验",
    })) as { id: string };
    ruleId = data.id;
  });

  afterAll(async () => {
    restorePendingRules();
    await safeUnregister(leaderSid);
    await safeUnregister(memberSid);
  });

  test("普通成员可以 propose_rule", async () => {
    // 已在 beforeAll 中验证 — 这里再跑一次确认
    const data = (await callWith(memberSid, "propose_rule", {
      member: TEST_MEMBER,
      rule: "成员也能提议",
      reason: "验证权限",
    })) as { id: string };
    expect(data).toHaveProperty("id");
  });

  test("普通成员 approve_rule — 应报错（无权限）", async () => {
    const data = (await callWith(memberSid, "approve_rule", {
      caller: TEST_MEMBER,
      rule_id: ruleId,
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("permission");
  });

  test("普通成员 reject_rule — 应报错（无权限）", async () => {
    const data = (await callWith(memberSid, "reject_rule", {
      caller: TEST_MEMBER,
      rule_id: ruleId,
      reason: "我是成员我拒绝",
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("permission");
  });

  test("approve 不存在的 rule_id — 应报错", async () => {
    const data = (await callWith(leaderSid, "approve_rule", {
      caller: LEADER_CALLER,
      rule_id: "rule_nonexistent_12345",
    })) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain("not found");
  });

  test("reject 不存在的 rule_id — 应报错", async () => {
    const data = (await callWith(leaderSid, "reject_rule", {
      caller: LEADER_CALLER,
      rule_id: "rule_nonexistent_12345",
      reason: "不存在",
    })) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain("not found");
  });
});
