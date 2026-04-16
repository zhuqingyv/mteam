/**
 * communication.e2e.test.ts — Inter-member messaging via Hub HTTP API
 *
 * Drives ALL state changes through the Hub API (port 58578).
 * No writeFileSync/mkdirSync to fake member state.
 *
 * Flow:
 *   1. Leader hires two temp members A and B
 *   2. Activates both via Panel lock + Hub activate (backward-compatible mode)
 *   3. A sends message to B via send_msg (Hub tool)
 *   4. B checks inbox via check_inbox (Hub tool)
 *   5. Bidirectional messaging verified
 *   6. UI reflects member states throughout
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import http from 'http'

// ── Constants ────────────────────────────────────────────────────────────────
const PANEL_DIR = resolve(__dirname, '..')
const HUB_PORT = 58578
const TEAM_HUB_DIR = join(homedir(), '.claude/team-hub')
const MEMBERS_DIR = join(TEAM_HUB_DIR, 'members')

const MEMBER_A = '__e2e_comm_alpha__'
const MEMBER_B = '__e2e_comm_beta__'
const LEADER_NAME = '__e2e_comm_leader__'
const PROJECT = 'e2e-comm-proj'

// ── HTTP helper ──────────────────────────────────────────────────────────────

function httpRequest(port: number, method: string, path: string, data?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : undefined
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

// ── Hub API helpers ──────────────────────────────────────────────────────────

async function waitForHub(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpRequest(HUB_PORT, 'GET', '/api/health')
      if (res.status === 200 && res.body.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('Hub did not become available')
}

async function registerSession(opts: { pid: number; lstart: string; member?: string; isLeader?: boolean }): Promise<string> {
  const res = await httpRequest(HUB_PORT, 'POST', '/api/session/register', opts)
  expect(res.status).toBe(200)
  return res.body.session_id
}

async function unregisterSession(sessionId: string): Promise<void> {
  await httpRequest(HUB_PORT, 'POST', '/api/session/unregister', { session_id: sessionId }).catch(() => {})
}

async function hubCall(sessionId: string, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await httpRequest(HUB_PORT, 'POST', '/api/call', {
    session_id: sessionId, tool, arguments: args
  })
  expect(res.status).toBe(200)
  const text = res.body?.content?.[0]?.text
  expect(text).toBeTruthy()
  return JSON.parse(text)
}

async function waitForPanelApi(timeoutMs = 15_000): Promise<number> {
  const panelPortFile = join(TEAM_HUB_DIR, 'panel.port')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const port = parseInt(readFileSync(panelPortFile, 'utf-8').trim(), 10)
      if (!isNaN(port) && port > 0) {
        const ok = await httpRequest(port, 'GET', '/api/member/list')
          .then(r => r.status === 200).catch(() => false)
        if (ok) return port
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('Panel API did not start')
}

async function findPanelWindow(app: ElectronApplication): Promise<Page> {
  let attempts = 0
  while (app.windows().length === 0 && attempts < 60) {
    await new Promise(r => setTimeout(r, 500))
    attempts++
  }
  const windows = app.windows()
  for (const w of windows) {
    if (w.url().includes('index.html') && !w.url().includes('terminal')) return w
  }
  return windows[0]
}

/** Activate a member: create lock via Panel API, then Hub activate (backward-compatible) */
async function activateMember(
  panelPort: number,
  memberName: string,
  project: string,
  task: string
): Promise<{ sessionId: string; result: any }> {
  const enc = encodeURIComponent(memberName)

  // Create lock via Panel API
  const lockRes = await httpRequest(panelPort, 'POST', `/api/member/${enc}/lock/acquire`, {
    session_pid: process.pid, session_start: new Date().toISOString(), project, task
  })
  expect(lockRes.body.ok).toBe(true)

  // Delete reservation (if any)
  await httpRequest(panelPort, 'DELETE', `/api/member/${enc}/reservation`)

  // Create heartbeat
  await httpRequest(panelPort, 'POST', `/api/member/${enc}/heartbeat`, {
    session_pid: process.pid, last_tool: 'activate'
  })

  // Register member session
  const sessionId = await registerSession({
    pid: process.pid, lstart: new Date().toString(), member: memberName, isLeader: false
  })

  // Activate via Hub (backward-compatible: no reservation_code, existing lock)
  const result = await hubCall(sessionId, 'activate', { member: memberName })
  expect(result.error).toBeUndefined()

  return { sessionId, result }
}

// ── Panel detection ─────────────────────────────────────────────────────────

