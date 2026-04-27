# Window Lifecycle Audit Report (Corrected)
**Date:** 2026-04-26 | **Auditor:** plan-lifecycle | **Project:** mcp-team-hub/packages/renderer

> **Corrected after reading CAPSULE-INTERACTION-SPEC.md + INTERACTION-DESIGN.md**
> Architecture is dual independent BrowserWindow, not single window. Multi-screen bug already fixed (id:681).

---

## Architecture Overview

**3 independent Electron BrowserWindow instances** sharing same renderer bundle:

| Window | Size | Route | Role |
|--------|------|-------|------|
| **Main (CapsuleWindow)** | 380×120 → 640×620 | `/` | CapsulePage (Logo + Chat) |
| **Team Panel** | 1200×800 | `?window=team` | TeamPage (Canvas + Sidebar) |
| **Settings** | 600×500 | `?window=settings` | SettingsPage |

---

## 1. Main Window (CapsuleWindow)

### Overview
- **Lifecycle:** Created on app ready, persists until app quit
- **Spec:** [CAPSULE-INTERACTION-SPEC.md](./CAPSULE-INTERACTION-SPEC.md) (authority)
- **Key refs:** mnemo id:681 (multi-screen fix), id:584 (batch render fix)

### Lifecycle Table

| Phase | Current Behavior | Status | Issues | Evidence |
|-------|------------------|--------|--------|----------|
| **Creation** | `createWindow()` on app.whenReady(); positions bottom-right per display detected | ✅ OK | ~~Multi-screen hard-code~~ **Fixed by id:681** — now uses `getDisplayMatching()` | `main.ts:47-59` |
| **Position Calculation** | Uses `screen.getDisplayMatching({x,y,w,h})` to find matching display; clamps to that display's workArea | ✅ FIXED | Was hard-coded to primary display. **Fix deployed (id:681)** | `main.ts:113-116` |
| **Initial Size** | 380×120 capsule | ✅ OK | None | `main.ts:51-52, useCapsuleToggle.ts:4` |
| **Transparency** | `frame: false`, `hasShadow: false`, `transparent: true`, `backgroundColor: '#00000000'` | ✅ OK | Glass-morphism frameless window works | `main.ts:24-27` |
| **Resizable** | `resizable: true` | ✅ OK | User can resize via handle in UI | `main.ts:28` |
| **Preload** | `contextIsolation: true`, `nodeIntegration: false`, preload.cjs exposes `electronAPI` | ✅ OK | Security-first approach; API isolated via context bridge | `main.ts:31-33, preload.cjs:1-15` |
| **Opening** | Created once on app ready; never closed/reopened | ✅ OK | None | `main.ts:128` |
| **Expand Animation** | `useCapsuleToggle()`: 1) send resize IPC + set animating=true 2) resize happens (350ms anim) 3) body fade-in (200ms) 4) animating=false | ✅ OK | Smooth two-phase: size→content | `useCapsuleToggle.ts:43-45` |
| **Collapse Animation** | 1) body fade-out (200ms) 2) resize (350ms) 3) toggle expanded=false 4) animating=false | ✅ OK | Three-phase: content→size | `useCapsuleToggle.ts:49-54` |
| **Drag Region** | DragHandle component has `-webkit-app-region: drag`; rest is `no-drag` | ✅ OK | Only pill-shaped drag region, rest clickable | `DragHandle.tsx:12, DragHandle.css:5, PanelWindow.css:7` |
| **Resize Drag (Manual)** | `window:start-resize` IPC triggers `mainWindow.startResizing?(direction)` with 8 directional handles; `window:resize` clamps to current display workarea | ⚠️ PARTIAL | Works but dragging from panel window (expanded) not yet tested; clamp logic uses `screen.getDisplayMatching({x,y,w,h})` (fixed in v681) | `main.ts:94-100, 102-121` |
| **Resize Bounds** | No explicit min/max size constraints set | ❌ GAP | User can resize to 0px or huge; should enforce min(300×100) and max constraints | `main.ts:82 (baseGlassOptions has no minWidth/maxHeight)` |
| **On('closed')** | `mainWindow = null` | ✅ OK | Proper cleanup | `main.ts:59` |
| **On('focus')/On('blur')** | Not implemented | ⚠️ GAP | Could use for visual feedback or dismissing panels, but not critical | None |
| **On('moved')/On('resized')** | Not implemented | ⚠️ GAP | No tracking of window bounds changes; useful for persisting position but not required | None |
| **Close Behavior** | Only closes via app quit; X button disabled (frameless) | ✅ OK | Single-instance app, always available | `main.ts:frame:false` |
| **All Windows Closed** | `app.on('window-all-closed')` stops backend and quits (non-macOS) | ✅ OK | Proper lifecycle | `main.ts:134-137` |

