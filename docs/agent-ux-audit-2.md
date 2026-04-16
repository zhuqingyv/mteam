# Agent UX Audit Report (Auditor B)

Date: 2026-04-16
Auditor: adian (second auditor, independent review)
Scope: packages/mcp-server/src/index.ts, hub.ts, member-store.ts

---

## 1. MCP_INSTRUCTIONS Evaluation

The system prompt is defined at `index.ts:125-171`, injected via `instructions` field of the MCP Server constructor.

### Strengths

1. **Clear mental model**: Opens with "team-hub is not agent creation, it's a memory repository" -- correctly sets expectations.
2. **Role separation explicit**: Lists which tools are leader-only vs member-only vs shared.
3. **Lifecycle spelled out**: `activate -> work -> checkpoint -> save_memory -> deactivate` is clear and linear.
4. **Departure flow documented**: The two-phase `request_departure -> clock_out` with cancellation noted.

### Problems

| # | Issue | Severity | Evidence |
|---|-------|----------|----------|
| I-1 | **No tool count or categorization overview** -- agent receives 42 tools with no grouping guidance. An agent seeing 42 tools in ListTools will be overwhelmed. The instructions mention some tools but not all. | HIGH | Tools like `add_project_experience`, `add_project_rule`, `get_project_rules`, `delete_project`, `handoff`, `cancel_reservation` are never mentioned in MCP_INSTRUCTIONS. |
| I-2 | **Member lifecycle section is too terse** -- `activate(reservation_code) -> work -> checkpoint() -> save_memory() -> deactivate()` lacks parameter details. A fresh agent won't know `activate` needs `member` param too. | MEDIUM | Line 139: parameters omitted. |
| I-3 | **Leader usage section omits `auto_spawn=true`** -- the most common path (auto_spawn) is not mentioned in the "Leader usage" section. Leader has to discover it from tool description. | MEDIUM | Line 134: `request_member(member, project, task, auto_spawn=true)` but `auto_spawn` is not shown. Wait -- it IS shown. Correction: it is listed. But the workflow after auto_spawn (just `send_msg`) vs manual spawn is not differentiated. |
| I-4 | **"Member-only tools" list is incomplete** -- `propose_rule` is listed under shared tools in the governance section, but line 147 says member-only tools include `check_in, check_out, check_inbox, clock_out` while `propose_rule` is available to all. The permission model at line 163-165 contradicts line 147 partially. `check_inbox` appears in both "member-only" (line 147) and "all" (line 165). | MEDIUM | Lines 147 vs 165: `check_inbox` in both lists. |
| I-5 | **No guidance on error recovery** -- what should an agent do if `activate` fails? If `save_memory` fails? If `deactivate` fails? No fallback instructions. | HIGH | Complete absence in MCP_INSTRUCTIONS. |
| I-6 | **MCP proxy section is confusing** -- `install_store_mcp -> mount_mcp -> proxy_tool` is mentioned but the UID requirement is buried in tool descriptions, not in MCP_INSTRUCTIONS. Agent won't know it needs UID until it hits the tool. | LOW | Line 160. |
| I-7 | **No mention of `checkpoint`'s purpose** -- checkpoint is in the lifecycle but its value proposition (self-audit against original task) is not explained in instructions. | LOW | Line 139. |

### Overall Grade: B-

The instructions cover the happy path adequately but fail on error recovery, tool discoverability for the long tail of 42 tools, and edge case guidance. An experienced agent model will figure it out from tool descriptions, but a less capable model will struggle.

---

## 2. Tool-by-Tool Audit

### Legend
- **Scene**: Does the description guide when/why to use this tool?
- **Params**: Are parameters clear with types and semantics?
- **Return**: Does the description explain what the return value contains and what to do next?
- **Error**: Are error cases surfaced with actionable guidance?

