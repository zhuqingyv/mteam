/**
 * mcp-ecosystem.e2e.test.ts
 * E2E 测试：MCP 生态系统 (install_store_mcp / mount_mcp / unmount_mcp / uninstall_store_mcp / proxy_tool)
 * 前提：hub 运行在 http://127.0.0.1:58578
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = "http://127.0.0.1:58578";
const TEST_MEMBER = "小快";
const MEMBERS_DIR = path.join(os.homedir(), ".claude", "team-hub", "members");
const SHARED_DIR = path.join(os.homedir(), ".claude", "team-hub", "shared");
const STORE_PATH = path.join(SHARED_DIR, "mcp_store.json");
const LEADER_CALLER = "郭总"; // 总控角色，有 install/uninstall 权限
const TEST_MCP_NAME = "e2e-test-echo-mcp";

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

function getMemberUid(member: string): string | null {
  try {
    const profile = JSON.parse(
      fs.readFileSync(path.join(MEMBERS_DIR, member, "profile.json"), "utf-8")
    );
    return profile.uid ?? null;
  } catch {
    return null;
  }
}

// ─── global setup ──────────────────────────────────────────────────────────

let storeBackup: string | null = null;

beforeAll(async () => {
  const health = await fetch(`${HUB}/api/health`);
  if (!health.ok) throw new Error("Hub is not running at " + HUB);

  // 备份 store
  try {
    storeBackup = fs.readFileSync(STORE_PATH, "utf-8");
  } catch {
    storeBackup = null;
  }
});

afterAll(() => {
  // 恢复 store
  if (storeBackup !== null) {
    fs.writeFileSync(STORE_PATH, storeBackup, "utf-8");
  } else {
    try {
      fs.rmSync(STORE_PATH, { force: true });
    } catch {
      /* ignore */
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. install_store_mcp → 商店有该 MCP
// ═══════════════════════════════════════════════════════════════════════════

