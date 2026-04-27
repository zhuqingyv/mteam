# Window Lifecycle Audit Report (v2 — Corrected)
**Date:** 2026-04-26 | **Auditor:** plan-lifecycle | **Project:** mcp-team-hub/packages/renderer

> **Read specs before audit:** After reading CAPSULE-INTERACTION-SPEC.md + INTERACTION-DESIGN.md, this is corrected audit.
> Key finding: Architecture is dual independent BrowserWindow. Multi-screen bug already fixed (mnemo id:681).

---

## Architecture Overview

**3 independent Electron BrowserWindow instances** sharing same renderer bundle:

| Window | Size | Route | Role | Lifecycle |
|--------|------|-------|------|-----------|
| **Main (CapsuleWindow)** | 380×120 → 640×620 | `/` | CapsulePage (Logo + Chat) | Persists until app quit |
| **Team Panel** | 1200×800 | `?window=team` | TeamPage (Canvas + Sidebar) | Auto-opens on `team.created`, can be closed |
| **Settings** | 600×500 | `?window=settings` | SettingsPage | Toggle on/off from gear button |

---

## 1. Main Window (CapsuleWindow)

### Authority
- **Design Spec:** [CAPSULE-INTERACTION-SPEC.md](./CAPSULE-INTERACTION-SPEC.md) (§1-8, §11 problem list, §12 fixes)
- **Key mnemo refs:** id:681 (multi-screen clamp), id:584 (batch render)

### Lifecycle

| Phase | Current | Status | Issues | Ref |
|-------|---------|--------|--------|-----|
| **Creation** | `createWindow()` at app.whenReady() | ✅ OK | None | `main.ts:47-59` |
| **Position** | Uses `screen.getDisplayMatching({x,y,w,h})` to detect matched display; clamps to its workArea | ✅ FIXED | ~~Hard-coded primary display~~ **Deployed id:681** | `main.ts:113-116` |
| **Size** | 380×120 (capsule) or 640×620 (expanded per URL) | ✅ OK | None | `useCapsuleToggle.ts:4-5` |
| **Frame** | `frame:false`, `hasShadow:false`, `transparent:true` | ✅ OK | None | `main.ts:24-27` |
| **Resizable** | `resizable:true` | ✅ OK | No min/max constraints | P3 gap |
| **Preload** | `contextIsolation:true`, `nodeIntegration:false`, exposes `electronAPI` | ✅ OK | None | `main.ts:31-33` |
| **Expand (CA→EX→EXD)** | 2-phase: resize 350ms + body fade 200ms | ✅ OK | Per spec §3 | `useCapsuleToggle.ts:38-45` |
| **Collapse (EXD→CO→CA)** | 3-phase: fade 200ms + resize 350ms + state flip | ✅ OK | Per spec §4 | `useCapsuleToggle.ts:46-55` |
| **Interrupt** | `timersRef` cleared on toggle; supports "打断重来" | ✅ OK | P2: needs `lockedRef` anti-spam guard | Spec §5.1, §12 T1 |
| **Drag Region** | `.card` = drag; `.card__body` / buttons = no-drag | ✅ OK | Per spec §6 | `CapsuleCard.css:18` |
| **Manual Resize** | IPC `window:start-resize` for edge handles | ⚠️ RESERVED | Not used in capsule, future feature | `main.ts:94-100` |
| **On('closed')** | `mainWindow = null` | ✅ OK | Proper cleanup | `main.ts:59` |
| **On('moved') / On('resized')** | Not implemented | ⚠️ GAP | Position not persisted (P3 id: T3) | Spec §12 T3 |
| **App Quit** | `app.on('window-all-closed')` quits non-macOS | ✅ OK | Proper lifecycle | `main.ts:134-137` |

### P2 Design-Spec Gaps (Main Window)

| Task | Issue | Files | Est | Ref |
|------|-------|-------|-----|-----|
| **T1** | Toggle防抖 + animating lock | `useCapsuleToggle.ts`, `CapsuleCard.tsx` | S | Spec §12 T1 |

---

## 2. Team Panel Window (TeamPanelWindow)

