#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  acquireLock,
  takeover,
  releaseLock,
  readLock,
  updateLock,
  forceRelease,
} from "./lock-manager.js";
import { initSession, registerLockNonce, unregisterLockNonce, getLockNonce } from "./session-manager.js";
import {
  saveProfile,
  getProfile,
  listMembers,
  appendWorkLog,
  readWorkLog,
  type MemberProfile,
} from "./member-store.js";
import {
  saveMemory,
  readMemory,
  submitExperience,
  readShared,
  searchExperience,
} from "./memory-store.js";
import {
  proposeRule,
  reviewRules,
  approveRule,
  rejectRule,
} from "./rule-manager.js";
import { launchPanel, isPanelRunning } from "./panel-launcher.js";
import { LEADER_ROLES, DEFAULT_STUCK_TIMEOUT_MINUTES } from "./constants.js";

// ──────────────────────────────────────────────
// 目录初始化
// ──────────────────────────────────────────────
const HUB_DIR = path.join(os.homedir(), ".claude", "team-hub");
const MEMBERS_DIR = path.join(HUB_DIR, "members");
const SHARED_DIR = path.join(HUB_DIR, "shared");
const SESSIONS_DIR = path.join(HUB_DIR, "sessions");
const TEMPLATES_DIR = path.join(HUB_DIR, "templates");

for (const dir of [HUB_DIR, MEMBERS_DIR, SHARED_DIR, SESSIONS_DIR, TEMPLATES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 启动 session（清理孤儿锁、注册 stdin 关闭处理）
const { pid: sessionPid, lstart: sessionStart } = initSession(HUB_DIR);

// 启动面板
launchPanel(HUB_DIR);

// ──────────────────────────────────────────────
// 权限检查
// ──────────────────────────────────────────────
function checkPrivilege(caller: string, action: string): void {
  const profile = getProfile(MEMBERS_DIR, caller);
  const isPrivileged =
    LEADER_ROLES.includes(caller) || (profile?.role === "leader");
  if (!isPrivileged) {
    throw new Error(`caller '${caller}' does not have permission to ${action}`);
  }
}

// ──────────────────────────────────────────────
// MCP Server
// ──────────────────────────────────────────────
const server = new Server(
  { name: "mcp-team-hub", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ──────────────────────────────────────────────
// Tool 定义
// ──────────────────────────────────────────────
const tools = [
  // ── 状态管理 ──────────────────────────────
  {
    name: "check_in",
    description: "成员签到，获取工作锁，开始在某项目上工作某任务",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名" },
        project: { type: "string", description: "项目名" },
        task: { type: "string", description: "任务描述" },
      },
      required: ["member", "project", "task"],
    },
  },
  {
    name: "check_out",
    description: "成员签出，释放工作锁，结束当前任务",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名" },
        note: { type: "string", description: "完成备注（可选）" },
      },
      required: ["member"],
    },
  },
  {
    name: "get_status",
    description: "查询成员当前状态（是否在工作、工作在什么项目/任务上）",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名，不填则返回全员状态" },
      },
      required: [],
    },
  },
  {
    name: "force_release",
    description: "强制释放某成员的锁（仅 guozong/leader 可用）",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "调用者名" },
        member: { type: "string", description: "被释放锁的成员名" },
      },
      required: ["caller", "member"],
    },
  },
  // ── 记忆 ──────────────────────────────────
  {
    name: "save_memory",
    description: "保存成员的私有记忆（generic 通用或 project 项目专属）",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"] },
        content: { type: "string" },
        project: { type: "string", description: "scope=project 时必填" },
      },
      required: ["member", "scope", "content"],
    },
  },
  {
    name: "read_memory",
    description: "读取成员的私有记忆",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"] },
        project: { type: "string" },
      },
      required: ["member"],
    },
  },
  {
    name: "submit_experience",
    description: "提交经验到共享区（generic/project/team）",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project", "team"] },
        content: { type: "string" },
        project: { type: "string" },
      },
      required: ["member", "scope", "content"],
    },
  },
  {
    name: "read_shared",
    description: "读取共享区内容（experience/rules/pending_rules）",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["experience", "rules", "pending_rules"] },
        scope: { type: "string", enum: ["generic", "project"] },
        project: { type: "string" },
      },
      required: ["type"],
    },
  },
  {
    name: "search_experience",
    description: "在共享经验中搜索关键词",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"] },
      },
      required: ["keyword"],
    },
  },
  // ── 制度 ──────────────────────────────────
  {
    name: "propose_rule",
    description: "提议新规则（进入待审队列）",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        rule: { type: "string" },
        reason: { type: "string" },
      },
      required: ["member", "rule", "reason"],
    },
  },
  {
    name: "review_rules",
    description: "查看待审规则列表",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "approve_rule",
    description: "批准待审规则，移入 rules.md（仅 guozong/leader 可用）",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        rule_id: { type: "string" },
      },
      required: ["caller", "rule_id"],
    },
  },
  {
    name: "reject_rule",
    description: "拒绝待审规则（仅 guozong/leader 可用）",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        rule_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["caller", "rule_id", "reason"],
    },
  },
  // ── 招募 ──────────────────────────────────
  {
    name: "hire_temp",
    description: "雇用临时成员（仅 guozong/leader 可用）",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        name: { type: "string" },
        display_name: { type: "string" },
        role: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["caller", "name", "display_name", "role"],
    },
  },
  {
    name: "evaluate_temp",
    description: "评价临时成员，决定留用或解散（仅 guozong/leader 可用）",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        member: { type: "string" },
        score: { type: "number", description: "1-10" },
        comment: { type: "string" },
        convert_to_permanent: { type: "boolean" },
      },
      required: ["caller", "member", "score", "comment"],
    },
  },
  {
    name: "list_templates",
    description: "列出可用的成员模板",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  // ── 看板 ──────────────────────────────────
  {
    name: "team_report",
    description: "全队状态快照：谁在干什么，谁空闲",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "project_dashboard",
    description: "项目看板：某项目下所有成员的工作状态",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
      },
      required: ["project"],
    },
  },
  {
    name: "work_history",
    description: "查询成员工作历史",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        limit: { type: "number", description: "最多返回条数，默认 20" },
      },
      required: ["member"],
    },
  },
  {
    name: "stuck_scan",
    description: "扫描疑似卡住的成员（持锁超时）",
    inputSchema: {
      type: "object",
      properties: {
        timeout_minutes: { type: "number", description: "超时分钟数，默认 120（2h）" },
      },
      required: [],
    },
  },
  {
    name: "handoff",
    description: "交接：成员将任务移交给另一个成员",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        note: { type: "string" },
      },
      required: ["from", "to"],
    },
  },
] as const;

