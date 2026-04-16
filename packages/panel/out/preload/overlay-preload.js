"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("overlayBridge", {
  onWindowPositions: (cb) => {
    electron.ipcRenderer.on("window-positions", (_e, positions) => cb(positions));
  },
  onMessageEvents: (cb) => {
    electron.ipcRenderer.on("message-events", (_e, messages) => cb(messages));
  }
});