| Tool | Scene | Params | Return | Error | Notes |
|------|-------|--------|--------|-------|-------|
| `check_in` | OK | OK | OK (hint) | OK (branch hints) | Well designed. Redundant with activate for normal flow -- description correctly says "only for switching project/task". |
| `check_out` | OK | OK | OK (hint) | OK | Description says "emergency only, use deactivate" -- good guardrail. |
| `get_status` | OK | OK (optional member) | OK | -- | No error case documented but implementation handles missing member gracefully. |
| `force_release` | OK | OK | OK (hint) | -- | `caller` permission check is good. |
| `save_memory` | OK | ISSUE | OK (hint) | OK | **scope enum `["generic", "project"]` but project param described as "only when scope=project" -- no validation hint if agent passes scope=project without project param. Implementation will save to wrong path silently.** |
| `read_memory` | OK | OK | OK | -- | Good: scope defaults to generic. |
| `submit_experience` | OK | OK | OK | OK (duplicate detection) | Similar content warning is a nice touch. |
| `read_shared` | OK | OK | OK | -- | Clean. |
| `search_experience` | OK | OK | OK (empty hint) | -- | Good empty-result guidance. |
| `propose_rule` | OK | OK | OK (hint to notify leader) | -- | Clean. |
| `review_rules` | OK | -- | OK (action hint) | -- | No params needed. |
| `approve_rule` | OK | OK | OK | -- | Clean. |
| `reject_rule` | OK | OK | OK | -- | Clean. |
| `hire_temp` | OK | OK | OK (next step hint) | -- | Good: hint chains to `request_member`. |
| `evaluate_temp` | OK | OK | OK | OK (not found) | `convert_to_permanent` default not documented in schema -- **agent might forget to pass it and temp member stays temp forever without explicit guidance.** |
| `list_templates` | OK | -- | OK (empty hint) | -- | Clean. |
| `team_report` | OK | -- | OK (hint) | -- | Clean. |
| `project_dashboard` | OK | OK | OK (hint) | -- | Clean. |
| `work_history` | OK | OK | OK | -- | Clean. |
| `stuck_scan` | OK | OK (default 120min) | OK (action_hint) | -- | Excellent: 3-step action hint for stuck members. |
| `handoff` | ISSUE | OK | OK (hint) | OK | **Description says "to needs to call activate (no reservation_code needed, handoff transferred the formal lock)" but this is a critical instruction buried in a long description. Agent receiving the handoff notification needs to know this, but the notification message (line 1731) already contains the instruction. OK on second look -- the PTY message includes the activate instruction. However, the `from` member's session still tracks the lock nonce for `to` (line 1720) which could conflict if `to` is in a different session.** |
| `request_member` | OK | ISSUE | OK (usage_hint) | OK | **`workspace_path` description says "passed to member terminal as cwd, also pre-writes trust" but what "trust" means is unexplained. Agent won't understand this.** Also: `auto_spawn` defaults to `false` in schema but description says "recommended: auto_spawn=true" -- should default be `true`? |
| `cancel_reservation` | OK | OK | OK | OK (not found) | Clean. |
| `activate` | OK | ISSUE | OK (workflow_hint) | OK | **`reservation_code` is described as "recommended required" (line 663) which is contradictory. Either it's required or optional. The backward-compat path (no code) is confusing -- agent doesn't know when this applies.** |
| `deactivate` | OK | OK | OK (hint) | OK | Clean. Good save_memory guard. |
| `release_member` | OK | OK | OK (hint) | OK | Good distinction from force_release in description. |
| `get_roster` | OK | -- | OK (summary + hints) | -- | Excellent return value design with availability hints. |
| `get_team_rules` | OK | -- | OK | -- | Clean. |
| `proxy_tool` | ISSUE | ISSUE | OK | OK | **UID acquisition path described 3 different ways across description. "uid from activate return identity.uid, or from get_roster roster[].uid" -- OK but repetitive. Bigger issue: `arguments` param is `type: object` with no schema guidance. Agent has to call `list_member_mcps` first to know what to pass, but this dependency is only in the description, not enforced.** |
| `list_member_mcps` | OK | OK | OK | OK | Clean. |
| `install_member_mcp` | OK | OK | OK | -- | No error handling for duplicate install. |
| `uninstall_member_mcp` | OK | OK | OK | -- | **Implementation at line 2347-2348: calls `cleanupMemberMcps(member)` which kills ALL MCPs, not just the one being uninstalled. Bug or design choice? Description says "auto-cleans running child process" (singular) but code kills all.** |
| `proxy_status` | OK | -- | OK | -- | Clean. |
| `cleanup_member_mcps` | OK | OK | OK | -- | Clean. |
| `install_store_mcp` | OK | OK | OK | -- | Returns full store list -- good for verification. |
| `uninstall_store_mcp` | OK | OK | OK | -- | Clean. |
| `list_store_mcps` | OK | -- | OK | -- | Clean. |
| `mount_mcp` | OK | OK | OK | OK | Returns tools list -- good. |
| `unmount_mcp` | OK | OK | OK | -- | Clean. Correctly notes deactivate auto-cleans. |
| `create_project` | OK | OK | OK (hint) | -- | Clean. |
| `get_project` | OK | OK | OK | OK (not found) | Clean. |
| `list_projects` | OK | -- | OK (hint) | -- | Good: duplicate project prevention hint. |
| `update_project` | ISSUE | ISSUE | OK | OK | **`members` param says "full replacement" -- agent might not realize passing `members: ["A"]` removes B and C. Same for `forbidden` and `rules`. This is a destructive operation with no confirmation.** |
| `add_project_experience` | OK | OK | OK | OK | Clean. Append-only is good. |
| `add_project_rule` | OK | OK | OK | -- | Clean. Additive. |
| `get_project_rules` | OK | OK | OK | OK | Clean. |
| `checkpoint` | OK | OK | OK | OK | Excellent: returns original task + rules + verification prompts. Best-designed tool in the set. |
| `delete_project` | OK | OK | OK | OK | Clean. Warns about irreversibility. |
| `scan_agent_clis` | OK | -- | OK | OK | Clean. |
| `spawn_pty_session` | OK | OK | OK | OK | Good: notes usually called via request_member indirectly. |
| `list_pty_sessions` | OK | -- | OK | OK | Clean. |
| `kill_pty_session` | OK | OK | OK | OK | Clean. |
| `send_msg` | ISSUE | ISSUE | OK | OK | **`from` is described as "auto-inferred from session" and "cannot be manually specified" but there is no `from` in inputSchema at all. This is correct behavior but the description should explicitly say "no from param needed". Also: if session has no activatedMembers AND no memberName, from becomes "unknown" (line 2671) -- recipient gets a message from "unknown" with no way to reply.** |
| `check_inbox` | OK | OK | OK | OK | **Implementation uses DELETE method (line 2694) -- messages are consumed on read. This is never documented in the tool description. Agent might call check_inbox twice expecting to re-read messages but they're gone.** |
| `request_departure` | OK | OK | OK (hint) | OK | Well designed. Async nature clearly stated. |
| `clock_out` | OK | OK | OK (hint) | OK | Good: triple permission check (not leader, is self, has pending_departure). |