// ──────────────────────────────────────────────
// Tool handlers
// ──────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  function str(key: string): string {
    const v = a[key];
    if (typeof v !== "string") throw new Error(`missing or invalid param: ${key}`);
    return v;
  }
  function optStr(key: string): string | undefined {
    const v = a[key];
    return typeof v === "string" ? v : undefined;
  }
  function num(key: string, def: number): number {
    const v = a[key];
    return typeof v === "number" ? v : def;
  }
  function bool(key: string, def: boolean): boolean {
    const v = a[key];
    return typeof v === "boolean" ? v : def;
  }

  function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  try {
    switch (name) {
      // ── check_in ──────────────────────────
      case "check_in": {
        const member = str("member");
        const project = str("project");
        const task = str("task");

        const existing = readLock(MEMBERS_DIR, member);

        if (existing) {
          if (existing.session_pid === sessionPid) {
            // 分支1：自己持锁 → 更新任务
            const knownNonce = getLockNonce(member) ?? existing.nonce;
            const result = updateLock(MEMBERS_DIR, member, knownNonce, project, task);
            if (result.success) {
              appendWorkLog(MEMBERS_DIR, member, {
                event: "check_in",
                timestamp: new Date().toISOString(),
                project,
                task,
                note: "task updated (re-check_in)",
              });
            }
            return ok({ ...result, action: "updated" });
          } else {
            // 分支2/3：他人持锁 → 尝试 takeover（内部判断进程是否已死）
            const result = takeover(
              MEMBERS_DIR,
              member,
              sessionPid,
              sessionStart,
              project,
              task
            );
            if (result.success) {
              const lock = readLock(MEMBERS_DIR, member);
              if (lock) registerLockNonce(member, lock.nonce);
              appendWorkLog(MEMBERS_DIR, member, {
                event: "check_in",
                timestamp: new Date().toISOString(),
                project,
                task,
                note: `takeover from pid ${existing.session_pid}`,
              });
            }
            return ok({ ...result, action: result.success ? "takeover" : "rejected" });
          }
        }

        // 无锁 → 正常抢锁
        const result = acquireLock(
          MEMBERS_DIR,
          member,
          sessionPid,
          sessionStart,
          project,
          task
        );

        if (result.success) {
          const lock = readLock(MEMBERS_DIR, member);
          if (lock) registerLockNonce(member, lock.nonce);

          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_in",
            timestamp: new Date().toISOString(),
            project,
            task,
          });
        }
        return ok({ ...result, action: result.success ? "acquired" : "failed" });
      }

      // ── check_out ─────────────────────────
      case "check_out": {
        const member = str("member");
        const note = optStr("note");

        const lock = readLock(MEMBERS_DIR, member);
        if (!lock) {
          return ok({ success: false, error: "not checked in" });
        }

        const result = releaseLock(MEMBERS_DIR, member, lock.nonce);
        if (result.success) {
          unregisterLockNonce(member);
          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_out",
            timestamp: new Date().toISOString(),
            project: lock.project,
            task: lock.task,
            note,
          });
        }
        return ok(result);
      }

      // ── get_status ────────────────────────
      case "get_status": {
        const member = optStr("member");
        if (member) {
          const lock = readLock(MEMBERS_DIR, member);
          const profile = getProfile(MEMBERS_DIR, member);
          return ok({ member, profile, lock, working: !!lock });
        }
        const members = listMembers(MEMBERS_DIR);
        const statuses = members.map((m) => {
          const lock = readLock(MEMBERS_DIR, m.name);
          return { member: m.name, display_name: m.display_name, role: m.role, working: !!lock, lock };
        });
        return ok(statuses);
      }

      // ── force_release ─────────────────────
      case "force_release": {
        const caller = str("caller");
        const member = str("member");
        checkPrivilege(caller, "force_release");
        const result = forceRelease(MEMBERS_DIR, member);
        if (result.success) unregisterLockNonce(member);
        return ok(result);
      }

      // ── save_memory ───────────────────────
      case "save_memory": {
        const member = str("member");
        const scope = str("scope") as "generic" | "project";
        const content = str("content");
        const project = optStr("project");
        saveMemory(MEMBERS_DIR, member, scope, content, project);
        return ok({ success: true });
      }

      // ── read_memory ───────────────────────
      case "read_memory": {
        const member = str("member");
        const scope = optStr("scope") as "generic" | "project" | undefined;
        const project = optStr("project");
        const content = readMemory(MEMBERS_DIR, member, scope, project);
        return ok({ member, content });
      }

      // ── submit_experience ─────────────────
      case "submit_experience": {
        const member = str("member");
        const scope = str("scope") as "generic" | "project" | "team";
        const content = str("content");
        const project = optStr("project");
        const result = submitExperience(MEMBERS_DIR, SHARED_DIR, member, scope, content, project);
        const resp: Record<string, unknown> = { success: true };
        if (result.similar_lines.length > 0) {
          resp.warning = "similar content may already exist";
          resp.similar_lines = result.similar_lines;
        }
        return ok(resp);
      }

      // ── read_shared ───────────────────────
      case "read_shared": {
        const type = str("type") as "experience" | "rules" | "pending_rules";
        const scope = optStr("scope") as "generic" | "project" | undefined;
        const project = optStr("project");
        const content = readShared(SHARED_DIR, type, scope, project);
        return ok({ content });
      }

      // ── search_experience ─────────────────
      case "search_experience": {
        const keyword = str("keyword");
        const scope = optStr("scope") as "generic" | "project" | undefined;
        const results = searchExperience(SHARED_DIR, keyword, scope);
        return ok({ keyword, results });
      }

      // ── propose_rule ──────────────────────
      case "propose_rule": {
        const member = str("member");
        const rule = str("rule");
        const reason = str("reason");
        const result = proposeRule(SHARED_DIR, member, rule, reason);
        return ok(result);
      }

      // ── review_rules ──────────────────────
      case "review_rules": {
        const rules = reviewRules(SHARED_DIR);
        return ok(rules);
      }

      // ── approve_rule ──────────────────────
      case "approve_rule": {
        const caller = str("caller");
        const ruleId = str("rule_id");
        checkPrivilege(caller, "approve_rule");
        const result = approveRule(SHARED_DIR, ruleId, caller);
        return ok(result);
      }

      // ── reject_rule ───────────────────────
      case "reject_rule": {
        const caller = str("caller");
        const ruleId = str("rule_id");
        const reason = str("reason");
        checkPrivilege(caller, "reject_rule");
        const result = rejectRule(SHARED_DIR, ruleId, reason);
        return ok(result);
      }

      // ── hire_temp ─────────────────────────
      case "hire_temp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const name = str("name");
        const displayName = str("display_name");
        const role = str("role");
        const skills = Array.isArray(a["skills"])
          ? (a["skills"] as string[])
          : [];
        const description = optStr("description");
        const profile: MemberProfile = {
          name,
          display_name: displayName,
          role,
          type: "temporary",
          joined_at: new Date().toISOString(),
          skills,
          description,
        };
        saveProfile(MEMBERS_DIR, profile);
        return ok({ success: true, profile });
      }

      // ── evaluate_temp ─────────────────────
      case "evaluate_temp": {
        const caller = str("caller");
        checkPrivilege(caller, "evaluate_temp");
        const member = str("member");
        const score = num("score", 0);
        const comment = str("comment");
        const convertToPermanent = bool("convert_to_permanent", false);

        const profile = getProfile(MEMBERS_DIR, member);
        if (!profile) return ok({ success: false, error: "member not found" });

        const evalEntry = {
          evaluator: caller,
          score,
          comment,
          evaluated_at: new Date().toISOString(),
          converted: convertToPermanent,
        };
        const evalPath = path.join(MEMBERS_DIR, member, "evaluations.jsonl");
        fs.appendFileSync(evalPath, JSON.stringify(evalEntry) + "\n", "utf-8");

        if (convertToPermanent) {
          profile.type = "permanent";
          saveProfile(MEMBERS_DIR, profile);
        }

        return ok({ success: true, evaluation: evalEntry });
      }

      // ── list_templates ────────────────────
      case "list_templates": {
        const templates: unknown[] = [];
        if (fs.existsSync(TEMPLATES_DIR)) {
          for (const f of fs.readdirSync(TEMPLATES_DIR)) {
            if (!f.endsWith(".json")) continue;
            try {
              const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf-8");
              templates.push({ file: f, ...JSON.parse(raw) });
            } catch {
              // 跳过损坏文件
            }
          }
        }
        return ok(templates);
      }

      // ── team_report ───────────────────────
      case "team_report": {
        const members = listMembers(MEMBERS_DIR);
        const working: unknown[] = [];
        const idle: unknown[] = [];
        for (const m of members) {
          const lock = readLock(MEMBERS_DIR, m.name);
          if (lock) {
            working.push({ name: m.name, display_name: m.display_name, role: m.role, lock });
          } else {
            idle.push({ name: m.name, display_name: m.display_name, role: m.role });
          }
        }
        return ok({ working, idle, total: members.length });
      }

      // ── project_dashboard ─────────────────
      case "project_dashboard": {
        const project = str("project");
        const members = listMembers(MEMBERS_DIR);
        const result: unknown[] = [];
        for (const m of members) {
          const lock = readLock(MEMBERS_DIR, m.name);
          if (lock && lock.project === project) {
            result.push({ name: m.name, display_name: m.display_name, task: lock.task, locked_at: lock.locked_at });
          }
        }
        return ok({ project, members: result });
      }

      // ── work_history ──────────────────────
      case "work_history": {
        const member = str("member");
        const limit = num("limit", 20);
        const logs = readWorkLog(MEMBERS_DIR, member);
        return ok({ member, history: logs.slice(-limit) });
      }

      // ── stuck_scan ────────────────────────
      case "stuck_scan": {
        const timeoutMinutes = num("timeout_minutes", DEFAULT_STUCK_TIMEOUT_MINUTES);
        const now = Date.now();
        const stuck: unknown[] = [];
        const members = listMembers(MEMBERS_DIR);
        for (const m of members) {
          const lock = readLock(MEMBERS_DIR, m.name);
          if (!lock) continue;
          const lockedAt = new Date(lock.locked_at).getTime();
          const elapsed = (now - lockedAt) / 60000;
          if (elapsed > timeoutMinutes) {
            stuck.push({ name: m.name, lock, elapsed_minutes: Math.round(elapsed) });
          }
        }
        return ok({ stuck, timeout_minutes: timeoutMinutes });
      }

      // ── handoff ───────────────────────────
      case "handoff": {
        const from = str("from");
        const to = str("to");
        const note = optStr("note");

        const fromLock = readLock(MEMBERS_DIR, from);
        if (!fromLock) return ok({ success: false, error: `${from} is not checked in` });

        const relResult = releaseLock(MEMBERS_DIR, from, fromLock.nonce);
        if (!relResult.success) return ok(relResult);
        unregisterLockNonce(from);

        appendWorkLog(MEMBERS_DIR, from, {
          event: "check_out",
          timestamp: new Date().toISOString(),
          project: fromLock.project,
          task: fromLock.task,
          note: `handoff to ${to}: ${note ?? ""}`,
        });

        const acqResult = acquireLock(
          MEMBERS_DIR,
          to,
          sessionPid,
          sessionStart,
          fromLock.project,
          fromLock.task
        );
        if (acqResult.success) {
          const toLock = readLock(MEMBERS_DIR, to);
          if (toLock) registerLockNonce(to, toLock.nonce);
          appendWorkLog(MEMBERS_DIR, to, {
            event: "check_in",
            timestamp: new Date().toISOString(),
            project: fromLock.project,
            task: fromLock.task,
            note: `handoff from ${from}: ${note ?? ""}`,
          });
        }

        return ok({ success: acqResult.success, from, to, project: fromLock.project, task: fromLock.task });
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    const e = err as Error;
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
  }
});

// ──────────────────────────────────────────────
// 启动
// ──────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mcp-team-hub] server started, hub=${HUB_DIR}, session_pid=${sessionPid}\n`);