/** Try to connect to an already-running Panel, returns port or 0 */
async function detectRunningPanel(): Promise<number> {
  const panelPortFile = join(TEAM_HUB_DIR, 'panel.port')
  try {
    const port = parseInt(readFileSync(panelPortFile, 'utf-8').trim(), 10)
    if (!isNaN(port) && port > 0) {
      const ok = await httpRequest(port, 'GET', '/api/member/list')
        .then(r => r.status === 200).catch(() => false)
      if (ok) return port
    }
  } catch {}
  return 0
}

// ── Test state ───────────────────────────────────────────────────────────────

let app: ElectronApplication | null = null
let window: Page | null = null
let leaderSessionId: string
let sessionA: string
let sessionB: string
let leaderCaller: string
let panelPort: number
let launchedElectron = false

// ── Setup / Teardown ─────────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Check if Panel is already running
  const existingPort = await detectRunningPanel()

  if (existingPort > 0) {
    panelPort = existingPort
    await waitForHub()
  } else {
    execSync('npx electron-vite build', { cwd: PANEL_DIR, timeout: 60_000 })

    app = await electron.launch({
      args: ['.'], cwd: PANEL_DIR,
      env: { ...process.env, NODE_ENV: 'test', E2E_HEADLESS: '1' }
    })
    launchedElectron = true

    window = await findPanelWindow(app)
    await window.waitForLoadState('domcontentloaded')
    await window.waitForSelector('text=Team Hub', { timeout: 30_000 })
    await waitForHub()
    panelPort = await waitForPanelApi()
  }

  // Register leader session
  leaderSessionId = await registerSession({
    pid: process.pid, lstart: new Date().toString(), member: '', isLeader: true
  })

  // Find/create leader profile
  const roster = await hubCall(leaderSessionId, 'get_roster')
  leaderCaller = ''
  if (roster?.roster) {
    for (const m of roster.roster) {
      if (m.role === 'leader' || m.role === '总控') { leaderCaller = m.name; break }
    }
  }
  if (!leaderCaller) {
    await httpRequest(panelPort, 'POST', '/api/member/create', {
      uid: 'e2e-comm-leader-uid', name: LEADER_NAME, role: 'leader',
      type: 'permanent', joined_at: new Date().toISOString()
    })
    leaderCaller = LEADER_NAME
  }

  // Hire both test members via Hub API
  for (const [name, role] of [[MEMBER_A, 'comm-dev'], [MEMBER_B, 'comm-qa']] as const) {
    const result = await hubCall(leaderSessionId, 'hire_temp', {
      caller: leaderCaller, name, role, skills: ['communication']
    })
    expect(result.success).toBe(true)
  }

  // Reserve via Hub API
  for (const [name, task] of [[MEMBER_A, 'comm-task-a'], [MEMBER_B, 'comm-task-b']] as const) {
    const res = await hubCall(leaderSessionId, 'request_member', {
      caller: leaderCaller, member: name, project: PROJECT, task, auto_spawn: false
    })
    expect(res.reserved).toBe(true)
  }

  // Activate both via Panel lock + Hub activate
  const actA = await activateMember(panelPort, MEMBER_A, PROJECT, 'comm-task-a')
  sessionA = actA.sessionId

  const actB = await activateMember(panelPort, MEMBER_B, PROJECT, 'comm-task-b')
  sessionB = actB.sessionId
})

test.afterAll(async () => {
  for (const sid of [sessionA, sessionB, leaderSessionId]) {
    try { if (sid) await unregisterSession(sid) } catch {}
  }
  for (const name of [MEMBER_A, MEMBER_B, LEADER_NAME]) {
    try { rmSync(join(MEMBERS_DIR, name), { recursive: true, force: true }) } catch {}
  }
  if (launchedElectron && app) {
    await Promise.race([app.close(), new Promise<void>(r => setTimeout(r, 5_000))]).catch(() => {})
    try { const pid = app.process().pid; if (pid) process.kill(pid, 'SIGKILL') } catch {}
  }
})

// ── Test 1: Both members working ────────────────────────────────────────────

test('1. Both members show as working via get_status', async () => {
  const statusA = await hubCall(leaderSessionId, 'get_status', { member: MEMBER_A })
  expect(statusA.status).toBe('working')
  expect(statusA.lock.project).toBe(PROJECT)

  const statusB = await hubCall(leaderSessionId, 'get_status', { member: MEMBER_B })
  expect(statusB.status).toBe('working')
})