### Critical Findings from Tool Audit

1. **check_inbox is destructive read** (messages consumed on read) -- undocumented
2. **uninstall_member_mcp kills ALL MCPs** not just the target one
3. **update_project uses full replacement** for arrays -- easy data loss
4. **send_msg from "unknown"** when session state is ambiguous
5. **save_memory scope=project without project param** fails silently

---

## 3. Multi-Tool Flow Walkthroughs

### Flow 1: hire_temp -> request_member -> activate -> check_in

**Simulation (agent perspective):**

1. `hire_temp(caller="leader", name="temp-dev", role="dev")` -- returns profile + hint to request_member. **OK**
2. `request_member(caller="leader", member="temp-dev", project="X", task="Y", auto_spawn=true)` -- returns reservation_code + usage_hint. **OK**
3. (Member agent spawns in terminal, reads spawn prompt with reservation_code)
4. `activate(member="temp-dev", reservation_code="xxx")` -- returns persona, memory, rules, workflow_hint. **OK**
5. `check_in` -- not needed, activate already signs in. Description says so. **OK**

**Verdict: OK** -- hint chain flows naturally from hire_temp -> request_member -> activate.

One gap: Between steps 2 and 3, the leader needs to `send_msg(to="temp-dev", content="task description")` to give the member instructions. The `usage_hint` from `request_member` correctly guides this. But the member's spawn prompt needs to include the reservation_code -- this depends on Panel's PTY spawn implementation which is outside this audit scope.

