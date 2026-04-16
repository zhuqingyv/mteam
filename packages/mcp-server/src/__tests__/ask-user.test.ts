/**
 * ask-user.test.ts
 * 单元测试：验证 ask_user tool 定义、参数校验、handler 逻辑
 * 不依赖 Panel 运行（mock fetch）
 */

import { describe, test, expect } from "bun:test";
import { tools, handleToolCall } from "../hub.js";

// ─── helpers ───────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<{
  id: string;
  pid: number;
  lstart: string;
  memberName: string;
  isLeader: boolean;
  activatedMembers: Set<string>;
  memorySavedMembers: Set<string>;
  lockNonces: Map<string, string>;
}> = {}) {
  return {
    id: overrides.id ?? "test-session-1",
    pid: overrides.pid ?? process.pid,
    lstart: overrides.lstart ?? new Date().toISOString(),
    memberName: overrides.memberName ?? "test-agent",
    isLeader: overrides.isLeader ?? false,
    activatedMembers: overrides.activatedMembers ?? new Set<string>(),
    memorySavedMembers: overrides.memorySavedMembers ?? new Set<string>(),
    lockNonces: overrides.lockNonces ?? new Map<string, string>(),
  };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// ─── tool 定义 ────────────────────────────────────────────────────────────

describe("ask_user tool definition", () => {
  const askUserTool = tools.find((t) => t.name === "ask_user");

  test("tool exists in tools array", () => {
    expect(askUserTool).toBeDefined();
  });

  test("has correct required fields", () => {
    const schema = askUserTool!.inputSchema;
    expect(schema.required).toEqual(["type", "title", "question"]);
  });

  test("type enum includes all 4 interaction types", () => {
    const typeField = askUserTool!.inputSchema.properties.type as { enum: string[] };
    expect(typeField.enum).toEqual(["confirm", "single_choice", "multi_choice", "input"]);
  });

  test("options is array of strings", () => {
    const optionsField = askUserTool!.inputSchema.properties.options as { type: string; items: { type: string } };
    expect(optionsField.type).toBe("array");
    expect(optionsField.items.type).toBe("string");
  });

  test("timeout_ms is number", () => {
    const timeoutField = askUserTool!.inputSchema.properties.timeout_ms as { type: string };
    expect(timeoutField.type).toBe("number");
  });
});

// ─── handler 参数校验 ─────────────────────────────────────────────────────

describe("ask_user handler validation", () => {
  test("single_choice without options returns error", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "ask_user", {
      type: "single_choice",
      title: "选择方案",
      question: "请选择一个方案",
      // options 缺失
    });
    const data = parseResult(result);
    expect(data.error).toContain("options");
  });

  test("multi_choice with empty options returns error", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "ask_user", {
      type: "multi_choice",
      title: "多选",
      question: "请选择",
      options: [],
    });
    const data = parseResult(result);
    expect(data.error).toContain("options");
  });

  test("confirm type does not require options", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "ask_user", {
      type: "confirm",
      title: "确认",
      question: "是否继续？",
    });
    const data = parseResult(result);
    // Panel 未运行时返回通信失败，但不应是 options 校验错误
    expect(data.error).not.toContain("options");
  });

  test("input type does not require options", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "ask_user", {
      type: "input",
      title: "输入",
      question: "请输入名称",
    });
    const data = parseResult(result);
    expect(data.error).not.toContain("options");
  });

  test("missing required param 'type' throws", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "ask_user", {
      title: "确认",
      question: "是否继续？",
    });
    const data = parseResult(result);
    expect(data.error).toContain("type");
  });

  test("missing required param 'title' throws", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "ask_user", {
      type: "confirm",
      question: "是否继续？",
    });
    const data = parseResult(result);
    expect(data.error).toContain("title");
  });
});

// ─── MEDIUM 审计修复验证 ──────────────────────────────────────────────────

describe("MEDIUM audit fixes", () => {
  test("send_msg to description mentions leader", () => {
    const sendMsgTool = tools.find((t) => t.name === "send_msg");
    expect(sendMsgTool).toBeDefined();
    const toDesc = (sendMsgTool!.inputSchema.properties as any).to.description as string;
    expect(toDesc).toContain("leader");
  });
});
