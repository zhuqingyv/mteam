"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("terminalBridge", {
  // Main → renderer: PTY output
  onPtyOutput: (cb) => {
    electron.ipcRenderer.on("pty-output", (_event, data) => cb(data));
  },
  // Renderer → main: keyboard input
  sendInput: (data) => {
    electron.ipcRenderer.send("terminal-input", data);
  },
  // Renderer → main: terminal ready + initial dimensions
  notifyReady: (cols, rows) => {
    electron.ipcRenderer.send("terminal-ready", cols, rows);
  },
  // Renderer → main: dimensions changed
  notifyResize: (cols, rows) => {
    electron.ipcRenderer.send("terminal-resize", cols, rows);
  },
  // Get member color [R, G, B] for liquid border
  getMemberColor: () => {
    return electron.ipcRenderer.invoke("get-member-color");
  },
  // Get member name for titlebar
  getMemberName: () => {
    return electron.ipcRenderer.invoke("get-member-name");
  },
  // Close this terminal window
  closeWindow: () => {
    electron.ipcRenderer.send("close-terminal-window");
  }
});
