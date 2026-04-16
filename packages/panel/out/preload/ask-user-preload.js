"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("askUserBridge", {
  // Main → Renderer: receive request data
  onShowRequest: (cb) => {
    electron.ipcRenderer.on("show-ask-user", (_event, request) => cb(request));
  },
  // Renderer → Main: get request data (fallback if show-ask-user fired before renderer ready)
  getRequest: () => {
    return electron.ipcRenderer.invoke("ask-user-get-request");
  },
  // Renderer → Main: submit answer
  submitResponse: (requestId, response) => {
    electron.ipcRenderer.send("ask-user-response", requestId, response);
  },
  // Renderer → Main: cancel
  cancel: (requestId) => {
    electron.ipcRenderer.send("ask-user-cancel", requestId);
  }
});
