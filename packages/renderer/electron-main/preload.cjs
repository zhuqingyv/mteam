// Preload：当前无需暴露 API，保留占位以便后续通过 contextBridge 注入。
// 用 .cjs 显式告诉 Electron 走 CommonJS，避免和 renderer 的 ESM 冲突。
