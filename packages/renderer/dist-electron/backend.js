var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// electron-main/backend.ts
var exports_backend = {};
__export(exports_backend, {
  stopBackendAndWait: () => stopBackendAndWait,
  stopBackend: () => stopBackend,
  startBackend: () => startBackend
});
module.exports = __toCommonJS(exports_backend);
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
var import_node_url = require("node:url");
var __dirname2 = import_node_path.dirname(import_node_url.fileURLToPath("file:///Users/zhuqingyu/project/mcp-team-hub/packages/renderer/electron-main/backend.ts"));
var BACKEND_ENTRY = import_node_path.resolve(__dirname2, "..", "..", "backend", "src", "http", "server.ts");
var KILL_GRACE_MS = 2000;
var STOP_WAIT_MS = 4000;
var child = null;
function startBackend() {
  if (child && child.exitCode === null)
    return child;
  child = import_node_child_process.spawn("bun", ["run", BACKEND_ENTRY], {
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env }
  });
  child.on("exit", (code, signal) => {
    process.stderr.write(`[electron] backend exited code=${code} signal=${signal}
`);
    child = null;
  });
  return child;
}
function stopBackend() {
  if (!child || typeof child.pid !== "number")
    return;
  const pid = child.pid;
  child = null;
  const kill = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref?.();
}
async function stopBackendAndWait() {
  if (!child || typeof child.pid !== "number")
    return;
  const c = child;
  const pid = c.pid;
  child = null;
  const kill = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  const exited = new Promise((resolve2) => {
    if (c.exitCode !== null || c.signalCode) {
      resolve2();
      return;
    }
    c.once("exit", () => resolve2());
  });
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
  await Promise.race([
    exited,
    new Promise((r) => setTimeout(r, STOP_WAIT_MS))
  ]);
  clearTimeout(timer);
}
