"use strict";
const electron = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const child_process = require("child_process");
const chokidar = require("chokidar");
const AGENT_CLI_NAMES = ["claude", "chatgpt", "gemini", "aider", "cursor"];
const CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
const CACHE_PATH = path.join(os.homedir(), ".claude", "team-hub", "agent_clis.json");
const WHICH_TIMEOUT_MS = 3e3;
const VERSION_TIMEOUT_MS = 5e3;
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = child_process.execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
    child.on("error", () => resolve(null));
  });
}
async function whichBin(name) {
  return runCommand("which", [name], WHICH_TIMEOUT_MS);
}
async function getVersion(bin) {
  return runCommand(bin, ["--version"], VERSION_TIMEOUT_MS);
}
function extractVersion(raw) {
  if (!raw) return "unknown";
  const match = raw.match(/v?(\d+\.\d+[\.\d]*)/);
  return match ? match[1] : raw.split("\n")[0].trim() || "unknown";
}
function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw);
    if (typeof cache.cachedAt !== "number" || !cache.result || !Array.isArray(cache.result.found) || !Array.isArray(cache.result.not_found)) {
      return null;
    }
    if (Date.now() - cache.cachedAt > CACHE_TTL_MS) return null;
    return cache.result;
  } catch {
    return null;
  }
}
function writeCache(result) {
  try {
    const dir = path.join(os.homedir(), ".claude", "team-hub");
    fs.mkdirSync(dir, { recursive: true });
    const cache = { result, cachedAt: Date.now() };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
  }
}
async function checkPermission(bin) {
  return new Promise((resolve) => {
    if (!fs.existsSync(bin)) {
      resolve(true);
      return;
    }
    child_process.execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (err) => {
      if (err && err.code === "EACCES") {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
async function scanAgentClis(force) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const found = [];
  const not_found = [];
  await Promise.all(
    AGENT_CLI_NAMES.map(async (name) => {
      const bin = await whichBin(name);
      if (!bin) {
        not_found.push(name);
        return;
      }
      const hasPermission = await checkPermission(bin);
      if (!hasPermission) {
        found.push({ name, bin, version: "unknown", status: "no_permission" });
        return;
      }
      const versionRaw = await getVersion(bin);
      found.push({
        name,
        bin,
        version: extractVersion(versionRaw),
        status: "found"
      });
    })
  );
  found.sort((a, b) => AGENT_CLI_NAMES.indexOf(a.name) - AGENT_CLI_NAMES.indexOf(b.name));
  not_found.sort((a, b) => AGENT_CLI_NAMES.indexOf(a) - AGENT_CLI_NAMES.indexOf(b));
  const result = { found, not_found, scannedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeCache(result);
  return result;
}
const TEAM_HUB_DIR = path.resolve(os.homedir(), ".claude/team-hub");
const SESSIONS_DIR = path.join(TEAM_HUB_DIR, "sessions");
const MEMBERS_DIR = path.join(TEAM_HUB_DIR, "members");
const SHARED_DIR = path.join(TEAM_HUB_DIR, "shared");
const PROJECTS_DIR = path.join(SHARED_DIR, "projects");
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1e3;
function readJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true;
    return false;
  }
}
function getPidLstart(pid) {
  try {
    const result = child_process.execSync(`ps -p ${pid} -o lstart=`, { encoding: "utf-8", timeout: 2e3 });
    return result.trim();
  } catch {
    return null;
  }
}
function scanClaudeProcesses() {
  try {
    const output = child_process.execSync("ps -eo pid,lstart,command", { encoding: "utf-8", timeout: 3e3 });
    const sessions = [];
    for (const line of output.split("\n")) {
      if (!/\bclaude\b/.test(line) || /Helper|agent|electron|node /i.test(line)) continue;
      const match = line.trim().match(/^(\d+)\s+(.+?\d{4})\s+(.+)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      const lstart = match[2].trim();
      const cmd = match[3].trim();
      if (!cmd.includes("claude")) continue;
      sessions.push({ pid, lstart, cwd: "", started_at: "" });
    }
    return sessions;
  } catch {
    return [];
  }
}
function scanTeamStatus() {
  const scannedAt = (/* @__PURE__ */ new Date()).toISOString();
  let errorMsg;
  const sessionFiles = scanClaudeProcesses();
  if (!fs.existsSync(MEMBERS_DIR)) {
    return { sessions: sessionFiles, members: [], scannedAt, healthy: true };
  }
  const members = [];
  try {
    const memberDirs = fs.readdirSync(MEMBERS_DIR).filter((d) => {
      const p = path.join(MEMBERS_DIR, d);
      return fs.statSync(p).isDirectory();
    });
    for (const memberDir of memberDirs) {
      const profilePath = path.join(MEMBERS_DIR, memberDir, "profile.json");
      const lockPath = path.join(MEMBERS_DIR, memberDir, "lock.json");
      const heartbeatPath = path.join(MEMBERS_DIR, memberDir, "heartbeat.json");
      const profile = readJson(profilePath);
      if (!profile) continue;
      const lock = readJson(lockPath);
      const heartbeat = readJson(heartbeatPath);
      const reservationPath = path.join(MEMBERS_DIR, memberDir, "reservation.json");
      const reservation = readJson(reservationPath);
      const hasReservation = reservation !== null;
      const heartbeatAlive = heartbeat !== null && Date.now() - heartbeat.last_seen_ms < HEARTBEAT_TIMEOUT_MS;
      let status;
      if (lock) {
        status = "working";
      } else if (hasReservation) {
        status = "reserved";
      } else if (heartbeatAlive) {
        status = "online";
      } else {
        status = "offline";
      }
      members.push({
        uid: profile.uid ?? memberDir,
        name: profile.name,
        displayName: profile.display_name,
        role: profile.role,
        type: profile.type,
        status,
        busy: status === "working",
        project: lock?.project ?? reservation?.project,
        task: lock?.task ?? reservation?.task,
        caller: reservation?.caller,
        lockedAt: lock?.locked_at,
        lastSeen: heartbeat?.last_seen,
        lastTool: heartbeat?.last_tool
      });
    }
  } catch (e) {
    errorMsg = errorMsg ? errorMsg + "; " + String(e) : String(e);
  }
  return {
    sessions: sessionFiles,
    members,
    scannedAt,
    healthy: !errorMsg,
    errorMsg
  };
}
function inspectSessions() {
  if (fs.existsSync(SESSIONS_DIR)) {
    let files;
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    for (const file of files) {
      const sessionPath = path.join(SESSIONS_DIR, file);
      const session = readJson(sessionPath);
      if (!session) continue;
      if (isPidAlive(session.pid)) continue;
      const lstart = getPidLstart(session.pid);
      if (lstart && lstart === session.lstart) continue;
      try {
        fs.rmSync(sessionPath);
      } catch {
      }
    }
  }
  if (!fs.existsSync(MEMBERS_DIR)) return;
  let memberDirs;
  try {
    memberDirs = fs.readdirSync(MEMBERS_DIR).filter((d) => {
      return fs.statSync(path.join(MEMBERS_DIR, d)).isDirectory();
    });
  } catch {
    return;
  }
  for (const memberDir of memberDirs) {
    const lockPath = path.join(MEMBERS_DIR, memberDir, "lock.json");
    const heartbeatPath = path.join(MEMBERS_DIR, memberDir, "heartbeat.json");
    const lock = readJson(lockPath);
    if (!lock) continue;
    const heartbeat = readJson(heartbeatPath);
    if (heartbeat && Date.now() - heartbeat.last_seen_ms > HEARTBEAT_TIMEOUT_MS) {
      try {
        fs.rmSync(lockPath);
      } catch {
      }
      try {
        fs.rmSync(heartbeatPath);
      } catch {
      }
      continue;
    }
    if (!isPidAlive(lock.session_pid)) {
      try {
        fs.rmSync(lockPath);
      } catch {
      }
      try {
        fs.rmSync(heartbeatPath);
      } catch {
      }
      continue;
    }
    const lstart = getPidLstart(lock.session_pid);
    if (lstart && lstart !== lock.session_start) {
      try {
        fs.rmSync(lockPath);
      } catch {
      }
      try {
        fs.rmSync(heartbeatPath);
      } catch {
      }
    }
  }
}
let mainWindow = null;
let watcher = null;
let pollTimer = null;
let autoQuitTimer = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 320,
    height: 520,
    minWidth: 280,
    minHeight: 400,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function pushStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const status = scanTeamStatus();
  mainWindow.webContents.send("status-update", status);
  if (status.sessions.length === 0) {
    if (!autoQuitTimer) {
      autoQuitTimer = setTimeout(() => {
        const check = scanTeamStatus();
        if (check.sessions.length === 0) {
          electron.app.quit();
        } else {
          autoQuitTimer = null;
        }
      }, 15e3);
    }
  } else {
    if (autoQuitTimer) {
      clearTimeout(autoQuitTimer);
      autoQuitTimer = null;
    }
  }
}
function startWatcher() {
  if (watcher) return;
  if (!fs.existsSync(TEAM_HUB_DIR)) return;
  watcher = chokidar.watch(TEAM_HUB_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3
  });
  watcher.on("all", () => {
    pushStatus();
  });
}
function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    inspectSessions();
    pushStatus();
  }, 5e3);
}
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
let resumeTimer = null;
function setupPowerMonitor() {
  electron.powerMonitor.on("suspend", () => {
    stopWatcher();
    stopPoll();
  });
  electron.powerMonitor.on("resume", () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      inspectSessions();
      pushStatus();
      startWatcher();
      startPoll();
    }, 1e4);
  });
}
async function fetchRegistry(query) {
  const limit = 96;
  let url = `https://registry.modelcontextprotocol.io/v0.1/servers?limit=${limit}&version=latest`;
  if (query) url += `&q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url, {
      headers: { "accept": "application/json" }
    });
    if (!resp.ok) return { servers: [], metadata: { count: 0 } };
    return await resp.json();
  } catch {
    return { servers: [], metadata: { count: 0 } };
  }
}
function getMcpStore() {
  let store = [];
  const storePath = path.join(SHARED_DIR, "mcp_store.json");
  if (fs.existsSync(storePath)) {
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    } catch {
    }
  }
  const memberMounts = [];
  if (fs.existsSync(MEMBERS_DIR)) {
    try {
      const dirs = fs.readdirSync(MEMBERS_DIR).filter((d) => {
        return fs.statSync(path.join(MEMBERS_DIR, d)).isDirectory();
      });
      for (const dir of dirs) {
        const mcpsPath = path.join(MEMBERS_DIR, dir, "mcps.json");
        const profilePath = path.join(MEMBERS_DIR, dir, "profile.json");
        if (!fs.existsSync(mcpsPath)) continue;
        const profile = readJson(profilePath);
        try {
          const mcps = JSON.parse(fs.readFileSync(mcpsPath, "utf-8"));
          if (mcps.length > 0) {
            memberMounts.push({
              member: dir,
              displayName: profile?.display_name ?? dir,
              mcps: mcps.map((m) => m.name)
            });
          }
        } catch {
        }
      }
    } catch {
    }
  }
  return { store, memberMounts };
}
function getMemberDetail(memberName) {
  const memberDir = path.join(MEMBERS_DIR, memberName);
  if (!fs.existsSync(memberDir)) return null;
  const profile = readJson(path.join(memberDir, "profile.json"));
  if (!profile) return null;
  let persona = null;
  const personaPath = path.join(memberDir, "persona.md");
  if (fs.existsSync(personaPath)) {
    try {
      persona = fs.readFileSync(personaPath, "utf-8");
    } catch {
    }
  }
  let memory = null;
  const memoryPath = path.join(memberDir, "memory_generic.md");
  if (fs.existsSync(memoryPath)) {
    try {
      memory = fs.readFileSync(memoryPath, "utf-8");
    } catch {
    }
  }
  const workLog = [];
  const logPath = path.join(memberDir, "work_log.jsonl");
  if (fs.existsSync(logPath)) {
    try {
      const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          workLog.push(JSON.parse(line));
        } catch {
        }
      }
    } catch {
    }
  }
  const lock = readJson(path.join(memberDir, "lock.json"));
  const heartbeat = readJson(path.join(memberDir, "heartbeat.json"));
  const hasReservation = fs.existsSync(path.join(memberDir, "reservation.json"));
  const heartbeatAlive = heartbeat !== null && Date.now() - heartbeat.last_seen_ms < HEARTBEAT_TIMEOUT_MS;
  const status = lock ? "working" : hasReservation ? "reserved" : heartbeatAlive ? "online" : "offline";
  return {
    profile,
    persona,
    memory,
    workLog,
    status,
    busy: status === "working",
    project: lock?.project,
    task: lock?.task,
    lockedAt: lock?.locked_at,
    lastSeen: heartbeat?.last_seen,
    lastTool: heartbeat?.last_tool
  };
}
function getProjectsDir() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  return PROJECTS_DIR;
}
function listProjects() {
  const dir = getProjectsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const projects = [];
  for (const file of files) {
    const p = readJson(path.join(dir, file));
    if (p) projects.push(p);
  }
  const statusOrder = {
    developing: 0,
    testing: 1,
    bugfixing: 2,
    designing: 3,
    planning: 4,
    done: 5,
    abandoned: 6
  };
  projects.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || b.updated_at.localeCompare(a.updated_at));
  return projects;
}
function getProject(id) {
  return readJson(path.join(getProjectsDir(), `${id}.json`));
}
function saveProject(project) {
  const dir = getProjectsDir();
  fs.writeFileSync(path.join(dir, `${project.id}.json`), JSON.stringify(project, null, 2));
}
function createProject(data) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = crypto.randomUUID();
  const project = { id, ...data, created_at: now, updated_at: now };
  saveProject(project);
  return project;
}
function updateProject(id, patch) {
  const project = getProject(id);
  if (!project) return null;
  Object.assign(project, patch, { updated_at: (/* @__PURE__ */ new Date()).toISOString() });
  saveProject(project);
  return project;
}
function deleteProject(id) {
  const path$1 = path.join(getProjectsDir(), `${id}.json`);
  if (!fs.existsSync(path$1)) return false;
  fs.rmSync(path$1);
  return true;
}
function getMemberProjects(memberName) {
  return listProjects().filter((p) => p.members.includes(memberName));
}
function setupIpc() {
  electron.ipcMain.handle("get-initial-status", () => {
    return scanTeamStatus();
  });
  electron.ipcMain.handle("get-member-detail", (_event, memberName) => {
    return getMemberDetail(memberName);
  });
  electron.ipcMain.handle("get-mcp-store", () => {
    return getMcpStore();
  });
  electron.ipcMain.handle("get-registry", (_event, query) => {
    return fetchRegistry(query);
  });
  electron.ipcMain.handle("install-store-mcp", (_event, item) => {
    const { mkdirSync: mkdirSync2, writeFileSync: writeFileSync2 } = require("fs");
    const storePath = path.join(SHARED_DIR, "mcp_store.json");
    mkdirSync2(SHARED_DIR, { recursive: true });
    let store = [];
    if (fs.existsSync(storePath)) {
      try {
        store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      } catch {
      }
    }
    if (store.some((s) => s.name === item.name)) return { ok: false, reason: "已安装" };
    store.push(item);
    writeFileSync2(storePath, JSON.stringify(store, null, 2));
    return { ok: true };
  });
  electron.ipcMain.handle("uninstall-store-mcp", (_event, name) => {
    const { writeFileSync: writeFileSync2 } = require("fs");
    const storePath = path.join(SHARED_DIR, "mcp_store.json");
    if (!fs.existsSync(storePath)) return { ok: false, reason: "商店为空" };
    let store = [];
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    } catch {
      return { ok: false, reason: "读取失败" };
    }
    const before = store.length;
    store = store.filter((s) => s.name !== name);
    if (store.length === before) return { ok: false, reason: "未找到" };
    writeFileSync2(storePath, JSON.stringify(store, null, 2));
    return { ok: true };
  });
  electron.ipcMain.handle("mount-member-mcp", (_event, memberName, mcpName) => {
    const { mkdirSync: mkdirSync2, writeFileSync: writeFileSync2 } = require("fs");
    const memberDir = path.join(MEMBERS_DIR, memberName);
    const mcpsPath = path.join(memberDir, "mcps.json");
    if (!fs.existsSync(memberDir)) return { ok: false, reason: "成员不存在" };
    const storePath = path.join(SHARED_DIR, "mcp_store.json");
    let storeItems = [];
    if (fs.existsSync(storePath)) {
      try {
        storeItems = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      } catch {
      }
    }
    const storeItem = storeItems.find((s) => s.name === mcpName);
    if (!storeItem) return { ok: false, reason: "商店中不存在该 MCP" };
    let memberMcps = [];
    if (fs.existsSync(mcpsPath)) {
      try {
        memberMcps = JSON.parse(fs.readFileSync(mcpsPath, "utf-8"));
      } catch {
      }
    }
    if (memberMcps.some((m) => m.name === mcpName)) return { ok: false, reason: "已挂载" };
    memberMcps.push(storeItem);
    writeFileSync2(mcpsPath, JSON.stringify(memberMcps, null, 2));
    return { ok: true };
  });
  electron.ipcMain.handle("unmount-member-mcp", (_event, memberName, mcpName) => {
    const { writeFileSync: writeFileSync2 } = require("fs");
    const mcpsPath = path.join(MEMBERS_DIR, memberName, "mcps.json");
    if (!fs.existsSync(mcpsPath)) return { ok: false, reason: "无挂载" };
    let memberMcps = [];
    try {
      memberMcps = JSON.parse(fs.readFileSync(mcpsPath, "utf-8"));
    } catch {
      return { ok: false, reason: "读取失败" };
    }
    const before = memberMcps.length;
    memberMcps = memberMcps.filter((m) => m.name !== mcpName);
    if (memberMcps.length === before) return { ok: false, reason: "未挂载该 MCP" };
    writeFileSync2(mcpsPath, JSON.stringify(memberMcps, null, 2));
    return { ok: true };
  });
  electron.ipcMain.handle("get-member-mcps", (_event, memberName) => {
    const mcpsPath = path.join(MEMBERS_DIR, memberName, "mcps.json");
    if (!fs.existsSync(mcpsPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(mcpsPath, "utf-8"));
    } catch {
      return [];
    }
  });
  electron.ipcMain.handle("list-projects", () => listProjects());
  electron.ipcMain.handle("get-project", (_event, id) => getProject(id));
  electron.ipcMain.handle("create-project", (_event, data) => createProject(data));
  electron.ipcMain.handle("update-project", (_event, id, patch) => updateProject(id, patch));
  electron.ipcMain.handle("delete-project", (_event, id) => deleteProject(id));
  electron.ipcMain.handle("get-member-projects", (_event, memberName) => getMemberProjects(memberName));
  electron.ipcMain.handle("scan-agent-clis", (_event, force) => {
    return scanAgentClis(force);
  });
  electron.ipcMain.handle("get-theme", () => {
    return electron.nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });
  electron.nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("theme-change", electron.nativeTheme.shouldUseDarkColors ? "dark" : "light");
    }
  });
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  electron.app.whenReady().then(() => {
    setupIpc();
    createWindow();
    startWatcher();
    startPoll();
    setupPowerMonitor();
  });
  electron.app.on("window-all-closed", () => {
    stopWatcher();
    stopPoll();
    electron.app.quit();
  });
  electron.app.on("before-quit", () => {
    const pidFile = path.join(TEAM_HUB_DIR, "hub.pid");
    const portFile = path.join(TEAM_HUB_DIR, "hub.port");
    const panelPidFile = path.join(TEAM_HUB_DIR, "panel.pid");
    try {
      const hubPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (!isNaN(hubPid)) process.kill(hubPid, "SIGTERM");
    } catch {
    }
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
    }
    try {
      fs.rmSync(portFile, { force: true });
    } catch {
    }
    try {
      fs.rmSync(panelPidFile, { force: true });
    } catch {
    }
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
