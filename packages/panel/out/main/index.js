"use strict";
const electron = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const child_process = require("child_process");
const chokidar = require("chokidar");
const pty = require("node-pty");
const node_fs = require("node:fs");
const node_path = require("node:path");
const node_child_process = require("node:child_process");
const http = require("node:http");
const node_os = require("node:os");
const crypto$1 = require("node:crypto");
const https = require("node:https");
const node_url = require("node:url");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
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
const RING_SIZE = 10 * 1024;
class RingBuffer {
  buf = [];
  totalBytes = 0;
  push(chunk) {
    this.buf.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > RING_SIZE && this.buf.length > 0) {
      const dropped = this.buf.shift();
      this.totalBytes -= dropped.length;
    }
  }
  snapshot() {
    return this.buf.join("");
  }
}
const sessions$1 = /* @__PURE__ */ new Map();
function spawnPtySession(opts) {
  const id = crypto.randomUUID();
  const cols = opts.cols ?? 200;
  const rows = opts.rows ?? 50;
  const effectiveCwd = opts.cwd ?? process.env["HOME"] ?? "/";
  let ptyProcess;
  try {
    ptyProcess = pty__namespace.spawn(opts.bin, opts.args ?? [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: effectiveCwd,
      env: {
        ...process.env,
        // Force iTerm2 IIP path so CLI uses a protocol xterm.js can render
        TERM_PROGRAM: "iTerm.app",
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
        ...opts.env
      }
    });
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
  const ring = new RingBuffer();
  const meta = {
    id,
    agentId: opts.agentId,
    memberId: opts.memberId,
    cliName: opts.cliName,
    bin: opts.bin,
    status: "running",
    cols,
    rows,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    cwd: effectiveCwd
  };
  let cliReadyResolve = null;
  const cliReadyPromise = new Promise((resolve) => {
    cliReadyResolve = resolve;
  });
  const record = {
    meta,
    pty: ptyProcess,
    ring,
    window: null,
    dataListeners: [],
    exitListeners: [],
    cliReady: false,
    cliReadyResolve,
    cliReadyPromise
  };
  sessions$1.set(id, record);
  const CLI_READY_PATTERNS = [/bypass permissions/i, /shift\+tab/i];
  ptyProcess.onData((data) => {
    ring.push(data);
    if (!record.cliReady) {
      for (const pat of CLI_READY_PATTERNS) {
        if (pat.test(data)) {
          record.cliReady = true;
          record.cliReadyResolve?.();
          record.cliReadyResolve = null;
          break;
        }
      }
    }
    if (record.window && !record.window.isDestroyed()) {
      record.window.webContents.send("pty-output", data);
    }
    for (const cb of record.dataListeners) {
      try {
        cb(data);
      } catch {
      }
    }
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (record.meta.status === "running") {
      record.meta.status = "exited";
    }
    record.meta.exitCode = exitCode;
    if (record.window && !record.window.isDestroyed()) {
      record.window.webContents.send("pty-exit", id, exitCode);
    }
    for (const cb of record.exitListeners) {
      try {
        cb(exitCode);
      } catch {
      }
    }
  });
  return { ok: true, sessionId: id };
}
function attachWindow(sessionId, win) {
  const rec = sessions$1.get(sessionId);
  if (!rec) return { ok: false, reason: "session not found" };
  rec.window = win;
  return { ok: true, buffer: rec.ring.snapshot() };
}
function writeToPty(sessionId, data) {
  const rec = sessions$1.get(sessionId);
  if (!rec || rec.meta.status !== "running") return false;
  rec.pty.write(data);
  return true;
}
function resizePty(sessionId, cols, rows) {
  const rec = sessions$1.get(sessionId);
  if (!rec || rec.meta.status !== "running") return false;
  rec.pty.resize(cols, rows);
  rec.meta.cols = cols;
  rec.meta.rows = rows;
  return true;
}
function killPtySession(sessionId) {
  const rec = sessions$1.get(sessionId);
  if (!rec) return false;
  if (rec.meta.status === "running") {
    rec.pty.kill();
    rec.meta.status = "killed";
  }
  return true;
}
function getPtySessions() {
  return Array.from(sessions$1.values()).map((r) => ({ ...r.meta }));
}
function getPtySession(sessionId) {
  return sessions$1.get(sessionId)?.meta ?? null;
}
function getPtyBuffer(sessionId) {
  return sessions$1.get(sessionId)?.ring.snapshot() ?? null;
}
function onSessionExit(sessionId, callback) {
  const rec = sessions$1.get(sessionId);
  if (!rec) return null;
  if (rec.meta.status === "exited" || rec.meta.status === "killed") {
    callback(rec.meta.exitCode ?? -1);
    return () => {
    };
  }
  rec.exitListeners.push(callback);
  return () => {
    const idx = rec.exitListeners.indexOf(callback);
    if (idx !== -1) rec.exitListeners.splice(idx, 1);
  };
}
function onSessionData(sessionId, callback) {
  const rec = sessions$1.get(sessionId);
  if (!rec) return null;
  rec.dataListeners.push(callback);
  return () => {
    const idx = rec.dataListeners.indexOf(callback);
    if (idx !== -1) rec.dataListeners.splice(idx, 1);
  };
}
function getSessionByMemberId(memberId) {
  for (const rec of sessions$1.values()) {
    if (rec.meta.memberId === memberId && rec.meta.status === "running") {
      return { ...rec.meta };
    }
  }
  return null;
}
async function waitForCliReady(memberId, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  let rec;
  while (Date.now() < deadline) {
    for (const r of sessions$1.values()) {
      if (r.meta.memberId === memberId && r.meta.status === "running") {
        rec = r;
        break;
      }
    }
    if (rec) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!rec) return false;
  if (rec.cliReady) return true;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return Promise.race([
    rec.cliReadyPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), remaining))
  ]);
}
function killAllPtySessions() {
  for (const [, rec] of sessions$1) {
    if (rec.meta.status === "running") {
      try {
        rec.pty.kill();
      } catch {
      }
      rec.meta.status = "killed";
    }
  }
}
const queues = /* @__PURE__ */ new Map();
function getQueue(memberId) {
  let q = queues.get(memberId);
  if (!q) {
    q = [];
    queues.set(memberId, q);
  }
  return q;
}
function enqueue(msg) {
  const id = crypto.randomUUID();
  const full = {
    ...msg,
    id,
    timestamp: Date.now(),
    status: "pending"
  };
  const q = getQueue(msg.to);
  if (msg.priority === "urgent") {
    const insertIdx = q.findIndex((m) => m.priority === "normal");
    if (insertIdx === -1) {
      q.push(full);
    } else {
      q.splice(insertIdx, 0, full);
    }
  } else {
    q.push(full);
  }
  return id;
}
function dequeue(memberId) {
  const q = getQueue(memberId);
  if (q.length === 0) return null;
  const first = q[0];
  const sameFrom = [first];
  let i = 1;
  while (i < q.length && q[i].from === first.from) {
    sameFrom.push(q[i]);
    i++;
  }
  q.splice(0, sameFrom.length);
  if (sameFrom.length === 1) {
    first.status = "delivered";
    return first;
  }
  const merged = {
    id: first.id,
    from: first.from,
    to: first.to,
    content: sameFrom.map((m) => m.content).join("\n"),
    priority: sameFrom.some((m) => m.priority === "urgent") ? "urgent" : "normal",
    timestamp: first.timestamp,
    status: "delivered"
  };
  return merged;
}
function peekAll(memberId) {
  return [...getQueue(memberId)];
}
function consumeAll(memberId) {
  const q = getQueue(memberId);
  const messages = [...q];
  queues.set(memberId, []);
  return messages;
}
function clearQueue(memberId) {
  queues.set(memberId, []);
}
function expireSweep(ttlMs) {
  const now = Date.now();
  for (const [memberId, q] of queues) {
    const remaining = q.filter((m) => {
      if (now - m.timestamp > ttlMs) {
        m.status = "expired";
        return false;
      }
      return true;
    });
    queues.set(memberId, remaining);
  }
}
const READY_DELAY_MS = 5e3;
const TIMEOUT_MS = 3e4;
function createReadyDetector(opts) {
  const { sessionId, onReady } = opts;
  let destroyed = false;
  let fired = false;
  let started = false;
  let delayTimer = null;
  let timeoutTimer = null;
  function fire() {
    if (fired || destroyed) return;
    fired = true;
    cleanup();
    process.stderr.write(`[ready-det] READY fired for sessionId=${sessionId}
`);
    onReady();
  }
  function cleanup() {
    if (delayTimer !== null) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }
  function onData(_data) {
    if (started || fired || destroyed) return;
    started = true;
    process.stderr.write(`[ready-det] first output detected, waiting ${READY_DELAY_MS}ms for sessionId=${sessionId}
`);
    delayTimer = setTimeout(() => {
      delayTimer = null;
      fire();
    }, READY_DELAY_MS);
  }
  let unsubscribe = onSessionData(sessionId, onData);
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    process.stderr.write(
      `[ready-det] timeout (${TIMEOUT_MS}ms) reached for sessionId=${sessionId}, forcing ready
`
    );
    fire();
  }, TIMEOUT_MS);
  process.stderr.write(
    `[ready-det] created for sessionId=${sessionId}, subscribed=${unsubscribe !== null}
`
  );
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanup();
      process.stderr.write(`[ready-det] destroyed for sessionId=${sessionId}
`);
    }
  };
}
const overlays = /* @__PURE__ */ new Map();
function createOverlayForDisplay(display) {
  const b = display.bounds;
  const win = new electron.BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/overlay-preload.js"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true);
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/overlay.html"));
  }
  const entry = {
    win,
    displayId: display.id,
    originX: b.x,
    originY: b.y,
    width: b.width,
    height: b.height
  };
  win.once("ready-to-show", () => {
    if (process.env.E2E_HEADLESS !== "1") win.show();
    const actual = win.getBounds();
    const stored = overlays.get(display.id);
    if (stored) {
      stored.originX = actual.x;
      stored.originY = actual.y;
      process.stderr.write(`[overlay] actual origin for display ${display.id}: ${actual.x},${actual.y} (requested ${b.x},${b.y})
`);
    }
  });
  win.on("closed", () => {
    overlays.delete(display.id);
  });
  process.stderr.write(`[overlay] created for display ${display.id}: ${b.x},${b.y} ${b.width}x${b.height} scale=${display.scaleFactor}
`);
  return entry;
}
function createOverlay() {
  const primary = electron.screen.getPrimaryDisplay();
  const entry = createOverlayForDisplay(primary);
  overlays.set(primary.id, entry);
  return entry.win;
}
function updateWindowPositions(positions) {
  if (positions.length === 0) {
    for (const entry of overlays.values()) {
      if (!entry.win.isDestroyed() && entry.win.isVisible()) entry.win.hide();
    }
    return;
  }
  const byDisplay = /* @__PURE__ */ new Map();
  for (const p of positions) {
    const centerX = p.x + p.w / 2;
    const centerY = p.y + p.h / 2;
    const display = electron.screen.getDisplayNearestPoint({ x: centerX, y: centerY });
    let group = byDisplay.get(display.id);
    if (!group) {
      group = { display, positions: [] };
      byDisplay.set(display.id, group);
    }
    group.positions.push(p);
  }
  const activeDisplayIds = /* @__PURE__ */ new Set();
  for (const [displayId, group] of byDisplay) {
    activeDisplayIds.add(displayId);
    let entry = overlays.get(displayId);
    if (!entry || entry.win.isDestroyed()) {
      entry = createOverlayForDisplay(group.display);
      overlays.set(displayId, entry);
    }
    const db = group.display.bounds;
    if (entry.width !== db.width || entry.height !== db.height) {
      entry.win.setBounds({ x: db.x, y: db.y, width: db.width, height: db.height });
      const actualBounds = entry.win.getBounds();
      entry.originX = actualBounds.x;
      entry.originY = actualBounds.y;
      entry.width = actualBounds.width;
      entry.height = actualBounds.height;
      process.stderr.write(`[overlay] display ${displayId} bounds updated: requested=${db.x},${db.y} actual=${actualBounds.x},${actualBounds.y} ${actualBounds.width}x${actualBounds.height}
`);
    }
    if (!entry.win.isVisible() && process.env.E2E_HEADLESS !== "1") {
      entry.win.show();
      const actualBounds = entry.win.getBounds();
      entry.originX = actualBounds.x;
      entry.originY = actualBounds.y;
    }
    const adjusted = positions.map((p) => ({
      ...p,
      x: p.x - entry.originX,
      y: p.y - entry.originY
    }));
    entry.win.webContents.send("window-positions", adjusted);
  }
  for (const [displayId, entry] of overlays) {
    if (!activeDisplayIds.has(displayId) && !entry.win.isDestroyed()) {
      if (entry.win.isVisible()) entry.win.hide();
    }
  }
}
function updateMessages(messages) {
  const now = performance.now() / 1e3;
  const converted = messages.map((msg) => ({
    from: msg.from,
    to: msg.to,
    elapsed: now - msg.startTime,
    duration: msg.duration
  }));
  for (const entry of overlays.values()) {
    if (!entry.win.isDestroyed()) {
      entry.win.webContents.send("message-events", converted);
    }
  }
}
const readyDetectors = /* @__PURE__ */ new Map();
const readyMembers = /* @__PURE__ */ new Set();
const MESSAGE_TTL_MS = 10 * 60 * 1e3;
let sweepTimer = null;
const activeMessages = [];
const MESSAGE_ANIMATION_DURATION = 3;
let activeMessageTimer = null;
function tickActiveMessages() {
  const now = performance.now() / 1e3;
  for (let i = activeMessages.length - 1; i >= 0; i--) {
    if (now - activeMessages[i].startTime > activeMessages[i].duration) {
      activeMessages.splice(i, 1);
    }
  }
  if (activeMessages.length === 0 && activeMessageTimer) {
    clearInterval(activeMessageTimer);
    activeMessageTimer = null;
    updateMessages([]);
    return;
  }
  updateMessages(activeMessages);
}
function addActiveMessage(from, to) {
  activeMessages.push({
    from,
    to,
    startTime: performance.now() / 1e3,
    duration: MESSAGE_ANIMATION_DURATION
  });
  if (!activeMessageTimer) {
    activeMessageTimer = setInterval(tickActiveMessages, 100);
  }
  tickActiveMessages();
}
function getMemberRole(memberName) {
  const profilePath = path.join(os.homedir(), ".claude/team-hub/members", memberName, "profile.json");
  if (!fs.existsSync(profilePath)) return memberName;
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
    return profile.role ?? memberName;
  } catch {
    return memberName;
  }
}
function resolveCallName(name) {
  const directPath = path.join(os.homedir(), ".claude/team-hub/members", name, "profile.json");
  if (fs.existsSync(directPath)) return name;
  return null;
}
function formatEnvelope(msg) {
  const role = getMemberRole(msg.from);
  const oneLine = msg.content.replace(/\n/g, " ");
  return `[team-hub] 来自 ${msg.from}(${role}): ${oneLine}`;
}
function flushQueue(memberId) {
  process.stderr.write(`[msg-router] flushQueue called for ${memberId}
`);
  const session = getSessionByMemberId(memberId);
  if (!session) {
    process.stderr.write(`[msg-router] flushQueue: no session for ${memberId}, abort
`);
    return;
  }
  const msg = dequeue(memberId);
  if (!msg) {
    process.stderr.write(`[msg-router] flushQueue: queue empty for ${memberId}
`);
    return;
  }
  const envelope = formatEnvelope(msg);
  process.stderr.write(`[msg-router] flushQueue: writing to PTY ${session.id}, msg from ${msg.from}, len=${envelope.length}
`);
  writeToPty(session.id, envelope);
  setTimeout(() => {
    writeToPty(session.id, "\r");
  }, 150);
}
function setupMessageRouter() {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      expireSweep(MESSAGE_TTL_MS);
    }, 6e4);
  }
  function sendMessage(from, to, content, priority) {
    const p = priority === "urgent" ? "urgent" : "normal";
    const resolvedTo = resolveCallName(to);
    if (resolvedTo === null) {
      process.stderr.write(`[msg-router] sendMessage: target '${to}' not found, reject
`);
      return { id: "", delivered: false, error: `目标成员 '${to}' 不存在` };
    }
    const id = enqueue({ from, to: resolvedTo, content, priority: p });
    process.stderr.write(`[msg-router] sendMessage: from=${from}, to=${to}(resolved=${resolvedTo}), content=${content.slice(0, 50)}
`);
    addActiveMessage(from, resolvedTo);
    let delivered = false;
    if (readyMembers.has(resolvedTo)) {
      const session = getSessionByMemberId(resolvedTo);
      if (session) {
        flushQueue(resolvedTo);
        delivered = true;
      }
    }
    return { id, delivered };
  }
  function getInbox(memberId) {
    return peekAll(memberId);
  }
  function consumeInbox(memberId) {
    return consumeAll(memberId);
  }
  function clearInbox(memberId) {
    clearQueue(memberId);
  }
  return { sendMessage, getInbox, consumeInbox, clearInbox };
}
function onMemberReady(memberId) {
  const session = getSessionByMemberId(memberId);
  if (!session) {
    process.stderr.write(`[msg-router] onMemberReady: no session for ${memberId}, skip
`);
    return;
  }
  process.stderr.write(`[msg-router] onMemberReady: ${memberId} ready, sessionId=${session.id}
`);
  const existing = readyDetectors.get(memberId);
  if (existing) {
    if (existing.sessionId === session.id) return;
    existing.destroy();
    readyDetectors.delete(memberId);
  }
  const detector = createReadyDetector({
    sessionId: session.id,
    onReady: () => {
      process.stderr.write(`[msg-router] onReady fired for ${memberId}, marking ready + flushing
`);
      readyMembers.add(memberId);
      const pending = peekAll(memberId);
      for (let i = 0; i < pending.length; i++) {
        flushQueue(memberId);
      }
    }
  });
  readyDetectors.set(memberId, { sessionId: session.id, destroy: detector.destroy });
}
function teardownMessageRouter() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (activeMessageTimer) {
    clearInterval(activeMessageTimer);
    activeMessageTimer = null;
  }
  activeMessages.length = 0;
  for (const [, entry] of readyDetectors) {
    entry.destroy();
  }
  readyDetectors.clear();
  readyMembers.clear();
}
function safeReadFile$1(filePath) {
  try {
    return node_fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
function safeReadJson(filePath) {
  try {
    const raw = node_fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function ensureDir(dir) {
  node_fs.mkdirSync(dir, { recursive: true });
}
function memberDir(membersDir, name) {
  return node_path.join(membersDir, name);
}
function isProcessAlive(pid, sessionStart) {
  try {
    node_child_process.execSync(`kill -0 ${pid}`, { stdio: "pipe" });
    const actualStart = node_child_process.execSync(`ps -p ${pid} -o lstart=`, {
      encoding: "utf-8"
    }).trim();
    return actualStart === sessionStart;
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    if (stderr.includes("Operation not permitted") || stderr.includes("not permitted")) {
      return true;
    }
    return false;
  }
}
function listMembers(membersDir) {
  if (!node_fs.existsSync(membersDir)) return [];
  const entries = node_fs.readdirSync(membersDir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = getMember(membersDir, entry.name);
    if (profile) result.push(profile);
  }
  return result;
}
function getMember(membersDir, name) {
  const filePath = node_path.join(memberDir(membersDir, name), "profile.json");
  const profile = safeReadJson(filePath);
  if (!profile) return null;
  if (!profile.uid) {
    profile.uid = crypto.randomUUID();
    try {
      node_fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
    } catch {
    }
  }
  return profile;
}
function createMember(membersDir, profile) {
  const dir = memberDir(membersDir, profile.name);
  ensureDir(dir);
  const filePath = node_path.join(dir, "profile.json");
  node_fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
}
function deleteMember(membersDir, name) {
  const dir = memberDir(membersDir, name);
  if (!node_fs.existsSync(dir)) return false;
  node_fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
function readLock(membersDir, name) {
  return safeReadJson(node_path.join(memberDir(membersDir, name), "lock.json"));
}
function acquireLock(membersDir, name, sessionPid, sessionStart, project, task) {
  const dir = memberDir(membersDir, name);
  ensureDir(dir);
  const lockPath = node_path.join(dir, "lock.json");
  const nonce = crypto.randomUUID();
  const tmpPath = node_path.join(dir, `lock.tmp.${nonce}`);
  const lockData = {
    nonce,
    session_pid: sessionPid,
    session_start: sessionStart,
    project,
    task,
    locked_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    node_fs.writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), "utf-8");
    try {
      node_fs.linkSync(tmpPath, lockPath);
      node_fs.unlinkSync(tmpPath);
      return { success: true, nonce };
    } catch (err) {
      const e = err;
      if (e.code === "EEXIST") {
        return { success: false, error: "lock already held" };
      }
      throw err;
    }
  } finally {
    try {
      node_fs.unlinkSync(tmpPath);
    } catch {
    }
  }
}
function releaseLock(membersDir, name, expectedNonce) {
  const lockPath = node_path.join(memberDir(membersDir, name), "lock.json");
  const lock = safeReadJson(lockPath);
  if (!lock) return { success: false, error: "no lock found" };
  if (lock.nonce !== expectedNonce) return { success: false, error: "nonce mismatch, not the lock owner" };
  const ts = Date.now();
  const removingPath = `${lockPath}.removing.${ts}`;
  try {
    node_fs.renameSync(lockPath, removingPath);
    node_fs.unlinkSync(removingPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function forceReleaseLock(membersDir, name) {
  const lockPath = node_path.join(memberDir(membersDir, name), "lock.json");
  if (!node_fs.existsSync(lockPath)) return { success: false, error: "no lock found" };
  const ts = Date.now();
  const removingPath = `${lockPath}.removing.${ts}`;
  try {
    node_fs.renameSync(lockPath, removingPath);
    node_fs.unlinkSync(removingPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function updateLock(membersDir, name, expectedNonce, project, task) {
  const dir = memberDir(membersDir, name);
  const lockPath = node_path.join(dir, "lock.json");
  const existing = safeReadJson(lockPath);
  if (!existing) return { success: false, error: "no lock found" };
  if (existing.nonce !== expectedNonce) return { success: false, error: "nonce mismatch" };
  const updated = { ...existing, project, task, locked_at: (/* @__PURE__ */ new Date()).toISOString() };
  const tmpPath = node_path.join(dir, `lock.tmp.${expectedNonce}`);
  try {
    node_fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
    node_fs.renameSync(tmpPath, lockPath);
    return { success: true };
  } catch (err) {
    try {
      node_fs.unlinkSync(tmpPath);
    } catch {
    }
    return { success: false, error: err.message };
  }
}
function takeoverLock(membersDir, name, sessionPid, sessionStart, project, task) {
  const dir = memberDir(membersDir, name);
  ensureDir(dir);
  const lockPath = node_path.join(dir, "lock.json");
  const existing = safeReadJson(lockPath);
  if (!existing) {
    return acquireLock(membersDir, name, sessionPid, sessionStart, project, task);
  }
  if (isProcessAlive(existing.session_pid, existing.session_start)) {
    return { success: false, error: "lock holder is still alive" };
  }
  const nonce = crypto.randomUUID();
  const tmpPath = node_path.join(dir, `lock.tmp.${nonce}`);
  const lockData = {
    nonce,
    session_pid: sessionPid,
    session_start: sessionStart,
    project,
    task,
    locked_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    node_fs.writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), "utf-8");
    node_fs.renameSync(tmpPath, lockPath);
    const verify = safeReadJson(lockPath);
    if (verify?.nonce !== nonce) {
      return { success: false, error: "nonce mismatch after takeover, race condition" };
    }
    return { success: true, nonce };
  } catch (err) {
    try {
      node_fs.unlinkSync(tmpPath);
    } catch {
    }
    return { success: false, error: err.message };
  }
}
function scanOrphanLocks(membersDir) {
  const cleaned = [];
  if (!node_fs.existsSync(membersDir)) return cleaned;
  const entries = node_fs.readdirSync(membersDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lockPath = node_path.join(membersDir, entry.name, "lock.json");
    const lock = safeReadJson(lockPath);
    if (!lock) continue;
    if (!isProcessAlive(lock.session_pid, lock.session_start)) {
      const ts = Date.now();
      const removingPath = `${lockPath}.removing.${ts}`;
      try {
        node_fs.renameSync(lockPath, removingPath);
        node_fs.unlinkSync(removingPath);
        cleaned.push(entry.name);
      } catch {
      }
    }
  }
  return cleaned;
}
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1e3;
function touchHeartbeat(membersDir, name, sessionPid, lastTool) {
  const dir = memberDir(membersDir, name);
  if (!node_fs.existsSync(dir)) return;
  const hbPath = node_path.join(dir, "heartbeat.json");
  const tmpPath = node_path.join(dir, `heartbeat.tmp.${sessionPid}`);
  const now = Date.now();
  const data = {
    last_seen: new Date(now).toISOString(),
    last_seen_ms: now,
    session_pid: sessionPid,
    last_tool: lastTool
  };
  try {
    node_fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    node_fs.renameSync(tmpPath, hbPath);
  } catch {
    try {
      node_fs.unlinkSync(tmpPath);
    } catch {
    }
  }
}
function readHeartbeat(membersDir, name) {
  return safeReadJson(node_path.join(memberDir(membersDir, name), "heartbeat.json"));
}
function removeHeartbeat(membersDir, name) {
  try {
    node_fs.unlinkSync(node_path.join(memberDir(membersDir, name), "heartbeat.json"));
  } catch {
  }
}
function isHeartbeatStale(membersDir, name, timeoutMs = HEARTBEAT_TIMEOUT_MS) {
  const hb = readHeartbeat(membersDir, name);
  if (!hb) return false;
  return Date.now() - hb.last_seen_ms > timeoutMs;
}
function scanStaleHeartbeats(membersDir, timeoutMs = HEARTBEAT_TIMEOUT_MS) {
  const stale = [];
  if (!node_fs.existsSync(membersDir)) return stale;
  const entries = node_fs.readdirSync(membersDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isHeartbeatStale(membersDir, entry.name, timeoutMs)) {
      stale.push(entry.name);
    }
  }
  return stale;
}
function readReservation(membersDir, name) {
  return safeReadJson(node_path.join(memberDir(membersDir, name), "reservation.json"));
}
function writeReservation(membersDir, name, reservation) {
  const dir = memberDir(membersDir, name);
  ensureDir(dir);
  node_fs.writeFileSync(node_path.join(dir, "reservation.json"), JSON.stringify(reservation, null, 2), "utf-8");
}
function deleteReservation(membersDir, name) {
  try {
    node_fs.rmSync(node_path.join(memberDir(membersDir, name), "reservation.json"), { force: true });
  } catch {
  }
}
function memoryFilePath(membersDir, member, scope, project) {
  if (scope === "generic") {
    return node_path.join(memberDir(membersDir, member), "memory_generic.md");
  }
  if (!project) throw new Error("project required for scope=project");
  return node_path.join(memberDir(membersDir, member), `memory_proj_${project}.md`);
}
function readMemory(membersDir, member, scope, project) {
  if (!scope) {
    const generic = safeReadFile$1(memoryFilePath(membersDir, member, "generic"));
    const parts = [generic];
    const dir = memberDir(membersDir, member);
    if (node_fs.existsSync(dir)) {
      const files = node_fs.readdirSync(dir).filter((f) => f.startsWith("memory_proj_"));
      for (const f of files) {
        parts.push(safeReadFile$1(node_path.join(dir, f)));
      }
    }
    return parts.filter(Boolean).join("\n\n---\n\n");
  }
  return safeReadFile$1(memoryFilePath(membersDir, member, scope, project));
}
function saveMemory(membersDir, member, scope, content, project) {
  const filePath = memoryFilePath(membersDir, member, scope, project);
  ensureDir(node_path.dirname(filePath));
  node_fs.appendFileSync(filePath, content + "\n", "utf-8");
}
function readPersona(membersDir, name) {
  const filePath = node_path.join(memberDir(membersDir, name), "persona.md");
  return safeReadFile$1(filePath);
}
function appendWorkLog(membersDir, name, entry) {
  const dir = memberDir(membersDir, name);
  ensureDir(dir);
  const logPath = node_path.join(dir, "work_log.jsonl");
  node_fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
function readWorkLog(membersDir, name, limit) {
  const logPath = node_path.join(memberDir(membersDir, name), "work_log.jsonl");
  if (!node_fs.existsSync(logPath)) return [];
  const lines = node_fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim());
  const result = [];
  for (const line of lines) {
    try {
      result.push(JSON.parse(line));
    } catch {
    }
  }
  if (limit && limit > 0) {
    return result.slice(-limit);
  }
  return result;
}
const sessions = /* @__PURE__ */ new Map();
const MEMBERS_DIR$2 = path.join(os.homedir(), ".claude", "team-hub", "members");
const CASCADE_OFFSET = 30;
const resizeTimers = /* @__PURE__ */ new Map();
function readSavedWindowSize(memberName) {
  const sizePath = path.join(MEMBERS_DIR$2, memberName, "window-size.json");
  try {
    if (fs.existsSync(sizePath)) {
      const data = JSON.parse(fs.readFileSync(sizePath, "utf-8"));
      if (typeof data.width === "number" && typeof data.height === "number") {
        return { width: data.width, height: data.height };
      }
    }
  } catch {
  }
  return null;
}
function saveWindowSize(memberName, width, height) {
  const sizePath = path.join(MEMBERS_DIR$2, memberName, "window-size.json");
  try {
    fs.writeFileSync(sizePath, JSON.stringify({ width, height }), "utf-8");
  } catch {
  }
}
function debouncedSaveWindowSize(winId, memberName, width, height) {
  const existing = resizeTimers.get(winId);
  if (existing) clearTimeout(existing);
  resizeTimers.set(winId, setTimeout(() => {
    resizeTimers.delete(winId);
    saveWindowSize(memberName, width, height);
  }, 300));
}
function calcCascadePosition(winWidth, winHeight) {
  const allWindows = electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (allWindows.length === 0) return void 0;
  const anchor = allWindows.find((w) => {
    const [w2] = w.getSize();
    return w2 < 400;
  }) ?? electron.BrowserWindow.getFocusedWindow() ?? allWindows[0];
  if (!anchor || anchor.isDestroyed()) return void 0;
  const [anchorX, anchorY] = anchor.getPosition();
  const [anchorW] = anchor.getSize();
  const step = sessions.size;
  const baseX = anchorX + anchorW + 10;
  const baseY = anchorY;
  let x = baseX + step * CASCADE_OFFSET;
  let y = baseY + step * CASCADE_OFFSET;
  const display = electron.screen.getDisplayNearestPoint({ x: anchorX, y: anchorY });
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  if (x + winWidth > sx + sw) x = sx + step * CASCADE_OFFSET % Math.max(sw - winWidth, 1);
  if (y + winHeight > sy + sh) y = sy + step * CASCADE_OFFSET % Math.max(sh - winHeight, 1);
  if (x < sx) x = sx;
  if (y < sy) y = sy;
  return { x, y };
}
function checkWorkspaceTrust(workspacePath) {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(claudeJsonPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
    return config?.projects?.[workspacePath]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}
function writeWorkspaceTrust(workspacePath) {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  try {
    let config = {};
    if (fs.existsSync(claudeJsonPath)) {
      config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
    }
    if (!config.projects || typeof config.projects !== "object") {
      config.projects = {};
    }
    const projects = config.projects;
    if (!projects[workspacePath]) {
      projects[workspacePath] = {};
    }
    projects[workspacePath].hasTrustDialogAccepted = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
function openTerminalWindow(opts) {
  const { memberName, cliBin, cliName, isLeader = false, env, workspacePath } = opts;
  if (workspacePath) {
    if (!checkWorkspaceTrust(workspacePath)) {
      return { ok: false, reason: "trust_required", workspacePath };
    }
  }
  for (const [winId, session] of sessions) {
    if (session.memberName === memberName && !session.win.isDestroyed()) {
      session.win.focus();
      return { ok: true, winId };
    }
  }
  const savedSize = readSavedWindowSize(memberName);
  const winWidth = savedSize?.width ?? 900;
  const winHeight = savedSize?.height ?? 600;
  const pos = calcCascadePosition(winWidth, winHeight);
  const win = new electron.BrowserWindow({
    width: winWidth,
    height: winHeight,
    ...pos ? { x: pos.x, y: pos.y } : {},
    minWidth: 600,
    minHeight: 400,
    title: memberName,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/terminal-preload.js"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/terminal.html`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/terminal.html"));
  }
  const onReady = (_event, cols, rows) => {
    if (electron.BrowserWindow.fromWebContents(_event.sender)?.id !== win.id) return;
    let sessionId = getSessionByMemberId(memberName)?.id ?? null;
    if (!sessionId) {
      const memberDir2 = path.join(os.homedir(), ".claude/team-hub/members", memberName);
      const personaPath = path.join(memberDir2, "persona.md");
      let personaContent;
      if (fs.existsSync(personaPath)) {
        personaContent = fs.readFileSync(personaPath, "utf-8");
      } else {
        const profilePath = path.join(memberDir2, "profile.json");
        if (fs.existsSync(profilePath)) {
          try {
            const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
            const name = profile.name || memberName;
            const role = profile.role ? `，角色：${profile.role}` : "";
            const desc = profile.description ? `
${profile.description}` : "";
            personaContent = `你是 ${name}${role}${desc}`;
          } catch {
            personaContent = `你是团队成员 ${memberName}`;
          }
        } else {
          personaContent = `你是团队成员 ${memberName}`;
        }
      }
      const memory = readMemory(MEMBERS_DIR$2, memberName);
      const memorySection = memory ? `

【记忆】
${memory}` : "";
      const systemPrompt = `【身份】
${personaContent}

${isLeader ? "你被指派为 leader。使用 teamhub MCP 的 request_member(auto_spawn=true) 为成员创建独立终端窗口，不要使用内置 Agent 工具。" : "你是团队成员，专注于自己的角色和任务。"}

定期调用 check_inbox 查看是否有新消息。

这是独立交互式终端会话，与你对话的是用户本人。直接以上述身份与用户协作。${memorySection}`;
      const mcpServerEntry = path.join(__dirname, "../../../mcp-server/src/index.ts");
      let bunBin = "bun";
      try {
        bunBin = child_process.execSync("which bun", { encoding: "utf-8", timeout: 3e3 }).trim() || bunBin;
      } catch {
      }
      const mcpConfig = JSON.stringify({
        mcpServers: {
          "teamhub": {
            command: bunBin,
            args: ["run", mcpServerEntry],
            env: { TEAM_HUB_NO_LAUNCH: "1" }
          }
        }
      });
      const result = spawnPtySession({
        agentId: memberName,
        memberId: memberName,
        cliName,
        bin: cliBin,
        args: [
          "--dangerously-skip-permissions",
          "--mcp-config",
          mcpConfig,
          "--strict-mcp-config",
          "--append-system-prompt",
          systemPrompt
        ],
        cols: cols || 120,
        rows: rows || 36,
        cwd: workspacePath,
        env: {
          BUN_DISABLE_KITTY_PROBE: "1",
          KITTY_WINDOW_ID: "",
          ...isLeader ? { CLAUDE_MEMBER: "", IS_LEADER: "1" } : { CLAUDE_MEMBER: memberName },
          TEAM_HUB_NO_LAUNCH: "1",
          ...env
        }
      });
      if (!result.ok) {
        if (!win.isDestroyed()) {
          win.webContents.send("pty-output", `\x1B[31m启动失败: ${result.reason}\x1B[0m\r
`);
        }
        return;
      }
      sessionId = result.sessionId;
      const pid = process.pid;
      const lstart = (/* @__PURE__ */ new Date()).toISOString();
      const lockResult = acquireLock(
        MEMBERS_DIR$2,
        memberName,
        pid,
        lstart,
        opts.project ?? "default",
        opts.task ?? "interactive"
      );
      if (lockResult.success && lockResult.nonce) {
        onReady._lockNonce = lockResult.nonce;
      }
      deleteReservation(MEMBERS_DIR$2, memberName);
      touchHeartbeat(MEMBERS_DIR$2, memberName, pid, "terminal_spawn");
      appendWorkLog(MEMBERS_DIR$2, memberName, {
        event: "check_in",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        project: opts.project ?? "default",
        task: opts.task ?? "interactive"
      });
    }
    const attachResult = attachWindow(sessionId, win);
    if (attachResult.ok && attachResult.buffer) {
      if (!win.isDestroyed()) {
        win.webContents.send("pty-output", attachResult.buffer);
      }
    }
    const lockNonce = onReady._lockNonce;
    sessions.set(win.id, { win, sessionId, memberName, isLeader, lockNonce });
    broadcastPositions();
    onMemberReady(memberName);
    onSessionExit(sessionId, () => {
      if (!win.isDestroyed()) {
        win.close();
      }
    });
    electron.ipcMain.removeListener("terminal-ready", onReady);
  };
  electron.ipcMain.on("terminal-ready", onReady);
  win.once("ready-to-show", () => {
    win.setTitle(memberName);
    if (process.env.E2E_HEADLESS !== "1") win.show();
    broadcastPositions();
  });
  win.on("move", broadcastPositions);
  win.on("resize", broadcastPositions);
  win.on("resize", () => {
    const [w, h] = win.getSize();
    debouncedSaveWindowSize(win.id, memberName, w, h);
  });
  win.on("closed", () => {
    const pendingTimer = resizeTimers.get(win.id);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      resizeTimers.delete(win.id);
    }
    electron.ipcMain.removeListener("terminal-ready", onReady);
    const session = sessions.get(win.id);
    if (session) {
      killPtySession(session.sessionId);
      if (session.lockNonce) {
        releaseLock(MEMBERS_DIR$2, session.memberName, session.lockNonce);
      }
      removeHeartbeat(MEMBERS_DIR$2, session.memberName);
      appendWorkLog(MEMBERS_DIR$2, session.memberName, {
        event: "check_out",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        project: "default",
        task: "interactive"
      });
      sessions.delete(win.id);
    }
    broadcastPositions();
  });
  return { ok: true, winId: win.id };
}
const PALETTE_HEX = [
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#2563eb"
];
const PALETTE_RGB = PALETTE_HEX.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]);
const DEFAULT_COLOR = [80, 140, 255];
function uidToColorRgb(uid) {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash << 5) - hash + uid.charCodeAt(i) | 0;
  }
  return PALETTE_RGB[Math.abs(hash) % PALETTE_RGB.length];
}
function getMemberColor(memberName) {
  const profilePath = path.join(MEMBERS_DIR$2, memberName, "profile.json");
  try {
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
      if (profile.uid) return uidToColorRgb(profile.uid);
    }
  } catch {
  }
  return DEFAULT_COLOR;
}
function getAllTerminalPositions() {
  const result = [];
  const BODY_PADDING = 8;
  for (const [winId, session] of sessions) {
    if (session.win.isDestroyed()) continue;
    const bounds = session.win.getBounds();
    result.push({
      id: winId,
      memberName: session.memberName,
      isLeader: session.isLeader,
      x: bounds.x + BODY_PADDING,
      y: bounds.y + BODY_PADDING,
      w: bounds.width - BODY_PADDING * 2,
      h: bounds.height - BODY_PADDING * 2,
      color: getMemberColor(session.memberName)
    });
  }
  return result;
}
function broadcastPositions() {
  updateWindowPositions(getAllTerminalPositions());
}
function setupTerminalIpc() {
  electron.ipcMain.on("close-terminal-window", (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });
  electron.ipcMain.handle("get-member-color", (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return DEFAULT_COLOR;
    const name = win.getTitle();
    if (!name) return DEFAULT_COLOR;
    return getMemberColor(name);
  });
  electron.ipcMain.handle("get-member-name", (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return "成员";
    const session = sessions.get(win.id);
    return session?.memberName || "成员";
  });
  electron.ipcMain.handle("trust-workspace", (_event, workspacePath) => {
    if (!workspacePath || typeof workspacePath !== "string") {
      return { ok: false, reason: "workspacePath is required" };
    }
    const success = writeWorkspaceTrust(workspacePath);
    return success ? { ok: true } : { ok: false, reason: "failed to write ~/.claude.json" };
  });
  electron.ipcMain.on("terminal-input", (event, data) => {
    const winId = electron.BrowserWindow.fromWebContents(event.sender)?.id;
    if (winId == null) return;
    const session = sessions.get(winId);
    if (!session) return;
    writeToPty(session.sessionId, data);
  });
  electron.ipcMain.on("terminal-resize", (event, cols, rows) => {
    const winId = electron.BrowserWindow.fromWebContents(event.sender)?.id;
    if (winId == null) return;
    const session = sessions.get(winId);
    if (!session) return;
    resizePty(session.sessionId, cols, rows);
  });
}
const MAX_VISIBLE = 3;
const STACK_OFFSET_X = 10;
const STACK_OFFSET_Y = 20;
const DEFAULT_TIMEOUT_MS = 12e4;
const visibleStack = [];
const waitingQueue = [];
let requestCounter = 0;
function createAskUserRequest(params) {
  const id = `ask_${Date.now()}_${++requestCounter}`;
  const request = {
    id,
    member_name: params.member_name,
    type: params.type,
    title: params.title,
    question: params.question,
    options: params.options,
    timeout_ms: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    created_at: Date.now()
  };
  return new Promise((resolve) => {
    const pending = { request, win: null, timer: null, resolve };
    if (visibleStack.length < MAX_VISIBLE) {
      showRequest(pending);
    } else {
      waitingQueue.push(pending);
    }
  });
}
function calcWindowPosition(stackIndex, winWidth, winHeight) {
  const focused = electron.BrowserWindow.getFocusedWindow();
  const allWindows = electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const anchor = focused ?? allWindows[0];
  if (!anchor || anchor.isDestroyed()) return void 0;
  const [anchorX, anchorY] = anchor.getPosition();
  const [anchorW, anchorH] = anchor.getSize();
  let x = anchorX + Math.round((anchorW - winWidth) / 2) + stackIndex * STACK_OFFSET_X;
  let y = anchorY + Math.round((anchorH - winHeight) / 2) + stackIndex * STACK_OFFSET_Y;
  const display = electron.screen.getDisplayNearestPoint({ x: anchorX, y: anchorY });
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  if (x + winWidth > sx + sw) x = sx + sw - winWidth;
  if (y + winHeight > sy + sh) y = sy + sh - winHeight;
  if (x < sx) x = sx;
  if (y < sy) y = sy;
  return { x, y };
}
function showRequest(pending) {
  visibleStack.push(pending);
  const stackIndex = visibleStack.length - 1;
  const winWidth = 420;
  const winHeight = 360;
  const pos = calcWindowPosition(stackIndex, winWidth, winHeight);
  const win = new electron.BrowserWindow({
    width: winWidth,
    height: winHeight,
    ...pos ? { x: pos.x, y: pos.y } : {},
    minWidth: 360,
    minHeight: 280,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/ask-user-preload.js"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  pending.win = win;
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/ask-user.html`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/ask-user.html"));
  }
  win.once("ready-to-show", () => {
    if (process.env.E2E_HEADLESS !== "1") win.show();
    win.webContents.send("show-ask-user", pending.request);
  });
  pending.timer = setTimeout(() => {
    resolveRequest(pending, { answered: false, reason: "timeout" });
  }, pending.request.timeout_ms);
  win.on("closed", () => {
    if (visibleStack.includes(pending) || waitingQueue.includes(pending)) {
      resolveRequest(pending, { answered: false, reason: "cancelled" });
    }
  });
}
function resolveRequest(pending, response) {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  const visIdx = visibleStack.indexOf(pending);
  if (visIdx !== -1) {
    visibleStack.splice(visIdx, 1);
  }
  const qIdx = waitingQueue.indexOf(pending);
  if (qIdx !== -1) {
    waitingQueue.splice(qIdx, 1);
  }
  if (pending.win && !pending.win.isDestroyed()) {
    pending.win.close();
  }
  pending.resolve(response);
  while (visibleStack.length < MAX_VISIBLE && waitingQueue.length > 0) {
    const next = waitingQueue.shift();
    showRequest(next);
  }
}
function setupAskUserIpc() {
  electron.ipcMain.on("ask-user-response", (_event, requestId, response) => {
    const pending = visibleStack.find((p) => p.request.id === requestId);
    if (!pending) return;
    resolveRequest(pending, {
      answered: true,
      choice: response.choice,
      input: response.input
    });
  });
  electron.ipcMain.on("ask-user-cancel", (_event, requestId) => {
    const pending = visibleStack.find((p) => p.request.id === requestId);
    if (!pending) return;
    resolveRequest(pending, { answered: false, reason: "cancelled" });
  });
  electron.ipcMain.handle("ask-user-get-request", (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const pending = visibleStack.find((p) => p.win?.id === win.id);
    return pending?.request ?? null;
  });
}
const TEAM_HUB_DIR$3 = node_path.join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
  ".claude",
  "team-hub"
);
const VAULT_PATH = node_path.join(TEAM_HUB_DIR$3, "vault.json");
const PASSKEY_PATH = node_path.join(TEAM_HUB_DIR$3, "passkey.json");
const MASTER_KEY_TTL_MS = 30 * 60 * 1e3;
const MASTER_CHECK_PLAINTEXT = "team-hub-vault-ok";
const HKDF_MASTER_INFO_PREFIX = "mcp-team-hub-vault-master";
const HKDF_ENTRY_INFO_PREFIX = "api-";
function deriveMasterKey(challengeB64url, masterSalt) {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "none";
  const info = `${HKDF_MASTER_INFO_PREFIX}:${node_os.hostname()}:${uid}`;
  return Buffer.from(
    crypto$1.hkdfSync(
      "sha256",
      Buffer.from(challengeB64url, "base64url"),
      masterSalt,
      Buffer.from(info),
      32
    )
  );
}
function deriveEntryKey(masterKey, apiName, entrySalt) {
  return Buffer.from(
    crypto$1.hkdfSync(
      "sha256",
      masterKey,
      entrySalt,
      Buffer.from(`${HKDF_ENTRY_INFO_PREFIX}${apiName}`),
      32
    )
  );
}
function aesEncrypt(key, plaintext) {
  const iv = crypto$1.randomBytes(12);
  const cipher = crypto$1.createCipheriv("aes-256-gcm", key, iv);
  let enc = cipher.update(plaintext, "utf-8", "hex");
  enc += cipher.final("hex");
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: enc
  };
}
function aesDecrypt(key, iv, tag, ciphertext) {
  const decipher = crypto$1.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let dec = decipher.update(ciphertext, "hex", "utf-8");
  dec += decipher.final("utf-8");
  return dec;
}
class VaultManager {
  masterKey = null;
  masterKeyExpiry = 0;
  // ── Passkey Lifecycle ──────────────────────────────────────────────────
  /**
   * Check if passkey has been registered (passkey.json exists)
   */
  isRegistered() {
    return node_fs.existsSync(PASSKEY_PATH);
  }
  /**
   * Check if vault is unlocked (master key in memory and not expired)
   */
  isUnlocked() {
    return this.masterKey !== null && Date.now() < this.masterKeyExpiry;
  }
  /**
   * Get vault status string
   */
  getStatus() {
    if (!this.isRegistered()) return "unregistered";
    if (this.isUnlocked()) return "unlocked";
    return "locked";
  }
  /**
   * Generate a random challenge for WebAuthn registration.
   * Returns base64url-encoded challenge.
   */
  getRegistrationChallenge() {
    const challenge = crypto$1.randomBytes(32).toString("base64url");
    return { challenge, rp_id: "mcp-team-hub" };
  }
  /**
   * Complete passkey registration.
   * Stores the credential and initializes an empty vault.
   *
   * @param credentialId - base64 encoded credential ID
   * @param publicKey - base64 encoded public key
   * @param challengeB64url - the original challenge (base64url)
   */
  completeRegistration(credentialId, publicKey, challengeB64url) {
    try {
      node_fs.mkdirSync(TEAM_HUB_DIR$3, { recursive: true });
      const credential = {
        credential_id: credentialId,
        public_key: publicKey,
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        rp_id: "mcp-team-hub"
      };
      node_fs.writeFileSync(PASSKEY_PATH, JSON.stringify(credential, null, 2), { mode: 384 });
      const masterSalt = crypto$1.randomBytes(16);
      const mk = deriveMasterKey(challengeB64url, masterSalt);
      const check = aesEncrypt(mk, MASTER_CHECK_PLAINTEXT);
      const vault = {
        version: 1,
        master_salt: masterSalt.toString("hex"),
        master_check: check.ciphertext,
        master_check_iv: check.iv,
        master_check_tag: check.tag,
        entries: {}
      };
      node_fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 384 });
      this.masterKey = mk;
      this.masterKeyExpiry = Date.now() + MASTER_KEY_TTL_MS;
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  /**
   * Generate a random challenge for WebAuthn authentication.
   */
  getAuthenticationChallenge() {
    if (!this.isRegistered()) {
      return { error: "Passkey not registered. Register first." };
    }
    const cred = this.loadCredential();
    if (!cred) return { error: "Failed to load passkey credential." };
    const challenge = crypto$1.randomBytes(32).toString("base64url");
    return { challenge, credential_id: cred.credential_id };
  }
  /**
   * Complete authentication: derive master key from challenge, verify against vault check.
   *
   * @param challengeB64url - the challenge that was signed (base64url)
   */
  completeAuthentication(challengeB64url) {
    try {
      const vault = this.loadVault();
      if (!vault) return { success: false, error: "Vault file not found." };
      const masterSalt = Buffer.from(vault.master_salt, "hex");
      const mk = deriveMasterKey(challengeB64url, masterSalt);
      try {
        const decrypted = aesDecrypt(mk, vault.master_check_iv, vault.master_check_tag, vault.master_check);
        if (decrypted !== MASTER_CHECK_PLAINTEXT) {
          return { success: false, error: "Master key verification failed." };
        }
      } catch {
        return { success: false, error: "Invalid passkey or corrupted vault." };
      }
      this.masterKey = mk;
      this.masterKeyExpiry = Date.now() + MASTER_KEY_TTL_MS;
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  /**
   * Lock the vault: clear master key from memory.
   */
  lock() {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    this.masterKeyExpiry = 0;
  }
  // ── Key CRUD ───────────────────────────────────────────────────────────
  /**
   * Add or update an API key in the vault.
   * Vault must be unlocked.
   */
  addKey(apiName, secretValue) {
    if (!this.isUnlocked()) {
      return { success: false, error: "Vault is locked. Unlock with passkey first." };
    }
    try {
      const vault = this.loadVault();
      if (!vault) return { success: false, error: "Vault file not found." };
      const entrySalt = crypto$1.randomBytes(16);
      const entryKey = deriveEntryKey(this.masterKey, apiName, entrySalt);
      const encrypted = aesEncrypt(entryKey, secretValue);
      const displayHint = secretValue.length >= 4 ? `...${secretValue.slice(-4)}` : "****";
      vault.entries[apiName] = {
        salt: entrySalt.toString("hex"),
        iv: encrypted.iv,
        tag: encrypted.tag,
        ciphertext: encrypted.ciphertext,
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        last_used: null,
        display_hint: displayHint
      };
      this.saveVault(vault);
      return { success: true, display_hint: displayHint };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  /**
   * Remove an API key from the vault.
   * Vault must be unlocked.
   */
  removeKey(apiName) {
    if (!this.isUnlocked()) {
      return { success: false, error: "Vault is locked." };
    }
    try {
      const vault = this.loadVault();
      if (!vault) return { success: false, error: "Vault file not found." };
      if (!(apiName in vault.entries)) {
        return { success: false, error: `Key '${apiName}' not found in vault.` };
      }
      delete vault.entries[apiName];
      this.saveVault(vault);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  /**
   * List all key names and metadata (no secrets).
   */
  listKeys() {
    try {
      const vault = this.loadVault();
      if (!vault) return [];
      return Object.entries(vault.entries).map(([name, entry]) => ({
        name,
        display_hint: entry.display_hint,
        created_at: entry.created_at,
        last_used: entry.last_used
      }));
    } catch {
      return [];
    }
  }
  /**
   * Decrypt and return an API key. Used internally by api-proxy.
   * Vault must be unlocked. Updates last_used timestamp.
   */
  decryptKey(apiName) {
    if (!this.isUnlocked()) return null;
    try {
      const vault = this.loadVault();
      if (!vault) return null;
      const entry = vault.entries[apiName];
      if (!entry) return null;
      const entrySalt = Buffer.from(entry.salt, "hex");
      const entryKey = deriveEntryKey(this.masterKey, apiName, entrySalt);
      const plaintext = aesDecrypt(entryKey, entry.iv, entry.tag, entry.ciphertext);
      entry.last_used = (/* @__PURE__ */ new Date()).toISOString();
      this.saveVault(vault);
      return plaintext;
    } catch {
      return null;
    }
  }
  /**
   * Check if a specific key exists in the vault (does not require unlock).
   */
  hasKey(apiName) {
    try {
      const vault = this.loadVault();
      return vault !== null && apiName in vault.entries;
    } catch {
      return false;
    }
  }
  // ── File I/O ───────────────────────────────────────────────────────────
  loadVault() {
    try {
      if (!node_fs.existsSync(VAULT_PATH)) return null;
      const raw = node_fs.readFileSync(VAULT_PATH, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  saveVault(vault) {
    node_fs.mkdirSync(TEAM_HUB_DIR$3, { recursive: true });
    node_fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 384 });
    try {
      node_fs.chmodSync(VAULT_PATH, 384);
    } catch {
    }
  }
  loadCredential() {
    try {
      if (!node_fs.existsSync(PASSKEY_PATH)) return null;
      const raw = node_fs.readFileSync(PASSKEY_PATH, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
const vaultManager = new VaultManager();
const TEAM_HUB_DIR$2 = node_path.join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
  ".claude",
  "team-hub"
);
const REGISTRY_PATH = node_path.join(TEAM_HUB_DIR$2, "api-registry.json");
const PRESETS = [
  {
    name: "openai",
    base_url: "https://api.openai.com",
    auth_type: "bearer",
    auth_header: "Authorization",
    auth_prefix: "Bearer ",
    description: "OpenAI API (GPT, DALL-E, Whisper, Embeddings)",
    is_preset: true
  },
  {
    name: "anthropic",
    base_url: "https://api.anthropic.com",
    auth_type: "custom",
    auth_header: "x-api-key",
    description: "Anthropic API (Claude models)",
    is_preset: true
  },
  {
    name: "google",
    base_url: "https://generativelanguage.googleapis.com",
    auth_type: "bearer",
    auth_header: "Authorization",
    auth_prefix: "Bearer ",
    description: "Google Generative AI API (Gemini)",
    is_preset: true
  },
  {
    name: "github",
    base_url: "https://api.github.com",
    auth_type: "bearer",
    auth_header: "Authorization",
    auth_prefix: "Bearer ",
    description: "GitHub REST API",
    is_preset: true
  }
];
class ApiRegistry {
  customApis = /* @__PURE__ */ new Map();
  loaded = false;
  /**
   * Get an API definition by name. Checks presets first, then custom.
   */
  get(name) {
    this.ensureLoaded();
    const preset = PRESETS.find((p) => p.name === name);
    if (preset) return preset;
    return this.customApis.get(name) ?? null;
  }
  /**
   * List all registered APIs (presets + custom).
   */
  list() {
    this.ensureLoaded();
    return [...PRESETS, ...Array.from(this.customApis.values())];
  }
  /**
   * Register a custom API definition.
   * Cannot overwrite presets.
   */
  register(def) {
    this.ensureLoaded();
    if (PRESETS.some((p) => p.name === def.name)) {
      return { success: false, error: `Cannot overwrite preset API '${def.name}'.` };
    }
    if (!def.name || !def.base_url || !def.auth_type || !def.auth_header) {
      return { success: false, error: "Missing required fields: name, base_url, auth_type, auth_header." };
    }
    try {
      new URL(def.base_url);
    } catch {
      return { success: false, error: `Invalid base_url: '${def.base_url}'.` };
    }
    this.customApis.set(def.name, { ...def, is_preset: false });
    this.persist();
    return { success: true };
  }
  /**
   * Remove a custom API definition.
   * Cannot remove presets.
   */
  unregister(name) {
    this.ensureLoaded();
    if (PRESETS.some((p) => p.name === name)) {
      return { success: false, error: `Cannot remove preset API '${name}'.` };
    }
    if (!this.customApis.has(name)) {
      return { success: false, error: `Custom API '${name}' not found.` };
    }
    this.customApis.delete(name);
    this.persist();
    return { success: true };
  }
  /**
   * Validate that a URL is allowed for the given API (must start with base_url).
   */
  validateUrl(apiName, url) {
    const def = this.get(apiName);
    if (!def) return false;
    try {
      const parsed = new URL(url);
      const base = new URL(def.base_url);
      return parsed.origin === base.origin && parsed.pathname.startsWith(base.pathname);
    } catch {
      return false;
    }
  }
  /**
   * Build the auth header value for a given API and key.
   */
  buildAuthValue(apiName, key) {
    const def = this.get(apiName);
    if (!def) return null;
    const value = def.auth_prefix ? `${def.auth_prefix}${key}` : key;
    return { header: def.auth_header, value };
  }
  // ── Persistence ────────────────────────────────────────────────────────
  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!node_fs.existsSync(REGISTRY_PATH)) return;
      const raw = node_fs.readFileSync(REGISTRY_PATH, "utf-8");
      const data = JSON.parse(raw);
      for (const def of data) {
        if (!PRESETS.some((p) => p.name === def.name)) {
          this.customApis.set(def.name, { ...def, is_preset: false });
        }
      }
    } catch {
      this.customApis.clear();
    }
  }
  persist() {
    try {
      node_fs.mkdirSync(TEAM_HUB_DIR$2, { recursive: true });
      const data = Array.from(this.customApis.values()).map(({ is_preset: _, ...rest }) => rest);
      node_fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[api-registry] Failed to persist:", err);
    }
  }
}
const apiRegistry = new ApiRegistry();
async function proxyApiRequest(req) {
  try {
    if (!vaultManager.isRegistered() || !vaultManager.isUnlocked()) {
      return {
        error: "Vault is not initialized or unlocked. Use passkey to unlock first.",
        code: "VAULT_LOCKED"
      };
    }
    const apiKey = vaultManager.decryptKey(req.api_name);
    if (!apiKey) {
      return {
        error: `API key not found for ${req.api_name}. Use vault API to add it first.`,
        code: "KEY_NOT_FOUND"
      };
    }
    const apiDef = apiRegistry.get(req.api_name);
    if (!apiDef) {
      return {
        error: `API not registered: ${req.api_name}`,
        code: "API_NOT_REGISTERED"
      };
    }
    if (!apiRegistry.validateUrl(req.api_name, req.url)) {
      return {
        error: `URL not allowed for API '${req.api_name}'. Must start with ${apiDef.base_url}`,
        code: "URL_NOT_ALLOWED"
      };
    }
    const finalUrl = new node_url.URL(req.url, apiDef.base_url).toString();
    const headers = {
      ...req.headers
    };
    const auth = apiRegistry.buildAuthValue(req.api_name, apiKey);
    if (auth) {
      headers[auth.header] = auth.value;
    }
    const response = await forwardRequest(finalUrl, req.method, headers, req.body);
    return response;
  } catch (err) {
    return {
      error: `API proxy failed: ${err instanceof Error ? err.message : String(err)}`,
      code: "PROXY_ERROR",
      details: err
    };
  }
}
async function forwardRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new node_url.URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const client = isHttps ? https : http;
    const options = {
      method: method.toUpperCase(),
      headers: {
        ...headers,
        "Content-Length": body ? Buffer.byteLength(body) : 0
      },
      timeout: 3e4
      // 30 second timeout
    };
    const req = client.request(parsedUrl, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf-8");
        const responseHeaders = {};
        if (res.headers["content-type"]) responseHeaders["content-type"] = res.headers["content-type"];
        if (res.headers["content-length"]) responseHeaders["content-length"] = res.headers["content-length"];
        if (res.headers["x-ratelimit-remaining"]) responseHeaders["x-ratelimit-remaining"] = res.headers["x-ratelimit-remaining"];
        if (res.headers["x-ratelimit-reset"]) responseHeaders["x-ratelimit-reset"] = res.headers["x-ratelimit-reset"];
        resolve({
          status: res.statusCode || 500,
          headers: responseHeaders,
          body: responseBody
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
function listApiKeys() {
  return vaultManager.listKeys();
}
function addApiKey(apiName, value) {
  if (!vaultManager.isUnlocked()) {
    return { success: false, error: "Vault is locked. Unlock with passkey first." };
  }
  return vaultManager.addKey(apiName, value);
}
function removeApiKey(apiName) {
  if (!vaultManager.isUnlocked()) {
    return { success: false, error: "Vault is locked. Unlock with passkey first." };
  }
  return vaultManager.removeKey(apiName);
}
const TEAM_HUB_DIR$1 = node_path.join(node_os.homedir(), ".claude", "team-hub");
const MEMBERS_DIR$1 = node_path.join(TEAM_HUB_DIR$1, "members");
const SHARED_DIR$1 = node_path.join(TEAM_HUB_DIR$1, "shared");
const PANEL_PORT_FILE = node_path.join(TEAM_HUB_DIR$1, "panel.port");
const PANEL_HOST = "127.0.0.1";
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
let _messageRouter = null;
function setMessageRouter(router) {
  _messageRouter = router;
}
function readJsonFile(filePath) {
  try {
    return JSON.parse(node_fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
function safeReadFile(filePath) {
  try {
    return node_fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
function getMemberStatus(name) {
  const profile = getMember(MEMBERS_DIR$1, name);
  if (!profile) return null;
  const lock = readLock(MEMBERS_DIR$1, name);
  const heartbeat = readHeartbeat(MEMBERS_DIR$1, name);
  const reservation = readReservation(MEMBERS_DIR$1, name);
  const validReservation = reservation && Date.now() - reservation.created_at <= reservation.ttl_ms ? reservation : null;
  if (reservation && !validReservation) {
    deleteReservation(MEMBERS_DIR$1, name);
  }
  let status;
  if (lock) {
    status = "working";
  } else {
    const ptySession = getPtySessions().find((s) => s.memberId === name && s.status === "running");
    if (ptySession) {
      status = "working";
    } else if (validReservation) {
      status = "reserved";
    } else {
      status = "offline";
    }
  }
  return { profile, lock, heartbeat, reservation: validReservation, status };
}
function matchRoute(method, pattern, reqMethod, url) {
  if (method !== reqMethod) return null;
  const patternParts = pattern.split("/");
  const urlParts = url.split("?")[0].split("/");
  if (patternParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}
function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const qs = {};
  for (const pair of url.slice(idx + 1).split("&")) {
    const [k, v] = pair.split("=");
    if (k) qs[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return qs;
}
let panelServer = null;
function startPanelApi() {
  if (panelServer) return;
  panelServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url === "/api/agent-clis") {
        const result = await scanAgentClis();
        return jsonResponse(res, 200, result);
      }
      if (method === "POST" && url === "/api/pty/spawn") {
        const body = await readBody(req);
        if (!body.member || !body.cli_name) {
          return jsonResponse(res, 400, { error: "member and cli_name are required" });
        }
        let bin = body.cli_bin;
        if (!bin) {
          const scan = await scanAgentClis();
          const found = scan.found.find((c) => c.name === body.cli_name);
          if (!found) {
            return jsonResponse(res, 404, { error: `CLI '${body.cli_name}' not found` });
          }
          bin = found.bin;
        }
        const displayName = body.member;
        if (body.workspace_path) {
          const claudeJsonPath = node_path.join(node_os.homedir(), ".claude.json");
          try {
            let config = {};
            if (node_fs.existsSync(claudeJsonPath)) {
              config = JSON.parse(node_fs.readFileSync(claudeJsonPath, "utf-8"));
            }
            if (!config.projects || typeof config.projects !== "object") {
              config.projects = {};
            }
            const projects = config.projects;
            if (!projects[body.workspace_path]) {
              projects[body.workspace_path] = {};
            }
            if (!projects[body.workspace_path].hasTrustDialogAccepted) {
              projects[body.workspace_path].hasTrustDialogAccepted = true;
              node_fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), "utf-8");
            }
          } catch {
          }
        }
        const result = openTerminalWindow({
          memberName: body.member,
          cliBin: bin,
          cliName: body.cli_name,
          isLeader: body.is_leader ?? false,
          workspacePath: body.workspace_path
        });
        if (!result.ok) {
          const status = result.reason === "trust_required" ? 403 : 500;
          return jsonResponse(res, status, {
            error: result.reason,
            workspace_path: result.workspacePath
          });
        }
        return jsonResponse(res, 200, { ok: true, winId: result.winId });
      }
      if (method === "GET" && url === "/api/pty/sessions") {
        return jsonResponse(res, 200, { sessions: getPtySessions() });
      }
      if (method === "POST" && url === "/api/pty/write") {
        const body = await readBody(req);
        if (!body.member || !body.content) {
          return jsonResponse(res, 400, { error: "member and content are required" });
        }
        const shouldWait = body.wait !== false;
        let session = getSessionByMemberId(body.member);
        if (!session && shouldWait) {
          const ready = await waitForCliReady(body.member, 3e4);
          if (ready) {
            session = getSessionByMemberId(body.member);
          }
        }
        if (!session) {
          return jsonResponse(res, 404, { error: `成员 ${body.member} 没有活跃终端（等待超时）` });
        }
        writeToPty(session.id, body.content + "\r");
        return jsonResponse(res, 200, { ok: true });
      }
      if (method === "POST" && url === "/api/pty/kill") {
        const body = await readBody(req);
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: "session_id is required" });
        }
        const killed = killPtySession(body.session_id);
        return jsonResponse(res, 200, { ok: killed });
      }
      if (method === "POST" && url === "/api/message/send") {
        const body = await readBody(req);
        if (!body.from || !body.to || !body.content) {
          return jsonResponse(res, 400, { error: "from, to, and content are required" });
        }
        if (!_messageRouter) {
          return jsonResponse(res, 503, { error: "message router not ready" });
        }
        const result = _messageRouter.sendMessage(body.from, body.to, body.content, body.priority);
        if (result.error) {
          return jsonResponse(res, 400, { ok: false, error: result.error });
        }
        return jsonResponse(res, 200, { ok: true, id: result.id, delivered: result.delivered });
      }
      const inboxMatch = url.match(/^\/api\/message\/inbox\/([^/]+)$/);
      if (inboxMatch && (method === "GET" || method === "DELETE")) {
        const member = decodeURIComponent(inboxMatch[1]);
        if (!_messageRouter) {
          return jsonResponse(res, 503, { error: "message router not ready" });
        }
        const messages = method === "DELETE" ? _messageRouter.consumeInbox(member) : _messageRouter.getInbox(member);
        return jsonResponse(res, 200, { member, messages });
      }
      let params;
      if (method === "GET" && url.split("?")[0] === "/api/member/list") {
        const profiles = listMembers(MEMBERS_DIR$1);
        const members = profiles.map((p) => {
          const s = getMemberStatus(p.name);
          return s ? {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status
          } : { ...p, status: "offline" };
        });
        return jsonResponse(res, 200, { ok: true, data: members });
      }
      if (method === "POST" && url === "/api/member/create") {
        const body = await readBody(req);
        if (!body.name || !body.role) {
          return jsonResponse(res, 400, { ok: false, error: "name, role are required" });
        }
        const existing = getMember(MEMBERS_DIR$1, body.name);
        if (existing) {
          return jsonResponse(res, 409, { ok: false, error: `member ${body.name} already exists` });
        }
        const profile = {
          uid: body.uid ?? crypto$1.randomUUID(),
          name: body.name,
          role: body.role,
          type: body.type ?? "temporary",
          joined_at: body.joined_at ?? (/* @__PURE__ */ new Date()).toISOString(),
          skills: body.skills,
          description: body.description
        };
        createMember(MEMBERS_DIR$1, profile);
        return jsonResponse(res, 201, { ok: true, data: profile });
      }
      params = matchRoute("GET", "/api/member/:name", method, url);
      if (params && params.name !== "list") {
        const s = getMemberStatus(params.name);
        if (!s) return jsonResponse(res, 404, { ok: false, error: "member not found" });
        const persona = readPersona(MEMBERS_DIR$1, params.name) || null;
        const memory = readMemory(MEMBERS_DIR$1, params.name) || null;
        const workLog = readWorkLog(MEMBERS_DIR$1, params.name, 50);
        return jsonResponse(res, 200, {
          ok: true,
          data: {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status,
            persona,
            memory,
            workLog
          }
        });
      }
      params = matchRoute("DELETE", "/api/member/:name", method, url);
      if (params) {
        const deleted = deleteMember(MEMBERS_DIR$1, params.name);
        if (!deleted) return jsonResponse(res, 404, { ok: false, error: "member not found" });
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("PATCH", "/api/member/:name/profile", method, url);
      if (params) {
        const existing = getMember(MEMBERS_DIR$1, params.name);
        if (!existing) return jsonResponse(res, 404, { ok: false, error: "member not found" });
        const body = await readBody(req);
        const updated = { ...existing, ...body, name: existing.name, uid: existing.uid };
        createMember(MEMBERS_DIR$1, updated);
        return jsonResponse(res, 200, { ok: true, data: updated });
      }
      params = matchRoute("GET", "/api/member/:name/status", method, url);
      if (params) {
        const s = getMemberStatus(params.name);
        if (!s) return jsonResponse(res, 404, { ok: false, error: "member not found" });
        return jsonResponse(res, 200, { ok: true, data: { name: params.name, status: s.status } });
      }
      params = matchRoute("POST", "/api/member/:name/lock/acquire", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "session_pid, session_start, project, task required" });
        }
        const result = acquireLock(MEMBERS_DIR$1, params.name, body.session_pid, body.session_start, body.project, body.task);
        const status = result.success ? 200 : 409;
        return jsonResponse(res, status, { ok: result.success, nonce: result.nonce, error: result.error });
      }
      params = matchRoute("POST", "/api/member/:name/lock/release", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.nonce) return jsonResponse(res, 400, { ok: false, error: "nonce required" });
        const result = releaseLock(MEMBERS_DIR$1, params.name, body.nonce);
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error });
      }
      params = matchRoute("POST", "/api/member/:name/lock/update", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.nonce || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "nonce, project, task required" });
        }
        const result = updateLock(MEMBERS_DIR$1, params.name, body.nonce, body.project, body.task);
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error });
      }
      params = matchRoute("POST", "/api/member/:name/lock/takeover", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "session_pid, session_start, project, task required" });
        }
        const result = takeoverLock(MEMBERS_DIR$1, params.name, body.session_pid, body.session_start, body.project, body.task);
        const status = result.success ? 200 : 409;
        return jsonResponse(res, status, { ok: result.success, nonce: result.nonce, error: result.error });
      }
      params = matchRoute("POST", "/api/member/:name/lock/force-release", method, url);
      if (params) {
        const result = forceReleaseLock(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, result.success ? 200 : 404, { ok: result.success, error: result.error });
      }
      params = matchRoute("GET", "/api/member/:name/lock", method, url);
      if (params) {
        const lock = readLock(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true, data: lock });
      }
      params = matchRoute("POST", "/api/member/:name/heartbeat", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.session_pid || !body.last_tool) {
          return jsonResponse(res, 400, { ok: false, error: "session_pid, last_tool required" });
        }
        touchHeartbeat(MEMBERS_DIR$1, params.name, body.session_pid, body.last_tool);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/member/:name/heartbeat", method, url);
      if (params) {
        const hb = readHeartbeat(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true, data: hb });
      }
      params = matchRoute("DELETE", "/api/member/:name/heartbeat", method, url);
      if (params) {
        removeHeartbeat(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true });
      }
      if (method === "GET" && url.split("?")[0] === "/api/heartbeat/stale") {
        const stale = scanStaleHeartbeats(MEMBERS_DIR$1);
        return jsonResponse(res, 200, { ok: true, data: stale });
      }
      params = matchRoute("POST", "/api/member/:name/reservation", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.code || !body.caller || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "code, caller, project, task required" });
        }
        const reservation = {
          code: body.code,
          member: body.member ?? params.name,
          caller: body.caller,
          project: body.project,
          task: body.task,
          session_id: body.session_id ?? "",
          created_at: body.created_at ?? Date.now(),
          ttl_ms: body.ttl_ms ?? 21e4
        };
        writeReservation(MEMBERS_DIR$1, params.name, reservation);
        return jsonResponse(res, 200, { ok: true, data: reservation });
      }
      params = matchRoute("GET", "/api/member/:name/reservation", method, url);
      if (params) {
        const reservation = readReservation(MEMBERS_DIR$1, params.name);
        if (reservation && Date.now() - reservation.created_at > reservation.ttl_ms) {
          deleteReservation(MEMBERS_DIR$1, params.name);
          return jsonResponse(res, 200, { ok: true, data: null });
        }
        return jsonResponse(res, 200, { ok: true, data: reservation });
      }
      params = matchRoute("DELETE", "/api/member/:name/reservation", method, url);
      if (params) {
        deleteReservation(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("POST", "/api/member/:name/memory/save", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.content) {
          return jsonResponse(res, 400, { ok: false, error: "content required" });
        }
        const scope = body.scope === "project" ? "project" : "generic";
        saveMemory(MEMBERS_DIR$1, params.name, scope, body.content, body.project);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/member/:name/memory", method, url);
      if (params) {
        const query = parseQuery(url);
        const memScope = query.scope === "project" ? "project" : query.scope === "generic" ? "generic" : void 0;
        const content = readMemory(MEMBERS_DIR$1, params.name, memScope, query.project);
        return jsonResponse(res, 200, { ok: true, data: content || null });
      }
      params = matchRoute("GET", "/api/member/:name/persona", method, url);
      if (params) {
        const content = readPersona(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true, data: content || null });
      }
      params = matchRoute("POST", "/api/member/:name/worklog", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.event || !body.timestamp || !body.project) {
          return jsonResponse(res, 400, { ok: false, error: "event, timestamp, project required" });
        }
        appendWorkLog(MEMBERS_DIR$1, params.name, body);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/member/:name/worklog", method, url);
      if (params) {
        const query = parseQuery(url);
        const limit = query.limit ? parseInt(query.limit, 10) : void 0;
        const entries = readWorkLog(MEMBERS_DIR$1, params.name, limit);
        return jsonResponse(res, 200, { ok: true, data: entries });
      }
      params = matchRoute("POST", "/api/member/:name/evaluate", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.content) {
          return jsonResponse(res, 400, { ok: false, error: "content required" });
        }
        node_fs.mkdirSync(node_path.join(MEMBERS_DIR$1, params.name), { recursive: true });
        node_fs.appendFileSync(node_path.join(MEMBERS_DIR$1, params.name, "evaluations.md"), body.content + "\n", "utf-8");
        return jsonResponse(res, 200, { ok: true });
      }
      if (method === "POST" && url === "/api/shared/experience") {
        const body = await readBody(req);
        if (!body.member || !body.content) {
          return jsonResponse(res, 400, { ok: false, error: "member, content required" });
        }
        node_fs.mkdirSync(SHARED_DIR$1, { recursive: true });
        const scope = body.scope ?? "generic";
        if (scope === "team") {
          const pendingPath = node_path.join(SHARED_DIR$1, "pending_rules.json");
          let pending = [];
          try {
            pending = JSON.parse(node_fs.readFileSync(pendingPath, "utf-8"));
          } catch {
          }
          pending.push({
            id: `rule_${Date.now()}`,
            member: body.member,
            rule: body.content,
            reason: "",
            proposed_at: (/* @__PURE__ */ new Date()).toISOString()
          });
          node_fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");
          return jsonResponse(res, 200, { ok: true, data: { saved: true, similar_lines: [] } });
        }
        const expFile = scope === "project" && body.project ? node_path.join(SHARED_DIR$1, `experience_proj_${body.project}.md`) : node_path.join(SHARED_DIR$1, "experience_generic.md");
        node_fs.mkdirSync(SHARED_DIR$1, { recursive: true });
        const header = `
## [${body.member}] ${(/* @__PURE__ */ new Date()).toISOString()}
`;
        node_fs.appendFileSync(expFile, header + body.content + "\n", "utf-8");
        return jsonResponse(res, 200, { ok: true, data: { saved: true } });
      }
      if (method === "GET" && url.split("?")[0] === "/api/shared/experience") {
        const query = parseQuery(url);
        const scope = query.scope;
        const project = query.project;
        let content = "";
        if (!scope || scope === "generic") {
          content = safeReadFile(node_path.join(SHARED_DIR$1, "experience_generic.md"));
          if (project) {
            const projExp = safeReadFile(node_path.join(SHARED_DIR$1, `experience_proj_${project}.md`));
            if (projExp) content = [content, projExp].filter(Boolean).join("\n\n---\n\n");
          }
        } else if (scope === "project" && project) {
          content = safeReadFile(node_path.join(SHARED_DIR$1, `experience_proj_${project}.md`));
        }
        return jsonResponse(res, 200, { ok: true, data: content || null });
      }
      if (method === "GET" && url.split("?")[0] === "/api/shared/experience/search") {
        const query = parseQuery(url);
        if (!query.keyword) {
          return jsonResponse(res, 400, { ok: false, error: "keyword required" });
        }
        const files = [];
        if (node_fs.existsSync(SHARED_DIR$1)) {
          const allFiles = node_fs.readdirSync(SHARED_DIR$1).filter((f) => f.startsWith("experience_"));
          files.push(...allFiles.map((f) => node_path.join(SHARED_DIR$1, f)));
        }
        const lowerKw = query.keyword.toLowerCase();
        const hits = [];
        const seen = /* @__PURE__ */ new Set();
        for (const filePath of files) {
          const content = safeReadFile(filePath);
          if (!content) continue;
          const source = filePath.split("/").pop();
          for (const line of content.split("\n")) {
            if (line.toLowerCase().includes(lowerKw)) {
              const trimmed = line.trim();
              if (trimmed && !seen.has(trimmed)) {
                seen.add(trimmed);
                hits.push({ line: trimmed, source });
              }
            }
          }
        }
        return jsonResponse(res, 200, { ok: true, data: hits });
      }
      if (method === "GET" && url === "/api/shared/rules") {
        const content = safeReadFile(node_path.join(SHARED_DIR$1, "rules.md"));
        return jsonResponse(res, 200, { ok: true, data: content || null });
      }
      if (method === "POST" && url === "/api/shared/rules/propose") {
        const body = await readBody(req);
        if (!body.member || !body.rule) {
          return jsonResponse(res, 400, { ok: false, error: "member, rule required" });
        }
        node_fs.mkdirSync(SHARED_DIR$1, { recursive: true });
        const pendingPath = node_path.join(SHARED_DIR$1, "pending_rules.json");
        let pending = [];
        try {
          pending = JSON.parse(node_fs.readFileSync(pendingPath, "utf-8"));
        } catch {
        }
        const newRule = {
          id: `rule_${Date.now()}`,
          member: body.member,
          rule: body.rule,
          reason: body.reason ?? "",
          proposed_at: (/* @__PURE__ */ new Date()).toISOString()
        };
        pending.push(newRule);
        node_fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");
        return jsonResponse(res, 200, { ok: true, data: newRule });
      }
      if (method === "GET" && url === "/api/shared/rules/pending") {
        const pendingPath = node_path.join(SHARED_DIR$1, "pending_rules.json");
        let pending = [];
        try {
          pending = JSON.parse(node_fs.readFileSync(pendingPath, "utf-8"));
        } catch {
        }
        return jsonResponse(res, 200, { ok: true, data: pending });
      }
      if (method === "POST" && url === "/api/shared/rules/approve") {
        const body = await readBody(req);
        if (!body.id) return jsonResponse(res, 400, { ok: false, error: "id required" });
        node_fs.mkdirSync(SHARED_DIR$1, { recursive: true });
        const pendingPath = node_path.join(SHARED_DIR$1, "pending_rules.json");
        let pending = [];
        try {
          pending = JSON.parse(node_fs.readFileSync(pendingPath, "utf-8"));
        } catch {
        }
        const idx = pending.findIndex((r) => r.id === body.id);
        if (idx === -1) return jsonResponse(res, 404, { ok: false, error: "rule not found" });
        const [approved] = pending.splice(idx, 1);
        node_fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");
        const rulesPath = node_path.join(SHARED_DIR$1, "rules.md");
        node_fs.appendFileSync(rulesPath, `
- ${approved.rule} (by ${approved.member})
`, "utf-8");
        return jsonResponse(res, 200, { ok: true, data: approved });
      }
      if (method === "POST" && url === "/api/shared/rules/reject") {
        const body = await readBody(req);
        if (!body.id) return jsonResponse(res, 400, { ok: false, error: "id required" });
        const pendingPath = node_path.join(SHARED_DIR$1, "pending_rules.json");
        let pending = [];
        try {
          pending = JSON.parse(node_fs.readFileSync(pendingPath, "utf-8"));
        } catch {
        }
        const idx = pending.findIndex((r) => r.id === body.id);
        if (idx === -1) return jsonResponse(res, 404, { ok: false, error: "rule not found" });
        const [rejected] = pending.splice(idx, 1);
        node_fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");
        return jsonResponse(res, 200, { ok: true, data: rejected });
      }
      if (method === "GET" && url === "/api/shared/governance") {
        const content = readJsonFile(node_path.join(SHARED_DIR$1, "governance.json"));
        return jsonResponse(res, 200, { ok: true, data: content });
      }
      if (method === "GET" && url.split("?")[0] === "/api/members") {
        const profiles = listMembers(MEMBERS_DIR$1);
        const members = profiles.map((p) => {
          const s = getMemberStatus(p.name);
          return s ? {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status
          } : { ...p, status: "offline" };
        });
        return jsonResponse(res, 200, { ok: true, data: members });
      }
      if (method === "POST" && url === "/api/members") {
        const body = await readBody(req);
        if (!body.name || !body.role) {
          return jsonResponse(res, 400, { ok: false, error: "name, role are required" });
        }
        const existing = getMember(MEMBERS_DIR$1, body.name);
        if (existing) {
          return jsonResponse(res, 409, { ok: false, error: `member ${body.name} already exists` });
        }
        const profile = {
          uid: body.uid ?? crypto$1.randomUUID(),
          name: body.name,
          role: body.role,
          type: body.type ?? "temporary",
          joined_at: body.joined_at ?? (/* @__PURE__ */ new Date()).toISOString(),
          skills: body.skills,
          description: body.description
        };
        createMember(MEMBERS_DIR$1, profile);
        return jsonResponse(res, 201, { ok: true, data: profile });
      }
      if (method === "POST" && url === "/api/members/scan-orphan-locks") {
        const cleaned = scanOrphanLocks(MEMBERS_DIR$1);
        return jsonResponse(res, 200, { ok: true, data: cleaned });
      }
      if (method === "POST" && url.split("?")[0] === "/api/members/scan-stale-heartbeats") {
        const query = parseQuery(url);
        const timeoutMs = query.timeout_ms ? parseInt(query.timeout_ms, 10) : void 0;
        const stale = scanStaleHeartbeats(MEMBERS_DIR$1, timeoutMs);
        return jsonResponse(res, 200, { ok: true, data: stale });
      }
      params = matchRoute("GET", "/api/members/:name", method, url);
      if (params) {
        const s = getMemberStatus(params.name);
        if (!s) return jsonResponse(res, 404, { ok: false, error: "member not found" });
        return jsonResponse(res, 200, {
          ok: true,
          data: {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status
          }
        });
      }
      params = matchRoute("DELETE", "/api/members/:name", method, url);
      if (params) {
        const deleted = deleteMember(MEMBERS_DIR$1, params.name);
        if (!deleted) return jsonResponse(res, 404, { ok: false, error: "member not found" });
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/members/:name/lock", method, url);
      if (params) {
        const lock = readLock(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true, data: lock });
      }
      params = matchRoute("POST", "/api/members/:name/lock/acquire", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "session_pid, session_start, project, task required" });
        }
        const result = acquireLock(MEMBERS_DIR$1, params.name, body.session_pid, body.session_start, body.project, body.task);
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, nonce: result.nonce, error: result.error });
      }
      params = matchRoute("POST", "/api/members/:name/lock/release", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.nonce) return jsonResponse(res, 400, { ok: false, error: "nonce required" });
        const result = releaseLock(MEMBERS_DIR$1, params.name, body.nonce);
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error });
      }
      params = matchRoute("POST", "/api/members/:name/lock/force-release", method, url);
      if (params) {
        const result = forceReleaseLock(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, result.success ? 200 : 404, { ok: result.success, error: result.error });
      }
      params = matchRoute("POST", "/api/members/:name/lock/update", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.nonce || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "nonce, project, task required" });
        }
        const result = updateLock(MEMBERS_DIR$1, params.name, body.nonce, body.project, body.task);
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error });
      }
      params = matchRoute("POST", "/api/members/:name/lock/takeover", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "session_pid, session_start, project, task required" });
        }
        const result = takeoverLock(MEMBERS_DIR$1, params.name, body.session_pid, body.session_start, body.project, body.task);
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, nonce: result.nonce, error: result.error });
      }
      params = matchRoute("POST", "/api/members/:name/heartbeat", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.session_pid || !body.last_tool) {
          return jsonResponse(res, 400, { ok: false, error: "session_pid, last_tool required" });
        }
        touchHeartbeat(MEMBERS_DIR$1, params.name, body.session_pid, body.last_tool);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/members/:name/heartbeat", method, url);
      if (params) {
        const hb = readHeartbeat(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true, data: hb });
      }
      params = matchRoute("DELETE", "/api/members/:name/heartbeat", method, url);
      if (params) {
        removeHeartbeat(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/members/:name/reservation", method, url);
      if (params) {
        const reservation = readReservation(MEMBERS_DIR$1, params.name);
        if (reservation && Date.now() - reservation.created_at > reservation.ttl_ms) {
          deleteReservation(MEMBERS_DIR$1, params.name);
          return jsonResponse(res, 200, { ok: true, data: null });
        }
        return jsonResponse(res, 200, { ok: true, data: reservation });
      }
      params = matchRoute("POST", "/api/members/:name/reservation", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.code || !body.caller || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: "code, caller, project, task required" });
        }
        const reservation = {
          code: body.code,
          member: body.member ?? params.name,
          session_id: body.session_id ?? "",
          caller: body.caller,
          project: body.project,
          task: body.task,
          created_at: body.created_at ?? Date.now(),
          ttl_ms: body.ttl_ms ?? 21e4
        };
        writeReservation(MEMBERS_DIR$1, params.name, reservation);
        return jsonResponse(res, 200, { ok: true, data: reservation });
      }
      params = matchRoute("DELETE", "/api/members/:name/reservation", method, url);
      if (params) {
        deleteReservation(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/members/:name/memory", method, url);
      if (params) {
        const query = parseQuery(url);
        const memScope = query.scope === "project" ? "project" : query.scope === "generic" ? "generic" : void 0;
        const content = readMemory(MEMBERS_DIR$1, params.name, memScope, query.project);
        return jsonResponse(res, 200, { ok: true, data: content || null });
      }
      params = matchRoute("POST", "/api/members/:name/memory", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.content) {
          return jsonResponse(res, 400, { ok: false, error: "content required" });
        }
        const scope = body.scope === "project" ? "project" : "generic";
        saveMemory(MEMBERS_DIR$1, params.name, scope, body.content, body.project);
        return jsonResponse(res, 200, { ok: true });
      }
      params = matchRoute("GET", "/api/members/:name/persona", method, url);
      if (params) {
        const content = readPersona(MEMBERS_DIR$1, params.name);
        return jsonResponse(res, 200, { ok: true, data: content || null });
      }
      params = matchRoute("GET", "/api/members/:name/worklog", method, url);
      if (params) {
        const query = parseQuery(url);
        const limit = query.limit ? parseInt(query.limit, 10) : void 0;
        const entries = readWorkLog(MEMBERS_DIR$1, params.name, limit);
        return jsonResponse(res, 200, { ok: true, data: entries });
      }
      params = matchRoute("POST", "/api/members/:name/worklog", method, url);
      if (params) {
        const body = await readBody(req);
        if (!body.event || !body.timestamp || !body.project) {
          return jsonResponse(res, 400, { ok: false, error: "event, timestamp, project required" });
        }
        appendWorkLog(MEMBERS_DIR$1, params.name, body);
        return jsonResponse(res, 200, { ok: true });
      }
      if (method === "POST" && url === "/api/vault/proxy") {
        const body = await readBody(req);
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: "session_id is required" });
        }
        const session = getSessionByMemberId(body.session_id);
        if (!session) {
          return jsonResponse(res, 401, { error: "invalid session_id" });
        }
        if (!body.api_name || !body.url || !body.method) {
          return jsonResponse(res, 400, { error: "api_name, url, method are required" });
        }
        const proxyResult = await proxyApiRequest({
          api_name: body.api_name,
          url: body.url,
          method: body.method,
          headers: body.headers,
          body: body.body
        });
        if ("error" in proxyResult) {
          return jsonResponse(res, 400, proxyResult);
        }
        const responseBody = JSON.stringify({
          status: proxyResult.status,
          headers: proxyResult.headers,
          body: proxyResult.body
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(responseBody)
        });
        res.end(responseBody);
      }
      if (method === "GET" && url === "/api/vault/list") {
        const query = parseQuery(url);
        const sessionId = query.session_id;
        if (!sessionId) {
          return jsonResponse(res, 400, { error: "session_id query param is required" });
        }
        const session = getSessionByMemberId(sessionId);
        if (!session) {
          return jsonResponse(res, 401, { error: "invalid session_id" });
        }
        const keys = listApiKeys();
        return jsonResponse(res, 200, { keys });
      }
      if (method === "POST" && url === "/api/vault/add") {
        const body = await readBody(req);
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: "session_id is required" });
        }
        const session = getSessionByMemberId(body.session_id);
        if (!session) {
          return jsonResponse(res, 401, { error: "invalid session_id" });
        }
        if (!body.api_name || !body.value) {
          return jsonResponse(res, 400, { error: "api_name and value are required" });
        }
        const success = addApiKey(body.api_name, body.value);
        if (!success) {
          return jsonResponse(res, 500, { error: "failed to add key" });
        }
        return jsonResponse(res, 200, { success: true, message: `Key for ${body.api_name} added` });
      }
      if (method === "DELETE" && url.split("?")[0] === "/api/vault/remove") {
        const body = await readBody(req);
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: "session_id is required" });
        }
        const session = getSessionByMemberId(body.session_id);
        if (!session) {
          return jsonResponse(res, 401, { error: "invalid session_id" });
        }
        if (!body.api_name) {
          return jsonResponse(res, 400, { error: "api_name is required" });
        }
        const success = removeApiKey(body.api_name);
        if (!success) {
          return jsonResponse(res, 500, { error: "failed to remove key" });
        }
        return jsonResponse(res, 200, { success: true, message: `Key for ${body.api_name} removed` });
      }
      if (method === "POST" && url === "/api/ask-user") {
        const body = await readBody(req);
        if (!body.member_name || !body.type || !body.title || !body.question) {
          return jsonResponse(res, 400, { error: "member_name, type, title, question are required" });
        }
        const validTypes = ["confirm", "single_choice", "multi_choice", "input"];
        if (!validTypes.includes(body.type)) {
          return jsonResponse(res, 400, { error: `type must be one of: ${validTypes.join(", ")}` });
        }
        if ((body.type === "single_choice" || body.type === "multi_choice") && (!body.options || body.options.length === 0)) {
          return jsonResponse(res, 400, { error: "options are required for single_choice/multi_choice types" });
        }
        const response = await createAskUserRequest({
          member_name: body.member_name,
          type: body.type,
          title: body.title,
          question: body.question,
          options: body.options,
          timeout_ms: body.timeout_ms
        });
        return jsonResponse(res, 200, response);
      }
      return jsonResponse(res, 404, { error: "not found" });
    } catch (err) {
      return jsonResponse(res, 500, { error: String(err) });
    }
  });
  panelServer.listen(0, PANEL_HOST, () => {
    const addr = panelServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      node_fs.writeFileSync(PANEL_PORT_FILE, String(port), "utf-8");
    } catch {
    }
    process.stderr.write(`[panel-api] started on ${PANEL_HOST}:${port}
`);
  });
}
function stopPanelApi() {
  if (panelServer) {
    panelServer.close();
    panelServer = null;
  }
  try {
    node_fs.rmSync(PANEL_PORT_FILE, { force: true });
  } catch {
  }
}
const TEAM_HUB_DIR = path.resolve(os.homedir(), ".claude/team-hub");
const SESSIONS_DIR = path.join(TEAM_HUB_DIR, "sessions");
const MEMBERS_DIR = path.join(TEAM_HUB_DIR, "members");
const SHARED_DIR = path.join(TEAM_HUB_DIR, "shared");
const PROJECTS_DIR = path.join(SHARED_DIR, "projects");
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
    const sessions2 = [];
    for (const line of output.split("\n")) {
      if (!/\bclaude\b/.test(line) || /Helper|agent|electron|node /i.test(line)) continue;
      const match = line.trim().match(/^(\d+)\s+(.+?\d{4})\s+(.+)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      const lstart = match[2].trim();
      const cmd = match[3].trim();
      if (!cmd.includes("claude")) continue;
      sessions2.push({ pid, lstart, cwd: "", started_at: "" });
    }
    return sessions2;
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
    for (const memberDir2 of memberDirs) {
      const profilePath = path.join(MEMBERS_DIR, memberDir2, "profile.json");
      const lockPath = path.join(MEMBERS_DIR, memberDir2, "lock.json");
      const heartbeatPath = path.join(MEMBERS_DIR, memberDir2, "heartbeat.json");
      const profile = readJson(profilePath);
      if (!profile) continue;
      const lock = readJson(lockPath);
      const heartbeat = readJson(heartbeatPath);
      const reservationPath = path.join(MEMBERS_DIR, memberDir2, "reservation.json");
      let reservation = readJson(reservationPath);
      const hasReservation = reservation !== null && Date.now() - reservation.created_at <= reservation.ttl_ms;
      let status;
      if (lock) {
        status = "working";
      } else {
        const ptySession = getPtySessions().find((s) => s.memberId === memberDir2 && s.status === "running");
        if (ptySession) {
          status = "working";
        } else if (hasReservation) {
          status = "reserved";
        } else {
          status = "offline";
        }
      }
      members.push({
        uid: profile.uid ?? memberDir2,
        name: profile.name,
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
  for (const memberDir2 of memberDirs) {
    const lockPath = path.join(MEMBERS_DIR, memberDir2, "lock.json");
    path.join(MEMBERS_DIR, memberDir2, "heartbeat.json");
    const lock = readJson(lockPath);
    if (!lock) continue;
    if (!isPidAlive(lock.session_pid)) {
      continue;
    }
    const lstart = getPidLstart(lock.session_pid);
    if (lstart && lstart !== lock.session_start) {
      continue;
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
    if (process.env.E2E_HEADLESS !== "1") mainWindow?.show();
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
  const ptyActive = getPtySessions().some((s) => s.status === "running");
  if (status.sessions.length === 0 && !ptyActive) {
    if (!autoQuitTimer) {
      autoQuitTimer = setTimeout(() => {
        const check = scanTeamStatus();
        const ptyStillActive = getPtySessions().some((s) => s.status === "running");
        if (check.sessions.length === 0 && !ptyStillActive) {
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
let watcherDebounce = null;
function startWatcher() {
  if (watcher) return;
  if (!fs.existsSync(TEAM_HUB_DIR)) return;
  watcher = chokidar.watch(TEAM_HUB_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3
  });
  watcher.on("all", () => {
    if (watcherDebounce) clearTimeout(watcherDebounce);
    watcherDebounce = setTimeout(() => {
      watcherDebounce = null;
      pushStatus();
    }, 300);
  });
  watcher.on("error", (err) => {
    process.stderr?.write?.(`[watcher] error: ${err}
`);
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
              name: profile?.name ?? dir,
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
  const memberDir2 = path.join(MEMBERS_DIR, memberName);
  if (!fs.existsSync(memberDir2)) return null;
  const profile = readJson(path.join(memberDir2, "profile.json"));
  if (!profile) return null;
  let persona = null;
  const personaPath = path.join(memberDir2, "persona.md");
  if (fs.existsSync(personaPath)) {
    try {
      persona = fs.readFileSync(personaPath, "utf-8");
    } catch {
    }
  }
  let memory = null;
  const memoryPath = path.join(memberDir2, "memory_generic.md");
  if (fs.existsSync(memoryPath)) {
    try {
      memory = fs.readFileSync(memoryPath, "utf-8");
    } catch {
    }
  }
  const workLog = [];
  const logPath = path.join(memberDir2, "work_log.jsonl");
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
  const lock = readJson(path.join(memberDir2, "lock.json"));
  const heartbeat = readJson(path.join(memberDir2, "heartbeat.json"));
  const reservationPath2 = path.join(memberDir2, "reservation.json");
  const reservation2 = readJson(reservationPath2);
  const hasReservation = reservation2 !== null && Date.now() - reservation2.created_at <= reservation2.ttl_ms;
  let status;
  if (lock) {
    status = "working";
  } else {
    const ptySession = getPtySessions().find((s) => s.memberId === memberName && s.status === "running");
    if (ptySession) {
      status = "working";
    } else if (hasReservation) {
      status = "reserved";
    } else {
      status = "offline";
    }
  }
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
let messageRouter = null;
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
    const memberDir2 = path.join(MEMBERS_DIR, memberName);
    const mcpsPath = path.join(memberDir2, "mcps.json");
    if (!fs.existsSync(memberDir2)) return { ok: false, reason: "成员不存在" };
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
  electron.ipcMain.handle("spawn-pty-session", (_event, opts) => {
    return spawnPtySession(opts);
  });
  electron.ipcMain.handle("write-to-pty", (_event, sessionId, data) => {
    return writeToPty(sessionId, data);
  });
  electron.ipcMain.handle("resize-pty", (_event, sessionId, cols, rows) => {
    return resizePty(sessionId, cols, rows);
  });
  electron.ipcMain.handle("kill-pty-session", (_event, sessionId) => {
    return killPtySession(sessionId);
  });
  electron.ipcMain.handle("get-pty-sessions", () => {
    return getPtySessions();
  });
  electron.ipcMain.handle("get-pty-session", (_event, sessionId) => {
    return getPtySession(sessionId);
  });
  electron.ipcMain.handle("get-pty-buffer", (_event, sessionId) => {
    return getPtyBuffer(sessionId);
  });
  electron.ipcMain.handle("attach-pty-window", (event, sessionId) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: "no window" };
    return attachWindow(sessionId, win);
  });
  electron.ipcMain.handle("scan-agent-clis", (_event, force) => {
    return scanAgentClis(force);
  });
  electron.ipcMain.handle("select-directory", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    const result = await electron.dialog.showOpenDialog(win ?? electron.BrowserWindow.getFocusedWindow(), {
      properties: ["openDirectory"],
      title: "选择工作目录",
      buttonLabel: "选择"
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null };
    }
    return { canceled: false, path: result.filePaths[0] };
  });
  electron.ipcMain.handle("launch-member", (_event, opts) => {
    return openTerminalWindow(opts);
  });
  electron.ipcMain.handle("get-theme", () => {
    return electron.nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });
  messageRouter = setupMessageRouter();
  setMessageRouter(messageRouter);
  electron.ipcMain.handle("send-message", (_event, from, to, content, priority) => {
    if (!messageRouter) return { ok: false, reason: "router not ready" };
    const result = messageRouter.sendMessage(from, to, content, priority);
    if (result.error) return { ok: false, reason: result.error };
    return { ok: true, id: result.id, delivered: result.delivered };
  });
  electron.ipcMain.handle("get-inbox", (_event, memberId) => {
    if (!messageRouter) return [];
    return messageRouter.getInbox(memberId);
  });
  electron.ipcMain.handle("clear-inbox", (_event, memberId) => {
    if (!messageRouter) return;
    messageRouter.clearInbox(memberId);
  });
  electron.nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("theme-change", electron.nativeTheme.shouldUseDarkColors ? "dark" : "light");
    }
  });
}
async function ensureHub() {
  const HUB_DIR = path.join(os.homedir(), ".claude", "team-hub");
  path.join(HUB_DIR, "hub.pid");
  const portFile = path.join(HUB_DIR, "hub.port");
  const defaultPort = 58578;
  function getPort() {
    try {
      const p = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
      return isNaN(p) ? defaultPort : p;
    } catch {
      return defaultPort;
    }
  }
  async function isHealthy(port2) {
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/health`, { signal: AbortSignal.timeout(2e3) });
      return res.ok;
    } catch {
      return false;
    }
  }
  const port = getPort();
  if (await isHealthy(port)) {
    console.log(`[panel] Hub already running on port ${port}`);
    return;
  }
  const hubScript = path.join(__dirname, "../../../mcp-server/src/hub.ts");
  if (!fs.existsSync(hubScript)) {
    console.warn(`[panel] Hub script not found: ${hubScript}`);
    return;
  }
  let bunBin = "bun";
  try {
    bunBin = child_process.execSync("which bun", { encoding: "utf-8", timeout: 3e3 }).trim() || bunBin;
  } catch {
  }
  fs.mkdirSync(HUB_DIR, { recursive: true });
  const logFile = path.join(HUB_DIR, "hub.log");
  const logFd = fs.openSync(logFile, "a");
  const child = child_process.spawn(bunBin, ["run", hubScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
    cwd: path.dirname(hubScript)
  });
  child.unref();
  fs.closeSync(logFd);
  let ready = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isHealthy(getPort())) {
      ready = true;
      break;
    }
  }
  if (ready) {
    console.log(`[panel] Hub started successfully`);
  } else {
    console.warn(`[panel] Hub startup timeout, check ${logFile}`);
  }
}
electron.app.name = "MCP-Team-Hub";
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
  electron.app.whenReady().then(async () => {
    await ensureHub();
    try {
      const STALE_HEARTBEAT_MS = 3 * 60 * 1e3;
      const memberDirs = fs.readdirSync(MEMBERS_DIR).filter((d) => {
        try {
          return fs.statSync(path.join(MEMBERS_DIR, d)).isDirectory();
        } catch {
          return false;
        }
      });
      for (const dir of memberDirs) {
        let cleaned = false;
        const lockPath = path.join(MEMBERS_DIR, dir, "lock.json");
        if (fs.existsSync(lockPath)) {
          try {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
            const pid = lock.session_pid;
            if (pid) {
              const alive = isPidAlive(pid) && getPidLstart(pid) === lock.session_start;
              if (!alive) {
                fs.rmSync(lockPath, { force: true });
                cleaned = true;
              }
            } else {
              fs.rmSync(lockPath, { force: true });
              cleaned = true;
            }
          } catch {
            fs.rmSync(lockPath, { force: true });
            cleaned = true;
          }
        }
        const hbPath = path.join(MEMBERS_DIR, dir, "heartbeat.json");
        if (fs.existsSync(hbPath)) {
          try {
            const hb = JSON.parse(fs.readFileSync(hbPath, "utf-8"));
            const pid = hb.session_pid;
            const pidDead = pid ? !isPidAlive(pid) : true;
            const timedOut = hb.last_seen_ms ? Date.now() - hb.last_seen_ms > STALE_HEARTBEAT_MS : true;
            if (pidDead || timedOut) {
              fs.rmSync(hbPath, { force: true });
              cleaned = true;
            }
          } catch {
            fs.rmSync(hbPath, { force: true });
            cleaned = true;
          }
        }
        if (cleaned) {
          const resPath = path.join(MEMBERS_DIR, dir, "reservation.json");
          try {
            fs.rmSync(resPath, { force: true });
          } catch {
          }
        }
      }
    } catch {
    }
    setupIpc();
    setupTerminalIpc();
    setupAskUserIpc();
    startPanelApi();
    createWindow();
    createOverlay();
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
    try {
      const memberDirs = fs.readdirSync(MEMBERS_DIR).filter((d) => {
        try {
          return fs.statSync(path.join(MEMBERS_DIR, d)).isDirectory();
        } catch {
          return false;
        }
      });
      for (const dir of memberDirs) {
        const lockPath = path.join(MEMBERS_DIR, dir, "lock.json");
        const hbPath = path.join(MEMBERS_DIR, dir, "heartbeat.json");
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
        }
        try {
          fs.rmSync(hbPath, { force: true });
        } catch {
        }
      }
    } catch {
    }
    teardownMessageRouter();
    stopPanelApi();
    killAllPtySessions();
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