### Flow 2: request_departure -> member notification -> save_memory -> clock_out

**Simulation:**

1. Leader: `request_departure(member="dev-A", pending=true, requirement="release done, wrap up")` -- returns success + async hint. **OK**
2. System sends PTY message to dev-A: "[departure notice] leader requires you to leave..." with behavioral guidance. **OK, message is well-structured.**
3. dev-A receives message (either via PTY stdin injection or next `check_inbox`).
4. dev-A: `save_memory(member="dev-A", scope="project", content="...", project="X")` -- saves work. **OK**
5. dev-A: `clock_out(member="dev-A", note="wrapped up")` -- releases lock, cleans MCP, deletes heartbeat, kills PTY, notifies leader. **OK**

**Verdict: OK** -- this is the best-designed flow in the system.

**One subtlety**: clock_out does NOT check if save_memory was called (unlike deactivate which does). This means a member could clock_out without saving memory. Is this intentional? The departure flow assumes the member is responsible, but the `requirement` text from leader could include "save your work" -- this is left to the leader's diligence.

**Rating: OK with minor gap** (no save_memory guard in clock_out).

### Flow 3: send_msg -> check_inbox -> send_msg reply

**Simulation:**

1. Leader: `send_msg(to="dev-A", content="implement feature X")` -- from auto-inferred. **OK**
2. dev-A: How does dev-A know a message arrived? Two paths:
   - **PTY injection**: message written directly to terminal stdin. Agent sees it as user input. **OK but depends on Panel.**
   - **Polling**: `check_inbox(member="dev-A")` -- but messages are consumed on read (DELETE). **Problem: if PTY delivery succeeded, check_inbox returns empty. If PTY delivery failed, message sits in inbox but agent doesn't know to check.**

3. dev-A: `send_msg(to="leader", content="done")` -- but `from` is auto-inferred from session. If dev-A's session has `activatedMembers` containing "dev-A", from="dev-A". **OK.**
4. Leader receives reply via PTY injection or check_inbox.

**Verdict: WARNING**

The dual delivery mechanism (PTY + inbox) creates confusion:
- If PTY delivery works, the inbox variant is redundant but harmless.
- If PTY delivery fails silently, messages pile up in inbox with no notification to the recipient.
- **check_inbox consumes messages on read** -- calling it twice loses messages.
- **No delivery receipt or read confirmation** -- sender has no way to know if message was received.

**Rating: WARNING** -- message delivery is fire-and-forget with destructive read.

### Flow 4: propose_rule -> review_rules -> approve/reject_rule

**Simulation:**

1. Member: `propose_rule(member="dev-A", rule="no direct DB writes", reason="caused prod incident")` -- returns hint to notify leader. **OK**
2. Member: `send_msg(to="leader", content="proposed a new rule, please review")` -- **the agent must know to do this. The hint says "notify leader" but doesn't explicitly say use send_msg.** Minor gap.
3. Leader: `review_rules()` -- returns pending rules with IDs. **OK**
4. Leader: `approve_rule(caller="leader", rule_id="xxx")` -- approved + hint to continue reviewing. **OK**

**Verdict: OK** -- clean flow. Minor: propose_rule hint should say "send_msg(to=leader)" explicitly.

### Flow 5: install_store_mcp -> mount_mcp -> proxy_tool

**Simulation:**

1. Leader: `install_store_mcp(caller="leader", mcp_name="my-tool", command="npx", args=["my-tool-server"])` -- returns success + full store. **OK**
2. Member (needs UID): `mount_mcp(uid="xxx", mcp_name="my-tool")` -- returns tools list. **OK**
3. Member: `proxy_tool(uid="xxx", mcp_name="my-tool", tool_name="do_thing", arguments={...})` -- proxied call. **OK**

**Issue**: Between steps 1 and 2, the member needs to know the MCP was installed. No notification mechanism. Leader would need to `send_msg` to tell the member, or member checks `list_store_mcps` proactively.