### Authority
- **Design Spec:** [INTERACTION-DESIGN.md](./phase2/INTERACTION-DESIGN.md) (§2-5, architecture + lifecycle)
- **Key refs:** Debounce 500ms, auto-open on `team.created`, collapsed/expanded states

### Lifecycle

| Phase | Current | Status | Issues | Ref |
|-------|---------|--------|--------|-----|
| **Creation** | IPC `window:open-team-panel` → `openPanel('team')` | ✅ OK | None | `main.ts:66-86` |
| **Trigger** | WS `team.created` (debounced 500ms) OR manual `openTeamPanel()` | ✅ OK | Debounce via `lastTeamOpenAt` | `main.ts:62-74` |
| **Position** | Electron default (center) | ⚠️ PARTIAL | Not coordinated with main (Phase 3) | Spec §7.3 |
| **Size** | 1200×800 fixed | ✅ OK | Sidebar + Canvas | Spec §7.1 |
| **If Exists** | Calls `focus()` within debounce; outside debounce... | ❌ BUG | **Can spawn duplicate windows** | See Issue #1 below |
| **Collapsed State** | Supports `collapsed` (border-radius 44px) | ✅ OK | Visual: large capsule in 1200×800 (suboptimal, Phase 3) | Spec §7.2 |
| **On('closed')** | `teamPanelWindow = null` | ✅ OK | Proper cleanup | `main.ts:85` |
| **Auto-Close** | No auto-close except user X or app quit | ✅ OK | Design: "关了就别烦他" (§9.5) | Spec §5.3 |
| **Re-open** | Can re-open after close; new debounce period | ✅ OK | 500ms reset per attempt | `main.ts:81` |

### Critical Issue #1: Duplicate Windows Possible

**Bug in `openPanel('team')`:**

```typescript
// main.ts:66-86
if (cfg.ref && !cfg.ref.isDestroyed()) {
  if (key === 'team') {
    cfg.ref.focus();
    return;
  }
}
// Falls through to create NEW window
const win = new BrowserWindow(...);
if (key === 'team') teamPanelWindow = win;
```

**Scenario:**
1. User calls `openTeamPanel()` → window created, `teamPanelWindow = <Window1>`
2. User minimizes window (not destroyed)
3. Next WS event within debounce → check passes `!cfg.ref.isDestroyed()` → calls `focus()` ✅
4. User closes window via X button → `on('closed')` fires → `teamPanelWindow = null`
5. Next WS event outside debounce window → check: `cfg.ref` is null → **creates 2nd window** ❌

**More problematic:**
- `openPanel()` is called from multiple places (WS event + manual button + IPC)
- No deduplication between "window exists but hidden" vs "window was destroyed"
- `isDestroyed()` only returns true after window fully closes; doesn't catch "closed but still in memory"

**Fix Priority:** **P1** (MVP blocker)

**Proposed Fix:**
```typescript
function openPanel(key: 'team' | 'settings'): void {
  const cfg = key === 'team'
    ? { ref: teamPanelWindow, w: 1200, h: 800, title: '...', q: '?window=team' }
    : { ref: settingsWindow, w: 600, h: 500, title: '...', q: '?window=settings' };
  
  // Check 1: window exists AND not destroyed
  if (cfg.ref && !cfg.ref.isDestroyed()) {
    if (key === 'team') cfg.ref.focus();
    else cfg.ref.close();
    return;
  }
  
  // Check 2: clear stale reference
  if (key === 'team') teamPanelWindow = null;
  else settingsWindow = null;
  
  // Create new
  const win = new BrowserWindow({ ...baseGlassOptions, width: cfg.w, height: cfg.h, title: cfg.title });
  if (key === 'team') {
    teamPanelWindow = win;
    lastTeamOpenAt = Date.now();
  } else {
    settingsWindow = win;
  }
  loadRenderer(win, cfg.q);
  win.on('closed', () => {
    if (key === 'team') teamPanelWindow = null;
    else settingsWindow = null;
  });
}
```

---

## 3. Settings Window (SettingsWindow)

### Lifecycle

