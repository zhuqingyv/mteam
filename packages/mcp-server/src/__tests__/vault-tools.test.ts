/**
 * vault-tools.test.ts
 * 单元测试：验证 list_api_keys / use_api tool 定义、参数校验、handler 逻辑
 * 不依赖 Panel 运行
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
    id: overrides.id ?? "test-session-vault",
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

// ─── list_api_keys tool 定义 ──────────────────────────────────────────────

describe("list_api_keys tool definition", () => {
  const tool = tools.find((t) => t.name === "list_api_keys");

  test("tool exists in tools array", () => {
    expect(tool).toBeDefined();
  });

  test("has no required params", () => {
    expect(tool!.inputSchema.required).toEqual([]);
  });

  test("description mentions returning names, not secret values", () => {
    expect(tool!.description).toContain("名称");
    expect(tool!.description).toContain("不返回密钥值");
  });
});

// ─── use_api tool 定义 ────────────────────────────────────────────────────

describe("use_api tool definition", () => {
  const tool = tools.find((t) => t.name === "use_api");

  test("tool exists in tools array", () => {
    expect(tool).toBeDefined();
  });

  test("requires api_name and url", () => {
    expect(tool!.inputSchema.required).toEqual(["api_name", "url"]);
  });

  test("method enum includes 5 HTTP methods", () => {
    const methodProp = tool!.inputSchema.properties.method as { enum: string[] };
    expect(methodProp.enum).toEqual(["GET", "POST", "PUT", "DELETE", "PATCH"]);
  });

  test("description mentions auto-injection of API Key", () => {
    expect(tool!.description).toContain("自动注入");
  });

  test("headers description says Authorization is auto-injected", () => {
    const headersProp = tool!.inputSchema.properties.headers as { description: string };
    expect(headersProp.description).toContain("Authorization");
  });
});

// ─── use_api handler 参数校验 ─────────────────────────────────────────────

describe("use_api handler validation", () => {
  test("missing api_name throws error", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "use_api", {
      url: "https://api.example.com/v1/chat",
    });
    const data = parseResult(result);
    expect(data.error).toContain("api_name");
  });

  test("missing url throws error", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "use_api", {
      api_name: "openai",
    });
    const data = parseResult(result);
    expect(data.error).toContain("url");
  });

  test("method defaults to POST when not provided (Panel not running returns connection error, not method error)", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "use_api", {
      api_name: "openai",
      url: "https://api.openai.com/v1/chat/completions",
    });
    const data = parseResult(result);
    // Panel 未运行，但不应是 method 相关错误 — 说明 method 有默认值
    expect(data.error).not.toContain("method");
  });
});

// ─── list_api_keys handler ────────────────────────────────────────────────

describe("list_api_keys handler", () => {
  test("returns error when Panel is not running", async () => {
    const session = makeSession();
    const result = await handleToolCall(session as any, "list_api_keys", {});
    const data = parseResult(result);
    // Panel 未运行时应返回通信失败错误
    expect(data.error).toBeDefined();
  });
});