**Issue**: Member needs their own UID for mount_mcp and proxy_tool. UID is returned by `activate` in `identity.uid`, so member has it. But if member forgot to note it down, they'd need to call `get_roster` to find their own UID -- odd but workable.

**Verdict: WARNING** -- no push notification for new store MCPs; UID requirement adds friction.

### Flow 6: save_memory -> clock_out -> request_member (new person) -> activate -> read_memory (handoff)

**Simulation:**

1. dev-A: `save_memory(member="dev-A", scope="project", content="task X is 80% done, remaining: ...", project="proj")` **OK**
2. dev-A: `clock_out(member="dev-A")` -- offline. **OK**
3. Leader: `request_member(caller="leader", member="dev-B", project="proj", task="continue task X", auto_spawn=true)` **OK**
4. dev-B: `activate(member="dev-B", reservation_code="yyy")` -- returns memory_project for "proj". **BUT**: this returns dev-B's own project memory, not dev-A's. **CRITICAL GAP**.

**The handoff breaks here.** dev-B's `activate` loads `memory_project` scoped to dev-B + project "proj". dev-A's memories are stored under dev-A's directory. There is no mechanism to transfer dev-A's project memory to dev-B.

The only way dev-B could access dev-A's knowledge is if:
- dev-A used `submit_experience` (team-shared) instead of just `save_memory` (personal)
- dev-B searches for it via `search_experience`

But `save_memory` is personal. The task handoff flow loses all personal context.

**Verdict: CRITICAL BUG** -- task handoff across different members loses personal project memory. `save_memory` and `submit_experience` serve different purposes but the handoff flow doesn't bridge the gap.

**Workaround path**: The `handoff` tool (different from this flow) keeps the same project/task assignment but doesn't transfer memory either. The handoff notification (line 1731) tells dev-B to `activate` but doesn't mention reading dev-A's experience.

---

## 4. Async Communication Chokepoints

### Chokepoint 1: Message Delivery Uncertainty

**Problem**: `send_msg` has two delivery paths (PTY stdin injection via Panel, and inbox storage). The sender gets `{ sent: true }` regardless of whether the recipient actually received the message. If Panel is down, the entire delivery fails silently (returns error, but the caller might just retry or give up).

**Impact**: Leader sends task to member, member never gets it, leader assumes work is underway. No timeout or delivery confirmation.

**Evidence**: `hub.ts:2676-2688` -- callPanel failure returns error to sender, but there's no retry or fallback to inbox-only storage.

### Chokepoint 2: check_inbox Destructive Read

**Problem**: `check_inbox` uses HTTP DELETE (line 2694), consuming messages. If an agent calls it, processes some messages, then crashes before acting on them, those messages are permanently lost.

**Impact**: Messages from teammates disappear without being acted upon.

**Evidence**: `hub.ts:2694` -- `DELETE /api/message/inbox/{member}`. No read-without-consume option.

### Chokepoint 3: No Notification Push for Offline Members

**Problem**: If a member is offline when a message is sent (PTY not running), the message goes to inbox. But there's no mechanism to alert the member when they come online. `activate` does NOT check inbox as part of its return payload.

**Impact**: Member activates, starts working, never checks inbox, misses critical messages from previous sessions.

**Evidence**: `activate` implementation (hub.ts:1972-2133) -- never reads or mentions inbox. `workflow_hint` doesn't include "check your inbox".

### Chokepoint 4: Reservation Timeout Without Notification

**Problem**: Reservations have a 210-second TTL. If the terminal takes longer to spawn (slow machine, network issues), the reservation expires silently. The member's `activate` then fails with "reservation expired, please re-request". But the leader isn't notified of this failure.

**Impact**: Leader moves on, member is stuck in an expired reservation loop with no one aware.

**Evidence**: `hub.ts:1995-1997` -- returns error to member but no notification to the reserving caller.

### Chokepoint 5: Leader-to-Leader Communication Gap