| Phase | Current | Status | Issues | Ref |
|-------|---------|--------|--------|-----|
| **Creation** | IPC `window:open-settings` → `openPanel('settings')` | ✅ OK | None | `main.ts:88` |
| **Trigger** | Click gear icon in ExpandedView | ✅ OK | Simple toggle | `preload.cjs:14` |
| **Position** | Electron default (center) | ⚠️ PARTIAL | Not coordinated (Phase 3) | Spec INTERACTION-DESIGN §7.3 |
| **Size** | 600×500 fixed | ✅ OK | None | `main.ts:82` |
| **Toggle Behavior** | If open → close; if closed → open | ✅ OK | Per `openPanel('settings')` logic | `main.ts:77` |
| **Close Button** | SettingsPage renders X calling `window.close()` | ✅ OK | Proper cleanup | `SettingsPage.tsx:41-42` |
| **On('closed')** | `settingsWindow = null` | ✅ OK | Cleanup | `main.ts:85` |
| **State** | No state persisted (read fresh from API) | ✅ OK | Stateless design | `SettingsPage.tsx:27-29` |

### Status
Settings window **no critical issues**. Toggle pattern clean.

---

## Cross-Window Issues

### Phase 2 MVP (Current)

| Issue | Impact | Priority | Phase |
|-------|--------|----------|-------|
| Duplicate team windows possible | Multiple BrowserWindow instances for same panel | **P1** | Phase 2 |
| Window positions not coordinated | Windows appear wherever Electron defaults | P2 | Phase 3 |
| Position/state not persisted | Layout lost on restart | P3 | Phase 3 |

### Design Intent

**Phase 2:** MVP dual-window system ✅  
**Phase 3:** Window tiling + persistence (INTERACTION-DESIGN §7.3)

---

## Summary of Findings

### P1 — MVP Blockers

| ID | Issue | File | Fix |
|----|-------|------|-----|
| **#1** | Team panel can create duplicate windows on repeated `openPanel('team')` calls when window closed+recreated | `main.ts:66-86` | Add null-clear before window creation (see "Proposed Fix" above) |

### P2 — Design Spec Compliance

| ID | Task | Files | Spec Ref |
|----|------|-------|----------|
| **T1** | Toggle防抖 + animating state lock | `useCapsuleToggle.ts`, `CapsuleCard.tsx` | §12 T1 |

### P3 — Nice-to-Have

| ID | Task | Files | Spec Ref |
|----|------|-------|----------|
| **T2** | Drag-lock (拖动中锁定 toggle) | `preload.cjs`, `useCapsuleToggle.ts` | §12 T2 |
| **T3** | Position persistence | `main.ts`, `useCapsuleToggle.ts` | §12 T3 |
| **T4** | DragHandle cursor feedback | `CapsuleCard.css` | §12 T4 |

---

## Verification Checklist

- [ ] Main window cold-start capsule: 380×120, right-bottom ✅
- [ ] Main window cold-start expanded: 640×620 with `?expanded=1` ✅
- [ ] Multi-screen: expand on secondary display → stays on secondary (id:681) ✅
- [ ] Team panel auto-open: `team.created` → window appears <500ms ✅
- [ ] Team panel toggle: minimize+maximize doesn't create duplicate ❌ **FIX #1**
- [ ] Team panel close+reopen: single window, not N ❌ **FIX #1**
- [ ] Settings toggle: click gear → open; click again → close ✅
- [ ] Capsule interrupt: expand-animating → click X → collapse ✅
- [ ] Capsule drag: drag pill → move; drag body → no move ✅
- [ ] All windows quit cleanly: app quit → no orphaned processes ✅

---

## Related Docs

- [CAPSULE-INTERACTION-SPEC.md](./CAPSULE-INTERACTION-SPEC.md) — Main window state machine (authority)
- [phase2/INTERACTION-DESIGN.md](./phase2/INTERACTION-DESIGN.md) — Dual-window architecture + team panel flow (authority)
- [mnemo id:681](.) — Multi-screen clamp fix (getDisplayMatching)
- [mnemo id:584](.) — Batch render fix (setExpanded + setAnimating in same handler)

---

## For Plan-Tech

**Recommendation:** Fix Issue #1 before shipping Phase 2. This is a real bug that can leave orphaned windows in memory.

All other findings align with design specs or are intentional Phase 3 work.

