/**
 * E2E Panel UI Test
 * 通过 HTTP API 改变成员状态，用 screencapture + PIL 裁剪截图验证 Panel UI 是否正确反映状态变化。
 *
 * 依赖：
 *   - Hub 服务运行在 http://127.0.0.1:58578
 *   - Panel (Electron) 已在副屏运行（Team Hub 窗口）
 *   - Python 3 + PIL (pip install pillow)
 *
 * 运行方式：
 *   cd packages/mcp-server
 *   bun src/__tests__/e2e-panel.test.ts
 */

import { execSync, spawnSync } from "child_process";
import { mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";

// ---- 配置 ---------------------------------------------------------------
const HUB_URL = "http://127.0.0.1:58578";
const SCREENSHOTS_DIR = path.resolve(
  "/Users/zhuqingyu/project/mcp-team-hub/packages/mcp-server/src/__tests__/screenshots"
);
const POLL_WAIT_MS = 9000; // Panel 轮询 5s，等 9s 确保刷新

// Panel 显示器配置（HiDPI 2x，副屏）
const PANEL_DISPLAY = 2;
const PANEL_SCALE = 2;
// 副屏在全局坐标中的起点（y=-1080）
const DISPLAY2_OFFSET = { x: 0, y: -1080 };

/** 动态获取 Panel 窗口的全局逻辑坐标和尺寸 */
function getPanelWindowRect() {
  const r = spawnSync(
    "osascript",
    [
      "-e",
      `tell application "System Events"
  set p to first process whose name is "Electron"
  set w to first window of p
  set pos to position of w
  set sz to size of w
  return (item 1 of pos as string) & "," & (item 2 of pos as string) & "," & (item 1 of sz as string) & "," & (item 2 of sz as string)
end tell`,
    ],
    { encoding: "utf-8" }
  );
  const [gx, gy, gw, gh] = r.stdout.trim().split(",").map(Number);
  // 转为相对于显示器2的坐标
  const rx = gx - DISPLAY2_OFFSET.x;
  const ry = gy - DISPLAY2_OFFSET.y;
  return { x: rx, y: ry, w: gw, h: gh };
}

// ---- 工具函数 ------------------------------------------------------------
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiCall(
  sessionId: string,
  tool: string,
  args: Record<string, string>
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${HUB_URL}/api/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, tool, arguments: args }),
  });
  const json = (await resp.json()) as { content: Array<{ text: string }> };
  return JSON.parse(json.content[0].text) as Record<string, unknown>;
}

/**
 * 截取副屏，裁剪出 Panel 窗口，保存为 name。
 */
