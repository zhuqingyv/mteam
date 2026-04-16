"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("teamHub", {
  onStatusUpdate: (callback) => {
    electron.ipcRenderer.on("status-update", (_event, status) => callback(status));
    return () => {
      electron.ipcRenderer.removeAllListeners("status-update");
    };
  },
  getInitialStatus: () => {
    return electron.ipcRenderer.invoke("get-initial-status");
  },
  getMemberDetail: (memberName) => {
    return electron.ipcRenderer.invoke("get-member-detail", memberName);
  },
  getMcpStore: () => {
    return electron.ipcRenderer.invoke("get-mcp-store");
  },
  getRegistry: (query) => {
    return electron.ipcRenderer.invoke("get-registry", query);
  },
  installStoreMcp: (item) => {
    return electron.ipcRenderer.invoke("install-store-mcp", item);
  },
  uninstallStoreMcp: (name) => {
    return electron.ipcRenderer.invoke("uninstall-store-mcp", name);
  },
  mountMemberMcp: (memberName, mcpName) => {
    return electron.ipcRenderer.invoke("mount-member-mcp", memberName, mcpName);
  },
  unmountMemberMcp: (memberName, mcpName) => {
    return electron.ipcRenderer.invoke("unmount-member-mcp", memberName, mcpName);
  },
  getMemberMcps: (memberName) => {
    return electron.ipcRenderer.invoke("get-member-mcps", memberName);
  },
  listProjects: () => electron.ipcRenderer.invoke("list-projects"),
  getProject: (id) => electron.ipcRenderer.invoke("get-project", id),
  createProject: (data) => electron.ipcRenderer.invoke("create-project", data),
  updateProject: (id, patch) => electron.ipcRenderer.invoke("update-project", id, patch),
  deleteProject: (id) => electron.ipcRenderer.invoke("delete-project", id),
  getMemberProjects: (memberName) => electron.ipcRenderer.invoke("get-member-projects", memberName),
  getTheme: () => {
    return electron.ipcRenderer.invoke("get-theme");
  },
  onThemeChange: (callback) => {
    electron.ipcRenderer.on("theme-change", (_event, theme) => callback(theme));
    return () => {
      electron.ipcRenderer.removeAllListeners("theme-change");
    };
  }
});
electron.contextBridge.exposeInMainWorld("api", {
  scanAgentClis: (force) => {
    return electron.ipcRenderer.invoke("scan-agent-clis", force);
  },
  selectDirectory: () => {
    return electron.ipcRenderer.invoke("select-directory");
  },
  launchMember: (opts) => {
    return electron.ipcRenderer.invoke("launch-member", opts);
  },
  trustWorkspace: (workspacePath) => {
    return electron.ipcRenderer.invoke("trust-workspace", workspacePath);
  }
});
electron.contextBridge.exposeInMainWorld("ptyBridge", {
  // Session lifecycle
  spawn: (opts) => {
    return electron.ipcRenderer.invoke("spawn-pty-session", opts);
  },
  write: (sessionId, data) => {
    return electron.ipcRenderer.invoke("write-to-pty", sessionId, data);
  },
  resize: (sessionId, cols, rows) => {
    return electron.ipcRenderer.invoke("resize-pty", sessionId, cols, rows);
  },
  kill: (sessionId) => {
    return electron.ipcRenderer.invoke("kill-pty-session", sessionId);
  },
  // Query
  list: () => {
    return electron.ipcRenderer.invoke("get-pty-sessions");
  },
  get: (sessionId) => {
    return electron.ipcRenderer.invoke("get-pty-session", sessionId);
  },
  getBuffer: (sessionId) => {
    return electron.ipcRenderer.invoke("get-pty-buffer", sessionId);
  },
  // Window binding — binds this window to receive pty-output/pty-exit for this session
  attach: (sessionId) => {
    return electron.ipcRenderer.invoke("attach-pty-window", sessionId);
  },
  // Events from main process
  onOutput: (callback) => {
    const handler = (_event, sessionId, data) => callback(sessionId, data);
    electron.ipcRenderer.on("pty-output", handler);
    return () => {
      electron.ipcRenderer.removeListener("pty-output", handler);
    };
  },
  onExit: (callback) => {
    const handler = (_event, sessionId, exitCode) => callback(sessionId, exitCode);
    electron.ipcRenderer.on("pty-exit", handler);
    return () => {
      electron.ipcRenderer.removeListener("pty-exit", handler);
    };
  }
});