// ── Test 2: UI shows both members ───────────────────────────────────────────

test('2. UI shows both members under project group', async () => {
  test.skip(!window, 'No Electron window — Panel was already running')
  await window!.waitForFunction(
    (proj: string) => document.querySelector('.panel')?.textContent?.includes(proj) ?? false,
    PROJECT,
    { timeout: 15_000 }
  )
  await expect(window!.locator(`text=${PROJECT}`).first()).toBeVisible()
  await window!.screenshot({ path: join(PANEL_DIR, 'e2e/screenshots/01-member-list.png') })
})

// ── Test 3: A sends message to B ────────────────────────────────────────────

test('3. send_msg: A sends message to B via Hub API', async () => {
  const result = await hubCall(sessionA, 'send_msg', {
    to: MEMBER_B,
    content: 'Hello B, this is A speaking via Hub API!',
    priority: 'normal'
  })
  expect(result.error).toBeUndefined()
})

// ── Test 4: B checks inbox ──────────────────────────────────────────────────

test('4. check_inbox: B receives message from A', async () => {
  const result = await hubCall(sessionB, 'check_inbox', { member: MEMBER_B })

  expect(result.messages).toBeTruthy()
  expect(Array.isArray(result.messages)).toBe(true)

  const msgFromA = result.messages.find((m: any) =>
    m.from === MEMBER_A && m.content.includes('Hello B')
  )
  expect(msgFromA).toBeTruthy()
  expect(msgFromA.content).toContain('Hello B, this is A speaking via Hub API!')
})

// ── Test 5: B replies to A ──────────────────────────────────────────────────

test('5. send_msg: B replies to A via Hub API', async () => {
  const result = await hubCall(sessionB, 'send_msg', {
    to: MEMBER_A,
    content: 'Got it A! Reply from B via Hub.',
    priority: 'normal'
  })
  expect(result.error).toBeUndefined()
})

// ── Test 6: A receives B's reply ────────────────────────────────────────────

test('6. check_inbox: A receives reply from B', async () => {
  const result = await hubCall(sessionA, 'check_inbox', { member: MEMBER_A })

  expect(result.messages).toBeTruthy()
  const msgFromB = result.messages.find((m: any) =>
    m.from === MEMBER_B && m.content.includes('Reply from B')
  )
  expect(msgFromB).toBeTruthy()
})

// ── Test 7: Urgent message priority ─────────────────────────────────────────

test('7. Urgent messages have higher priority in inbox', async () => {
  await hubCall(sessionA, 'send_msg', {
    to: MEMBER_B, content: 'normal-priority-msg', priority: 'normal'
  })
  await hubCall(sessionA, 'send_msg', {
    to: MEMBER_B, content: 'urgent-priority-msg', priority: 'urgent'
  })

  const result = await hubCall(sessionB, 'check_inbox', { member: MEMBER_B })
  expect(result.messages.length).toBeGreaterThanOrEqual(2)

  const urgentIdx = result.messages.findIndex((m: any) => m.content === 'urgent-priority-msg')
  const normalIdx = result.messages.findIndex((m: any) => m.content === 'normal-priority-msg')
  expect(urgentIdx).toBeLessThan(normalIdx)
})

// ── Test 8: check_inbox consumes messages ───────────────────────────────────

test('8. check_inbox consumes messages — second read is empty', async () => {
  await hubCall(sessionA, 'send_msg', {
    to: MEMBER_B, content: 'consume-test-msg'
  })

  const first = await hubCall(sessionB, 'check_inbox', { member: MEMBER_B })
  const found = first.messages.find((m: any) => m.content === 'consume-test-msg')
  expect(found).toBeTruthy()

  const second = await hubCall(sessionB, 'check_inbox', { member: MEMBER_B })
  expect(second.messages.length).toBe(0)
})

// ── Test 9: team_report ─────────────────────────────────────────────────────

test('9. team_report reflects both members working on same project', async () => {
  const report = await hubCall(leaderSessionId, 'team_report')
  const reportText = JSON.stringify(report)

  expect(reportText).toContain(MEMBER_A)
  expect(reportText).toContain(MEMBER_B)
  expect(reportText).toContain(PROJECT)
})

// ── Test 10: Final screenshot ───────────────────────────────────────────────

test('10. Screenshot final communication state', async () => {
  test.skip(!window, 'No Electron window — Panel was already running')
  await window!.screenshot({ path: join(PANEL_DIR, 'e2e/screenshots/02-communication-final.png') })
})