---

## 2. Settings Window

### Overview
- **Created by:** `openPanel('settings')` triggered by gear icon in ExpandedView
- **Lifecycle:** Toggle (open/close), non-persistent, single instance
- **Query param:** `?window=settings`
- **Size:** 600×500

### Lifecycle Table

| Phase | Current Behavior | Status | Issues | Evidence |
|-------|------------------|--------|--------|----------|
| **Creation** | New BrowserWindow with same glass options; initial size 600×500; no explicit position set (Electron defaults to center) | ⚠️ PARTIAL | Window appears but no guaranteed position relative to main window or screen | `main.ts:82-83` |
| **Position Calc** | None — uses Electron default centering | ❌ GAP | **Issue #2:** Should position relative to main window (e.g., to the right or centered on screen). No multi-screen awareness | `main.ts:82` |
| **Transparency** | Inherits from `baseGlassOptions`: frameless, glass-morphism | ✅ OK | Matches main window aesthetic | `main.ts:23-35` |
| **Resizable** | `resizable: true` | ✅ OK | User can resize | `main.ts:28` |
| **Preload** | Same as main window | ✅ OK | Security isolated | `main.ts:33` |
| **Opening (IPC)** | `ipcMain.on('window:open-settings')` → `openPanel('settings')` | ✅ OK | Triggered from SettingsPage gear button via `window.electronAPI.openSettings()` | `main.ts:88, preload.cjs:14, ExpandedView.tsx` |
| **If Already Open** | `cfg.ref.close()` — toggle behavior | ✅ OK | Closing settings when already open is sensible | `main.ts:77` |
| **Drag Region** | PanelWindow has DragHandle with `-webkit-app-region: drag` | ✅ OK | Same as other panels | `PanelWindow.tsx:12` |
| **Resizing** | Can resize but no bounds; no manual drag resize handles in UI | ⚠️ PARTIAL | Standard Electron resize works; no custom constraints | `main.ts:28` |
| **Close Button** | SettingsPage renders X button calling `window.close()` | ✅ OK | Proper close | `SettingsPage.tsx:41-42` |
| **On('closed')** | `settingsWindow = null` | ✅ OK | Cleanup | `main.ts:85` |
| **On('focus')/On('blur')** | Not implemented | ⚠️ GAP | Could be used for focus management | None |
| **Persistence** | Window destroyed on close; state lost; next open is fresh | ✅ OK | Settings read from backend API, no UI state lost | `SettingsPage.tsx:27-29` |

---

## 3. Team Panel Window

### Overview
- **Created by:** `openPanel('team')` triggered manually OR auto-triggered by `team.created` WS event
- **Lifecycle:** Toggle/focus-on-top, single instance, debounced (500ms)
- **Query param:** `?window=team`
- **Size:** 1200×800

### Lifecycle Table