**Problem**: If the leader session dies and a new leader session starts, there's no mechanism to recover the previous leader's context. Sessions are in-memory (`sessions` Map), not persisted. The new leader starts with zero knowledge of what was assigned.

**Impact**: After leader crash, all in-flight work is invisible until the new leader manually calls `team_report` and `get_roster`.

**Evidence**: `hub.ts:159` -- `const sessions = new Map()`. Not persisted to disk. `registerSession` creates fresh state.

---

## 5. Error Message Design Review

### Good Error Messages

| Tool | Error | Why It's Good |
|------|-------|---------------|
| `activate` | "reservation expired, please re-request via request_member" | Actionable -- tells exactly what to do next. |
| `deactivate` | "please call save_memory first, or pass force=true to skip" | Gives both the correct path and the escape hatch. |
| `clock_out` | "you haven't been approved for departure, cannot clock out on your own" | Clear permission model explanation. |
| `request_departure` | "member X is currently offline, cannot request departure" | Explains precondition. |
| `check_in` | "currently occupied by another session and their process is still alive, contact leader to force_release" | Points to escalation path. |

### Bad Error Messages

| Tool | Error | Problem | Suggested Fix |
|------|-------|---------|---------------|
| `check_out` | `{ success: false, error: "not checked in" }` | Agent doesn't know what "not checked in" means in context. Was the lock stolen? Did it expire? | "No active work lock found. Possible causes: lock was force-released by leader, or session expired. Call get_status(member=you) to check." |
| `proxy_tool` | `throw new Error("UID xxx does not exist")` | Raw exception. Doesn't guide to get_roster to find correct UID. | "UID not found. Use get_roster() to look up the correct UID for the target member." |
| `activate` | `{ error: "activation failed: unable to acquire work lock" }` | No explanation of WHY lock acquisition failed. Race condition? Occupied? | Include the underlying acquireLock error message. |
| `save_memory` | `{ error: "member X not activated, call activate first" }` | If member thought they were activated but session was cleaned up, this is confusing. | Add: "Your session may have been cleaned up due to inactivity. Re-request via request_member." |
| `send_msg` (Panel down) | `{ error: "Panel communication failed: ..." }` | Technical error exposed to agent. Agent can't fix Panel connectivity. | "Message delivery failed (Panel unavailable). Retry later or ask leader to check Panel status." |
| Generic catch-all | `{ error: e.message }` (line 2962) | Raw JS error message for any unhandled exception. Could be anything from "Cannot read property..." to stack traces. | Wrap in a user-friendly message: "Internal error occurred. Please report to leader: {original_message}" |

---

## 6. Top 10 Must-Fix Items

### 1. [CRITICAL] check_inbox Destructive Read -- Undocumented

**Location**: `hub.ts:2694`
**Problem**: Messages are consumed on read (HTTP DELETE) but this is never mentioned in the tool description. Agent might call check_inbox twice expecting idempotent reads.
**Fix**: Either (a) document the destructive nature in tool description AND add a `peek` option that reads without consuming, or (b) change to non-destructive reads with explicit `acknowledge_inbox` tool.

### 2. [CRITICAL] Task Handoff Loses Personal Memory

**Location**: Flow 6 analysis above.
**Problem**: When member A saves project memory and member B takes over the same project, B cannot access A's personal project memory. The `save_memory` / `read_memory` system is per-member, with no cross-member access.
**Fix**: Add `read_member_memory(target_member, scope, project)` tool for reading another member's memory (with leader permission or same-project permission). Or auto-include predecessor's latest project memory in `activate` return when task was handed off.

### 3. [HIGH] activate Does Not Surface Pending Inbox Messages

**Location**: `hub.ts:1972-2133`
**Problem**: Member activates and receives persona, memory, rules -- but never learns about pending inbox messages. Critical messages from leader or previous teammates go unread until agent decides to check_inbox (which they have no reason to do proactively).
**Fix**: In `activate`'s return payload, add `pending_messages_count: N` or directly include pending messages.

### 4. [HIGH] send_msg from "unknown" When Session State Is Ambiguous