describe("install_store_mcp", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("leader 安装 MCP 到商店 — 成功", async () => {
    const data = (await callWith(leaderSid, "install_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: TEST_MCP_NAME,
      command: "echo",
      args: ["hello"],
      description: "E2E 测试用 echo MCP",
    })) as { success: boolean; mcp: { name: string }; store: unknown[] };

    expect(data.success).toBe(true);
    expect(data.mcp.name).toBe(TEST_MCP_NAME);
  });

  test("list_store_mcps 能看到新安装的 MCP", async () => {
    const data = (await callWith(leaderSid, "list_store_mcps", {})) as {
      store: Array<{ name: string; description?: string }>;
    };

    expect(Array.isArray(data.store)).toBe(true);
    const found = data.store.find((m) => m.name === TEST_MCP_NAME);
    expect(found).toBeDefined();
    expect(found!.description).toBe("E2E 测试用 echo MCP");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. mount_mcp → 成员挂载成功
// ═══════════════════════════════════════════════════════════════════════════

describe("mount_mcp", () => {
  let leaderSid: string;
  let memberUid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
    const uid = getMemberUid(TEST_MEMBER);
    if (!uid) throw new Error(`Member ${TEST_MEMBER} has no uid`);
    memberUid = uid;

    // 确保商店有这个 MCP
    await callWith(leaderSid, "install_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: TEST_MCP_NAME,
      command: "echo",
      args: ["hello"],
      description: "E2E 测试用 echo MCP",
    });
  });

  afterAll(async () => {
    // 清理挂载
    try {
      await callWith(leaderSid, "unmount_mcp", {
        uid: memberUid,
        mcp_name: TEST_MCP_NAME,
      });
    } catch {
      /* best-effort */
    }
    await safeUnregister(leaderSid);
  });

  test("成员挂载商店 MCP — 成功", async () => {
    const data = (await callWith(leaderSid, "mount_mcp", {
      uid: memberUid,
      mcp_name: TEST_MCP_NAME,
    })) as { success: boolean; member: string; mcp_name: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(TEST_MEMBER);
    expect(data.mcp_name).toBe(TEST_MCP_NAME);
  });

  test("list_member_mcps 显示已挂载", async () => {
    const data = (await callWith(leaderSid, "list_member_mcps", {
      uid: memberUid,
    })) as {
      member: string;
      uid: string;
      store_mcps: Array<{ name: string; mounted: boolean }>;
    };

    expect(data.member).toBe(TEST_MEMBER);
    const found = data.store_mcps.find((m) => m.name === TEST_MCP_NAME);
    expect(found).toBeDefined();
    expect(found!.mounted).toBe(true);
  });

  test("挂载不在商店的 MCP — 应报错", async () => {
    const data = (await callWith(leaderSid, "mount_mcp", {
      uid: memberUid,
      mcp_name: "nonexistent-mcp-xyz",
    })) as { success: boolean; error?: string };

    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. unmount_mcp → 成员卸载
// ═══════════════════════════════════════════════════════════════════════════

describe("unmount_mcp", () => {
  let leaderSid: string;
  let memberUid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
    const uid = getMemberUid(TEST_MEMBER);
    if (!uid) throw new Error(`Member ${TEST_MEMBER} has no uid`);
    memberUid = uid;

    // 确保商店有 MCP 且已挂载
    await callWith(leaderSid, "install_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: TEST_MCP_NAME,
      command: "echo",
      args: ["hello"],
      description: "E2E 测试用 echo MCP",
    });
    await callWith(leaderSid, "mount_mcp", {
      uid: memberUid,
      mcp_name: TEST_MCP_NAME,
    });
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("成员卸载已挂载的 MCP — 成功", async () => {
    const data = (await callWith(leaderSid, "unmount_mcp", {
      uid: memberUid,
      mcp_name: TEST_MCP_NAME,
    })) as { success: boolean; member: string; mcp_name: string };

    expect(data.success).toBe(true);
    expect(data.member).toBe(TEST_MEMBER);
  });

  test("卸载后 list_member_mcps 显示未挂载", async () => {
    const data = (await callWith(leaderSid, "list_member_mcps", {
      uid: memberUid,
    })) as {
      store_mcps: Array<{ name: string; mounted: boolean }>;
    };

    const found = data.store_mcps.find((m) => m.name === TEST_MCP_NAME);
    // 要么不存在（已卸载从列表移除），要么 mounted=false
    if (found) {
      expect(found.mounted).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. uninstall_store_mcp → 商店移除
// ═══════════════════════════════════════════════════════════════════════════

describe("uninstall_store_mcp", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");

    // 确保商店有这个 MCP
    await callWith(leaderSid, "install_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: TEST_MCP_NAME,
      command: "echo",
      args: ["hello"],
    });
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("leader 从商店移除 MCP — 成功", async () => {
    const data = (await callWith(leaderSid, "uninstall_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: TEST_MCP_NAME,
    })) as { success: boolean; mcp_name: string };

    expect(data.success).toBe(true);
    expect(data.mcp_name).toBe(TEST_MCP_NAME);
  });

  test("移除后 list_store_mcps 不再有该 MCP", async () => {
    const data = (await callWith(leaderSid, "list_store_mcps", {})) as {
      store: Array<{ name: string }>;
    };

    const found = data.store.find((m) => m.name === TEST_MCP_NAME);
    expect(found).toBeUndefined();
  });

  test("移除不存在的 MCP — 返回 false", async () => {
    const data = (await callWith(leaderSid, "uninstall_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: "nonexistent-mcp-12345",
    })) as { success: boolean };

    expect(data.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. proxy_tool 基本调用（UID 不存在的错误路径）
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy_tool error paths", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("proxy_tool 使用不存在的 UID — 应报错", async () => {
    const data = (await callWith(leaderSid, "proxy_tool", {
      uid: "nonexistent-uid-12345",
      mcp_name: "some-mcp",
      tool_name: "some-tool",
      arguments: {},
    })) as { error?: string };

    expect(data).toHaveProperty("error");
    expect(data.error).toContain("不存在");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. proxy_status — 查看子 MCP 进程状态
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy_status", () => {
  let leaderSid: string;

  beforeAll(async () => {
    leaderSid = await registerSession("");
  });

  afterAll(async () => {
    await safeUnregister(leaderSid);
  });

  test("proxy_status 返回合理结构", async () => {
    const data = (await callWith(leaderSid, "proxy_status", {})) as Record<
      string,
      unknown
    >;

    // proxy_status 返回当前活跃的子 MCP 进程信息
    expect(data).toBeDefined();
    expect(typeof data).toBe("object");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. 完整生命周期：install → mount → unmount → uninstall
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP full lifecycle", () => {
  let leaderSid: string;
  let memberUid: string;
  const lifecycleMcp = "lifecycle-test-mcp";

  beforeAll(async () => {
    leaderSid = await registerSession("");
    const uid = getMemberUid(TEST_MEMBER);
    if (!uid) throw new Error(`Member ${TEST_MEMBER} has no uid`);
    memberUid = uid;
  });

  afterAll(async () => {
    // 兜底清理
    try {
      await callWith(leaderSid, "unmount_mcp", {
        uid: memberUid,
        mcp_name: lifecycleMcp,
      });
    } catch {
      /* ignore */
    }
    try {
      await callWith(leaderSid, "uninstall_store_mcp", {
        caller: LEADER_CALLER,
        mcp_name: lifecycleMcp,
      });
    } catch {
      /* ignore */
    }
    await safeUnregister(leaderSid);
  });

  test("install → mount → list shows mounted → unmount → list shows unmounted → uninstall → list empty", async () => {
    // Step 1: install to store
    const installData = (await callWith(leaderSid, "install_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: lifecycleMcp,
      command: "echo",
      args: ["lifecycle"],
      description: "lifecycle test",
    })) as { success: boolean };
    expect(installData.success).toBe(true);

    // Step 2: mount
    const mountData = (await callWith(leaderSid, "mount_mcp", {
      uid: memberUid,
      mcp_name: lifecycleMcp,
    })) as { success: boolean };
    expect(mountData.success).toBe(true);

    // Step 3: list shows mounted
    const listAfterMount = (await callWith(leaderSid, "list_member_mcps", {
      uid: memberUid,
    })) as { store_mcps: Array<{ name: string; mounted: boolean }> };
    const mountedEntry = listAfterMount.store_mcps.find(
      (m) => m.name === lifecycleMcp
    );
    expect(mountedEntry).toBeDefined();
    expect(mountedEntry!.mounted).toBe(true);

    // Step 4: unmount
    const unmountData = (await callWith(leaderSid, "unmount_mcp", {
      uid: memberUid,
      mcp_name: lifecycleMcp,
    })) as { success: boolean };
    expect(unmountData.success).toBe(true);

    // Step 5: list shows unmounted
    const listAfterUnmount = (await callWith(leaderSid, "list_member_mcps", {
      uid: memberUid,
    })) as { store_mcps: Array<{ name: string; mounted: boolean }> };
    const unmountedEntry = listAfterUnmount.store_mcps.find(
      (m) => m.name === lifecycleMcp
    );
    if (unmountedEntry) {
      expect(unmountedEntry.mounted).toBe(false);
    }

    // Step 6: uninstall from store
    const uninstallData = (await callWith(leaderSid, "uninstall_store_mcp", {
      caller: LEADER_CALLER,
      mcp_name: lifecycleMcp,
    })) as { success: boolean };
    expect(uninstallData.success).toBe(true);

    // Step 7: list_store_mcps no longer has it
    const finalStore = (await callWith(leaderSid, "list_store_mcps", {})) as {
      store: Array<{ name: string }>;
    };
    const gone = finalStore.store.find((m) => m.name === lifecycleMcp);
    expect(gone).toBeUndefined();
  });
});
