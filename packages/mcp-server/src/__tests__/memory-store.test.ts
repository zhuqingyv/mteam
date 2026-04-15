import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveMemory,
  readMemory,
  submitExperience,
  readShared,
  searchExperience,
} from "../memory-store.ts";

let tmpDir: string;
let membersDir: string;
let sharedDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
  membersDir = path.join(tmpDir, "members");
  sharedDir = path.join(tmpDir, "shared");
  fs.mkdirSync(membersDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveMemory / readMemory", () => {
  test("save and read generic memory", () => {
    saveMemory(membersDir, "alice", "generic", "This is a generic note");
    const content = readMemory(membersDir, "alice", "generic");
    expect(content).toContain("This is a generic note");
  });

  test("save and read project memory", () => {
    saveMemory(membersDir, "alice", "project", "Project-specific note", "proj-a");
    const content = readMemory(membersDir, "alice", "project", "proj-a");
    expect(content).toContain("Project-specific note");
  });

  test("read all memory (no scope) combines generic + project", () => {
    saveMemory(membersDir, "alice", "generic", "Generic note");
    saveMemory(membersDir, "alice", "project", "Project note A", "proj-a");
    saveMemory(membersDir, "alice", "project", "Project note B", "proj-b");

    const all = readMemory(membersDir, "alice");
    expect(all).toContain("Generic note");
    expect(all).toContain("Project note A");
    expect(all).toContain("Project note B");
  });

  test("read memory returns empty string for nonexistent member", () => {
    const content = readMemory(membersDir, "ghost", "generic");
    expect(content).toBe("");
  });
});

describe("submitExperience", () => {
  test("submit to generic scope saves content", () => {
    const result = submitExperience(membersDir, sharedDir, "alice", "generic", "Lesson learned: always test");
    expect(result.saved).toBe(true);
    expect(result.similar_lines).toEqual([]);

    const content = fs.readFileSync(path.join(sharedDir, "experience_generic.md"), "utf-8");
    expect(content).toContain("Lesson learned: always test");
    expect(content).toContain("[alice]");
  });

  test("submit detects similar lines", () => {
    // First submission
    submitExperience(membersDir, sharedDir, "alice", "generic", "Always run tests before deploy, this is critical");
    // Second submission with similar prefix
    const result = submitExperience(membersDir, sharedDir, "bob", "generic", "Always run tests before deploy, this is very important");
    expect(result.saved).toBe(true);
    expect(result.similar_lines.length).toBeGreaterThan(0);
  });

  test("submit to project scope saves to project file", () => {
    const result = submitExperience(membersDir, sharedDir, "alice", "project", "API cache helps performance", "proj-x");
    expect(result.saved).toBe(true);

    const content = fs.readFileSync(path.join(sharedDir, "experience_proj_proj-x.md"), "utf-8");
    expect(content).toContain("API cache helps performance");
  });

  test("submit with scope=team goes to pending_rules", () => {
    const result = submitExperience(membersDir, sharedDir, "alice", "team", "No force push to main");
    expect(result.saved).toBe(true);

    const pendingPath = path.join(sharedDir, "pending_rules.json");
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
    expect(pending.length).toBe(1);
    expect(pending[0].rule).toBe("No force push to main");
    expect(pending[0].member).toBe("alice");
    expect(pending[0].id).toMatch(/^rule_/);
  });
});

describe("readShared", () => {
  test("read experience returns generic content", () => {
    submitExperience(membersDir, sharedDir, "alice", "generic", "Some experience");
    const content = readShared(sharedDir, "experience", "generic");
    expect(content).toContain("Some experience");
  });

  test("read rules returns rules.md content", () => {
    fs.writeFileSync(path.join(sharedDir, "rules.md"), "## Rule 1\nDo this\n");
    const content = readShared(sharedDir, "rules");
    expect(content).toContain("Rule 1");
    expect(content).toContain("Do this");
  });

  test("read pending_rules returns JSON", () => {
    submitExperience(membersDir, sharedDir, "alice", "team", "Draft rule");
    const content = readShared(sharedDir, "pending_rules");
    const parsed = JSON.parse(content);
    expect(parsed.length).toBe(1);
    expect(parsed[0].rule).toBe("Draft rule");
  });

  test("read experience with no scope and a project combines both", () => {
    submitExperience(membersDir, sharedDir, "alice", "generic", "Generic exp");
    submitExperience(membersDir, sharedDir, "alice", "project", "Project exp", "proj-x");
    const content = readShared(sharedDir, "experience", undefined, "proj-x");
    expect(content).toContain("Generic exp");
    expect(content).toContain("Project exp");
  });

  test("read rules on empty sharedDir returns empty string", () => {
    const content = readShared(sharedDir, "rules");
    expect(content).toBe("");
  });
});

describe("searchExperience", () => {
  test("finds matches case-insensitively", () => {
    submitExperience(membersDir, sharedDir, "alice", "generic", "Always use TypeScript for safety");
    submitExperience(membersDir, sharedDir, "bob", "generic", "Python is fast for scripting");

    const hits = searchExperience(sharedDir, "typescript");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.line.includes("TypeScript"))).toBe(true);
  });

  test("returns empty for no match", () => {
    submitExperience(membersDir, sharedDir, "alice", "generic", "Some random content");
    const hits = searchExperience(sharedDir, "nonexistent-keyword-xyz");
    expect(hits).toEqual([]);
  });

  test("searches across project experience files", () => {
    submitExperience(membersDir, sharedDir, "alice", "project", "Cache invalidation is hard", "proj-a");
    submitExperience(membersDir, sharedDir, "bob", "project", "Use cache layer for speed", "proj-b");

    const hits = searchExperience(sharedDir, "cache");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test("scope=generic only searches generic file", () => {
    submitExperience(membersDir, sharedDir, "alice", "generic", "Generic cache tip");
    submitExperience(membersDir, sharedDir, "bob", "project", "Project cache tip", "proj-a");

    const hits = searchExperience(sharedDir, "cache", "generic");
    // Should only find the generic one
    expect(hits.every((h) => h.source === "experience_generic.md")).toBe(true);
  });
});