| Phase | Current Behavior | Status | Issues | Evidence |
|-------|------------------|--------|--------|----------|
| **Creation** | New BrowserWindow with glass options; size 1200×800; no explicit position (centered by Electron) | ⚠️ PARTIAL | Window appears but no guaranteed position. Should appear next to main window or on same screen | `main.ts:82` |
| **Auto-Open Trigger** | WS `team.created` event → debounced `openPanel('team')` with 500ms window | ⚠️ PARTIAL | Debounce implemented but auto-open UX not yet confirmed in production. Waits 500ms before allowing next open | `main.ts:63-74` |
| **If Already Open** | `cfg.ref.focus()` within debounce window, else nothing | ✅ OK | Brings to front on re-trigger | `main.ts:75` |
| **Debounce Reset** | Updated on every open attempt; prevents rapid re-opens | ✅ OK | 500ms safety window | `main.ts:72-74` |
| **Position Calc** | None — uses Electron center | ❌ GAP | **Issue #3:** Should position side-by-side with main window (e.g., main at bottom-right, team at bottom-left of same screen) for tiling workflow | `main.ts:82` |
| **Transparency** | Glass-morphism (same as others) | ✅ OK | Consistent | `main.ts:23-35` |
| **Resizable** | `resizable: true` | ✅ OK | User can resize | `main.ts:28` |
| **Preload** | Same security isolation | ✅ OK | Secure | `main.ts:33` |
| **Drag Region** | PanelWindow DragHandle `-webkit-app-region: drag` | ✅ OK | Same pattern | `PanelWindow.tsx:12` |
| **Close Behavior** | User closes manually (X button in TeamPage or frameless edge drag) | ⚠️ PARTIAL | No explicit close button on TeamPage yet. User must use window chrome to close | `TeamPage.tsx` (no close button visible) |
| **On('closed')** | `teamPanelWindow = null` | ✅ OK | Cleanup | `main.ts:85` |
| **Re-open After Close** | Can re-open via WS event or manual trigger; 500ms debounce resets | ✅ OK | None | `main.ts:81` |
| **Focus Management** | Brings existing window to focus; no z-order enforcement between main + team | ⚠️ GAP | If team window is behind main window, focus() might not bring it fully forward on all systems | `main.ts:75` |
| **Persistent State** | Window destroyed on close; TeamPage reloads on next open | ✅ OK | Teams fetched fresh from backend | `TeamPage.tsx` |

---

## Cross-Window Issues

### Critical Issues

| ID | Title | Impact | Evidence | Fix Priority |
|----|----|--------|----------|--------------|
| **#1** | Multi-screen primary display hard-code | User on secondary display: window appears on wrong monitor | `main.ts:48` | **P1** |
| **#2** | Settings window has no position logic | Settings appears centered, not near main window; confusing UX | `main.ts:82` | **P2** |
| **#3** | Team panel no tiling/side-by-side positioning | Team window centers, not alongside main window | `main.ts:82` | **P2** |

### Minor Gaps

| ID | Title | Impact | Fix Priority |
|----|-------|--------|---------|
| **#4** | No min/max size constraints | User can resize to broken sizes | P3 |
| **#5** | Team panel missing close button | User must use window chrome; UX inconsistency vs Settings | P3 |
| **#6** | Window position/size not persisted | User loses layout on restart | P3 |
| **#7** | No focus/blur event handlers | Could enhance multi-window UX but not critical | P3 |

---

## Recommendations

### Phase 1 (Critical)
- [ ] Fix Issue #1: Use `screen.getDisplayMatching()` in `createWindow()` to detect actual display
- [ ] Add min/max size constraints to `baseGlassOptions` (Issue #4)

### Phase 2 (High Value)
- [ ] Issue #2: Position settings window relative to main window (offset +640, same Y)
- [ ] Issue #3: Position team panel side-by-side with main window (calc layout based on screen space)
- [ ] Issue #5: Add close button to TeamPage matching SettingsPage pattern

### Phase 3 (Nice-to-Have)
- [ ] Persist window position/size to localStorage (Issue #6)
- [ ] Implement focus/blur handlers for visual feedback (Issue #7)
- [ ] Z-order enforcement: team panel always floats above main

---

## Verification Checklist (for fixes)

- [ ] CDP screenshot: main window on secondary display — window stays on secondary
- [ ] CDP screenshot: settings opens next to main (not centered)
- [ ] CDP screenshot: team panel opens beside main in tiling layout
- [ ] Manual test: resize all windows to min/max boundaries — no crashes
- [ ] Manual test: close all windows — app quits cleanly without orphaned processes
- [ ] Manual test: team auto-open → close → re-open via WS event — works 3x in a row