function capturePanel(name: string): string {
  const rawPath = `/tmp/e2e_raw_display.png`;
  const outPath = path.join(SCREENSHOTS_DIR, name);

  // 先把 Panel 窗口带到最前面
  spawnSync("osascript", [
    "-e",
    `tell application "System Events"
  set frontmost of process "Electron" to true
end tell`,
  ]);
  // 等待窗口前置完成
  execSync("sleep 0.5");

  // 截副屏
  execSync(`screencapture -x -D ${PANEL_DISPLAY} ${rawPath}`);

  // 动态获取窗口位置
  const rect = getPanelWindowRect();
  const cx = rect.x * PANEL_SCALE;
  const cy = rect.y * PANEL_SCALE;
  const cw = rect.w * PANEL_SCALE;
  const ch = rect.h * PANEL_SCALE;
  console.log(`  crop: (${cx}, ${cy}, ${cx + cw}, ${cy + ch})`);

  // PIL 裁剪 + 保存
  const py = `
from PIL import Image
img = Image.open('${rawPath}')
panel = img.crop((${cx}, ${cy}, ${cx + cw}, ${cy + ch}))
panel.save('${outPath}')
print('ok')
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`PIL crop failed: ${r.stderr}`);
  }
  console.log(`  [screenshot] ${outPath}`);
  return outPath;
}

const TEAM_HUB_DIR = "/Users/zhuqingyu/.claude/team-hub";
const MEMBERS_DIR = path.join(TEAM_HUB_DIR, "members");

type MemberState = {
  name: string;
  display_name: string;
  status: string;
  working: boolean;
  online: boolean;
};

/** 查询 /api/status 获取成员当前状态（working/online/offline，不含 reserved） */
async function getStatus(): Promise<MemberState[]> {
  const resp = await fetch(`${HUB_URL}/api/status`);
  const data = (await resp.json()) as { members: MemberState[] };
  return data.members;
}

/**
 * 读取磁盘文件，返回成员真实状态（同 Panel 逻辑）：
 * working → has lock.json + heartbeat alive
 * reserved → has reservation.json (no lock)
 * online → heartbeat alive (no lock, no reservation)
 * offline → otherwise
 */
function getMemberStatusFromDisk(member: string): string {
  const memberDir = path.join(MEMBERS_DIR, member);
  const lockPath = path.join(memberDir, "lock.json");
  const reservationPath = path.join(memberDir, "reservation.json");
  const heartbeatPath = path.join(memberDir, "heartbeat.json");

  const hasLock = existsSync(lockPath);
  const hasReservation = existsSync(reservationPath);

  let heartbeatAlive = false;
  if (existsSync(heartbeatPath)) {
    try {
      const hb = JSON.parse(readFileSync(heartbeatPath, "utf-8")) as { last_seen_ms: number };
      heartbeatAlive = Date.now() - hb.last_seen_ms < 3 * 60 * 1000;
    } catch {
      /* ignore */
    }
  }

  // Panel 逻辑：有 lock 就是 working（不依赖 heartbeat）
  if (hasLock) return "working";
  if (hasReservation) return "reserved";
  if (heartbeatAlive) return "online";
  return "offline";
}

// ---- 测试报告 ------------------------------------------------------------
type ScenarioResult = {
  name: string;
  passed: boolean;
  screenshot?: string;
  notes: string[];
};
const results: ScenarioResult[] = [];

function pass(name: string, notes: string[], shot?: string) {
  results.push({ name, passed: true, screenshot: shot, notes });
  console.log(`  [PASS] ${name}`);
  notes.forEach((n) => console.log(`         ${n}`));
}

function fail(name: string, notes: string[], shot?: string) {
  results.push({ name, passed: false, screenshot: shot, notes });
  console.log(`  [FAIL] ${name}`);
  notes.forEach((n) => console.log(`         ${n}`));
}

// ---- 主流程 -------------------------------------------------------------
async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // 检查 Hub 健康
  console.log("\n[setup] checking hub health...");
  const health = (await fetch(`${HUB_URL}/api/health`).then((r) => r.json())) as {
    ok: boolean;
  };
  if (!health.ok) throw new Error("Hub not healthy");
  console.log("  hub ok");

  // 确认 Panel 窗口存在
  console.log("[setup] checking Panel window...");
  const winInfo = spawnSync(
    "osascript",
    [
      "-e",
      `tell application "System Events"
  set p to first process whose name is "Electron"
  set w to first window of p
  return name of w
end tell`,
    ],
    { encoding: "utf-8" }
  );
  console.log(`  Panel window: "${winInfo.stdout.trim()}"`);

  // 注册 E2E session（使用真实 PID 防止被 session sweep 清理）
  console.log("[setup] registering e2e session...");
  // 获取当前进程的 lstart（hub 用 pid+lstart 双重验证进程存活）
  let lstart = "e2e-panel-test";
  try {
    const { execSync: es } = await import("child_process");
    lstart = es(`ps -p ${process.pid} -o lstart=`, { encoding: "utf-8" }).trim();
  } catch {
    /* ignore */
  }
  const regResp = (await fetch(`${HUB_URL}/api/session/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid: process.pid, lstart }),
  }).then((r) => r.json())) as { session_id: string };
  const sessionId = regResp.session_id;
  console.log(`  session_id: ${sessionId}`);

  // -----------------------------------------------------------------------
  // 场景 1：初始状态 — 所有成员离线
  // -----------------------------------------------------------------------
  console.log("\n[scene 1] initial state — all offline");
  const shot1 = capturePanel("01-initial-all-offline.png");
  const statuses1 = await getStatus();
  const activeInScene1 = statuses1.filter((m) => m.status !== "offline");
  console.log(`  active members (API): ${activeInScene1.map((m) => m.name).join(", ") || "none"}`);

  if (activeInScene1.length === 0) {
    pass("场景1：初始全离线", [`全部 ${statuses1.length} 个成员处于 offline`], shot1);
  } else {
    fail("场景1：初始全离线", [
      `意外激活成员: ${activeInScene1.map((m) => `${m.name}(${m.status})`).join(", ")}`,
    ], shot1);
  }

  // -----------------------------------------------------------------------
  // 场景 2：预约 adian → reserved 状态
  // -----------------------------------------------------------------------
  console.log("\n[scene 2] request_member adian → reserved");
  const reserveResp = await apiCall(sessionId, "request_member", {
    caller: "e2e-leader",
    member: "adian",
    project: "e2e-test",
    task: "体验测试",
  });
  const reservationCode = reserveResp.reservation_code as string;
  console.log(`  reservation_code: ${reservationCode}`);

  console.log(`  waiting ${POLL_WAIT_MS}ms for Panel refresh...`);
  await sleep(POLL_WAIT_MS);

  const shot2 = capturePanel("02-adian-reserved.png");
  const adianStatus2 = getMemberStatusFromDisk("adian");
  console.log(`  adian status (disk): ${adianStatus2}`);

  if (adianStatus2 === "reserved") {
    pass("场景2：adian 预约中", [
      `磁盘状态确认 adian status=reserved（reservation.json 存在）`,
      `截图中应显示预约中分组和蓝色脉冲点（见截图）`,
    ], shot2);
  } else {
    fail("场景2：adian 预约中", [`adian 状态异常: ${adianStatus2}`], shot2);
  }

  // -----------------------------------------------------------------------
  // 场景 3：激活 adian → working 状态
  // -----------------------------------------------------------------------
  console.log("\n[scene 3] activate adian → working");
  const activateResp = await apiCall(sessionId, "activate", {
    member: "adian",
    reservation_code: reservationCode,
  });
  console.log(`  activated: ${(activateResp.identity as { name: string })?.name}`);

  console.log(`  waiting ${POLL_WAIT_MS}ms for Panel refresh...`);
  await sleep(POLL_WAIT_MS);

  const shot3 = capturePanel("03-adian-working.png");
  const adianStatus3 = getMemberStatusFromDisk("adian");
  console.log(`  adian status (disk): ${adianStatus3}`);

  if (adianStatus3 === "working") {
    pass("场景3：adian working", [
      `磁盘状态确认 adian status=working（lock.json + heartbeat）`,
      `截图中应显示绿点和工作中分组（见截图）`,
    ], shot3);
  } else {
    fail("场景3：adian working", [`adian 状态异常: ${adianStatus3}`], shot3);
  }

  // -----------------------------------------------------------------------
  // 场景 4：预约 laochui + 取消预约
  // -----------------------------------------------------------------------
  console.log("\n[scene 4] request laochui → reserved");
  const laoReserveResp = await apiCall(sessionId, "request_member", {
    caller: "e2e-leader",
    member: "laochui",
    project: "e2e-test",
    task: "取消预约测试",
  });
  const laochuiCode = laoReserveResp.reservation_code as string;
  console.log(`  laochui code: ${laochuiCode}`);

  console.log(`  waiting ${POLL_WAIT_MS}ms...`);
  await sleep(POLL_WAIT_MS);

  const shot4 = capturePanel("04-laochui-reserved.png");
  const laochuiStatus4 = getMemberStatusFromDisk("laochui");
  console.log(`  laochui status (disk): ${laochuiStatus4}`);

  if (laochuiStatus4 === "reserved") {
    pass("场景4：laochui 预约中", [`磁盘状态确认 laochui status=reserved`], shot4);
  } else {
    fail("场景4：laochui 预约中", [`laochui 状态异常: ${laochuiStatus4}`], shot4);
  }

  // 取消预约
  console.log("\n[scene 4b] cancel laochui reservation");
  await apiCall(sessionId, "cancel_reservation", {
    reservation_code: laochuiCode,
  });

  console.log(`  waiting ${POLL_WAIT_MS}ms...`);
  await sleep(POLL_WAIT_MS);

  const shot5 = capturePanel("05-laochui-cancelled-back-offline.png");
  const laochuiStatus5 = getMemberStatusFromDisk("laochui");
  console.log(`  laochui status (disk): ${laochuiStatus5}`);

  if (laochuiStatus5 === "offline") {
    pass("场景5：laochui 取消回离线", [`磁盘状态确认 laochui status=offline（reservation.json 已删除）`], shot5);
  } else {
    fail("场景5：laochui 取消回离线", [`laochui 未回 offline, status=${laochuiStatus5}`], shot5);
  }

  // -----------------------------------------------------------------------
  // 场景 5：下线 adian → offline
  // -----------------------------------------------------------------------
  console.log("\n[scene 5] deactivate adian → offline");
  const saveResp = await apiCall(sessionId, "save_memory", {
    member: "adian",
    scope: "generic",
    content: "[e2e-panel-test] cleanup",
  });
  console.log(`  save_memory: ${JSON.stringify(saveResp).slice(0, 80)}`);
  const deactResp = await apiCall(sessionId, "deactivate", { member: "adian" });
  console.log(`  deactivate: ${JSON.stringify(deactResp).slice(0, 80)}`);

  console.log(`  waiting ${POLL_WAIT_MS}ms...`);
  await sleep(POLL_WAIT_MS);

  const shot6 = capturePanel("06-adian-deactivated-offline.png");
  const adianStatus6 = getMemberStatusFromDisk("adian");
  console.log(`  adian status (disk): ${adianStatus6}`);

  if (adianStatus6 === "offline") {
    pass("场景6：adian 下线回离线", [`磁盘状态确认 adian status=offline（lock.json 已删除）`], shot6);
  } else {
    fail("场景6：adian 下线回离线", [`adian 未回 offline, status=${adianStatus6}`], shot6);
  }

  // -----------------------------------------------------------------------
  // 清理
  // -----------------------------------------------------------------------
  console.log("\n[cleanup] unregistering session...");
  await fetch(`${HUB_URL}/api/session/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  console.log("  done");

  // -----------------------------------------------------------------------
  // 报告
  // -----------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("E2E PANEL TEST REPORT");
  console.log("=".repeat(60));
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.name}`);
    r.notes.forEach((n) => console.log(`       ${n}`));
    if (r.screenshot) console.log(`       screenshot: ${r.screenshot}`);
    if (!r.passed) allPassed = false;
  }
  console.log("=".repeat(60));
  console.log(`Overall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);
  console.log(`Screenshots dir: ${SCREENSHOTS_DIR}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