**Location**: `hub.ts:2669-2671`
**Problem**: If a session has no activatedMembers and no memberName (e.g., leader sends before any member is activated), `from` defaults to "unknown". Recipient gets a message from "unknown" and cannot reply.
**Fix**: For leader sessions, set from="leader" (the session knows `isLeader=true`). Only fall back to "unknown" if truly unidentifiable, and include session_id in the message metadata for tracing.

### 5. [HIGH] uninstall_member_mcp Kills ALL MCPs

**Location**: `hub.ts:2347-2348`
**Problem**: `uninstall_member_mcp` calls `cleanupMemberMcps(member)` which kills ALL running MCP child processes for that member, not just the one being uninstalled. A member with 3 MCPs running loses all of them when one is uninstalled.
**Fix**: Replace `cleanupMemberMcps(member)` with `cleanupOneMcp(member, mcpName)` (which already exists and is correctly used in `unmount_mcp` at line 2430).

### 6. [HIGH] update_project Full-Replacement Arrays Without Warning

**Location**: `hub.ts:2542-2558`
**Problem**: `members`, `forbidden`, and `rules` params are full-replacement arrays. Passing `members: ["A"]` silently removes all other members. No confirmation, no diff shown.
**Fix**: Either (a) add `add_member` / `remove_member` atomic operations, or (b) return the previous values in the response so the caller can see what changed, or (c) require a `confirm_overwrite: true` flag when the array length decreases.

### 7. [MEDIUM] MCP_INSTRUCTIONS Missing Error Recovery Guidance

**Location**: `index.ts:125-171`
**Problem**: No guidance on what to do when tools fail. Agent is left to improvise error recovery, which leads to loops (retrying failed activate) or abandonment (giving up after one failure).
**Fix**: Add an "Error Recovery" section: activate fails -> check get_status; save_memory fails -> retry once then deactivate(force=true); deactivate fails -> check_out(force=true) as fallback.

### 8. [MEDIUM] Reservation Expiry Not Notified to Caller

**Location**: `hub.ts:1995-1997`
**Problem**: When a reservation expires, the member gets an error at activate time, but the original caller (leader) is never notified. Leader might wait indefinitely for a member that can never activate.
**Fix**: When reservation expires (either at activate time or during sweep), send a notification to the reserving session/caller. Add `reservation_expired_notify: true` in the reservation object to track this.

### 9. [MEDIUM] save_memory scope=project Without project Param

**Location**: `hub.ts:1396-1414`
**Problem**: If agent calls `save_memory(member="X", scope="project", content="...")` without `project` param, the implementation passes `undefined` to `saveMemory()`. Depending on `memory-store.ts` implementation, this either saves to a wrong path or creates a directory named "undefined". No validation at the hub level.
**Fix**: Add validation: if `scope === "project" && !project` throw explicit error "project param required when scope is 'project'".

### 10. [MEDIUM] clock_out Does Not Guard save_memory

**Location**: `hub.ts:2839-2955`
**Problem**: Unlike `deactivate` (which blocks if save_memory wasn't called), `clock_out` has no such check. A member can clock_out and permanently lose their unsaved work memories.
**Fix**: Add the same `hasMemorySaved` check that `deactivate` uses, with the same `force` bypass option.

---

## Appendix: Positive Callouts

These designs are strong and should be preserved:

1. **checkpoint tool** -- returns original task + rules + self-audit prompts. This is the best-designed tool in the system. Forces agent self-reflection with concrete criteria.

2. **get_roster summary** -- returns availability counts, role gaps, and actionable hints. Excellent for leader decision-making.

3. **Dual fallback pattern (Panel -> local disk)** -- every tool tries Panel first, falls back to direct file I/O. This makes the system resilient to Panel crashes.

4. **Hint chains** -- most tools include `hint` in return values pointing to the next logical action. This is a strong UX pattern.

5. **submit_experience duplicate detection** -- warns when similar content already exists. Prevents experience noise.

6. **Departure flow design** -- two-phase async with behavioral guidance in the notification message. Respects member autonomy while maintaining leader control.

7. **Heartbeat sweep with PID death detection** -- covers both timeout AND process death, preventing zombie locks.

---

*End of Audit Report (Auditor B)*
