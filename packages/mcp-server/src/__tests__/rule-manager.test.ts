import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  proposeRule,
  reviewRules,
  approveRule,
  rejectRule,
} from "../rule-manager.ts";

let tmpDir: string;
let sharedDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-test-"));
  sharedDir = path.join(tmpDir, "shared");
  fs.mkdirSync(sharedDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("proposeRule", () => {
  test("adds to pending list", () => {
    const result = proposeRule(sharedDir, "alice", "No force push", "Protect main branch");
    expect(result.id).toMatch(/^rule_/);
    expect(result.duplicate).toBe(false);

    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(1);
    expect(pending[0].member).toBe("alice");
    expect(pending[0].rule).toBe("No force push");
    expect(pending[0].reason).toBe("Protect main branch");
  });

  test("detects duplicate against rules.md", () => {
    // Pre-populate rules.md with existing content
    fs.writeFileSync(
      path.join(sharedDir, "rules.md"),
      "## Rule\nNo force push to main\n"
    );

    const result = proposeRule(sharedDir, "bob", "No force push to main branch", "Safety");
    expect(result.duplicate).toBe(true);
    // Should still be added to pending even if duplicate
    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(1);
  });

  test("no duplicate when rules.md does not exist", () => {
    const result = proposeRule(sharedDir, "alice", "Some new rule", "Because");
    expect(result.duplicate).toBe(false);
  });

  test("multiple proposals accumulate", () => {
    proposeRule(sharedDir, "alice", "Rule A", "Reason A");
    proposeRule(sharedDir, "bob", "Rule B", "Reason B");
    proposeRule(sharedDir, "carol", "Rule C", "Reason C");

    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(3);
  });
});

describe("reviewRules", () => {
  test("returns pending list", () => {
    proposeRule(sharedDir, "alice", "Rule 1", "Reason 1");
    proposeRule(sharedDir, "bob", "Rule 2", "Reason 2");

    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(2);
    expect(pending[0].rule).toBe("Rule 1");
    expect(pending[1].rule).toBe("Rule 2");
  });

  test("returns empty array when no pending rules", () => {
    const pending = reviewRules(sharedDir);
    expect(pending).toEqual([]);
  });
});

describe("approveRule", () => {
  test("moves from pending to rules.md", () => {
    const { id } = proposeRule(sharedDir, "alice", "Always test", "Quality");
    const result = approveRule(sharedDir, id, "guozong");
    expect(result.success).toBe(true);

    // Pending should be empty
    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(0);

    // rules.md should contain the approved rule
    const rulesContent = fs.readFileSync(path.join(sharedDir, "rules.md"), "utf-8");
    expect(rulesContent).toContain("Always test");
    expect(rulesContent).toContain("guozong");
    expect(rulesContent).toContain(id);
  });

  test("fails for nonexistent rule", () => {
    const result = approveRule(sharedDir, "rule_nonexistent", "guozong");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("only removes the approved rule from pending, leaves others", () => {
    const { id: id1 } = proposeRule(sharedDir, "alice", "Rule A", "Reason A");
    const { id: id2 } = proposeRule(sharedDir, "bob", "Rule B", "Reason B");

    approveRule(sharedDir, id1, "guozong");

    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(id2);
  });
});

describe("rejectRule", () => {
  test("removes from pending and writes to rejected_rules.jsonl", () => {
    const { id } = proposeRule(sharedDir, "alice", "Bad rule", "Weak reason");
    const result = rejectRule(sharedDir, id, "Not aligned with goals");
    expect(result.success).toBe(true);

    // Pending should be empty
    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(0);

    // rejected_rules.jsonl should contain the rejection
    const rejectedPath = path.join(sharedDir, "rejected_rules.jsonl");
    const lines = fs.readFileSync(rejectedPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const rejected = JSON.parse(lines[0]);
    expect(rejected.ruleId).toBe(id);
    expect(rejected.reason).toBe("Not aligned with goals");
    expect(rejected.rejected_at).toBeTruthy();
  });

  test("fails for nonexistent rule", () => {
    const result = rejectRule(sharedDir, "rule_nonexistent", "No reason");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("only removes the rejected rule, leaves others", () => {
    const { id: id1 } = proposeRule(sharedDir, "alice", "Rule A", "Reason A");
    const { id: id2 } = proposeRule(sharedDir, "bob", "Rule B", "Reason B");

    rejectRule(sharedDir, id1, "Rejected");

    const pending = reviewRules(sharedDir);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(id2);
  });
});
