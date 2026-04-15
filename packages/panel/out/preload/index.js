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
