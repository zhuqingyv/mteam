import fs from "node:fs";
import path from "node:path";
import { readPendingRules, writePendingRules } from "./memory-store.js";
import type { PendingRule } from "./memory-store.js";

export function proposeRule(
  sharedDir: string,
  member: string,
  rule: string,
  reason: string
): { id: string; duplicate: boolean } {
  fs.mkdirSync(sharedDir, { recursive: true });

  // 检查 rules.md 中是否有类似内容（简单子串匹配）
  const rulesPath = path.join(sharedDir, "rules.md");
  let duplicate = false;
  try {
    const existing = fs.readFileSync(rulesPath, "utf-8");
    const lowerRule = rule.toLowerCase();
    if (existing.toLowerCase().includes(lowerRule.slice(0, 20))) {
      duplicate = true;
    }
  } catch {
    // rules.md 不存在，不是重复
  }

  const pending = readPendingRules(sharedDir);
  const id = `rule_${Date.now()}`;
  const newRule: PendingRule = {
    id,
    member,
    rule,
    reason,
    proposed_at: new Date().toISOString(),
  };
  pending.push(newRule);
  writePendingRules(sharedDir, pending);

  return { id, duplicate };
}

export function reviewRules(sharedDir: string): PendingRule[] {
  return readPendingRules(sharedDir);
}

export function approveRule(
  sharedDir: string,
  ruleId: string,
  approver: string
): { success: boolean; error?: string } {
  const pending = readPendingRules(sharedDir);
  const idx = pending.findIndex((r) => r.id === ruleId);
  if (idx === -1) {
    return { success: false, error: `rule ${ruleId} not found in pending` };
  }

  const [rule] = pending.splice(idx, 1);
  writePendingRules(sharedDir, pending);

  const rulesPath = path.join(sharedDir, "rules.md");
  const entry = `\n## ${rule.id}\n**Rule:** ${rule.rule}\n**Reason:** ${rule.reason}\n**Proposed by:** ${rule.member}\n**Approved by:** ${approver}\n**Approved at:** ${new Date().toISOString()}\n`;
  fs.appendFileSync(rulesPath, entry, "utf-8");

  return { success: true };
}

export function rejectRule(
  sharedDir: string,
  ruleId: string,
  reason: string
): { success: boolean; error?: string; proposer?: string; rule?: string } {
  const pending = readPendingRules(sharedDir);
  const idx = pending.findIndex((r) => r.id === ruleId);
  if (idx === -1) {
    return { success: false, error: `rule ${ruleId} not found in pending` };
  }

  const [rejected] = pending.splice(idx, 1);
  writePendingRules(sharedDir, pending);

  // 记录拒绝历史
  const rejectedPath = path.join(sharedDir, "rejected_rules.jsonl");
  fs.appendFileSync(
    rejectedPath,
    JSON.stringify({ ruleId, reason, proposer: rejected.member, rule: rejected.rule, rejected_at: new Date().toISOString() }) + "\n",
    "utf-8"
  );

  return { success: true, proposer: rejected.member, rule: rejected.rule };
}
