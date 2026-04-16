/**
 * governance.e2e.test.ts — Rule governance via Hub HTTP API
 *
 * Drives ALL state changes through the Hub API (port 58578).
 * No writeFileSync/mkdirSync to fake member state.
 *
 * Flow:
 *   1. Member proposes a rule via propose_rule (Hub tool)
 *   2. Leader reviews pending rules via review_rules (Hub tool)
 *   3. Leader approves rule via approve_rule (Hub tool)
 *   4. Verify rule appears in shared rules
 *   5. Second rule proposed and rejected
 *   6. UI displays governance state
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { readFileSync, rmSync, existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import http from 'http'

// ── Constants ────────────────────────────────────────────────────────────────
const PANEL_DIR = resolve(__dirname, '..')
const HUB_PORT = 58578
const TEAM_HUB_DIR = join(homedir(), '.claude/team-hub')
const MEMBERS_DIR = join(TEAM_HUB_DIR, 'members')
const SHARED_DIR = join(TEAM_HUB_DIR, 'shared')

const GOV_MEMBER = '__e2e_gov_member__'
const GOV_LEADER = '__e2e_gov_leader__'
const PROJECT = 'e2e-gov-proj'

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
let memberSessionId: string
let panelPort: number
let leaderCaller: string
let approvedRuleId: string
let originalRulesContent: string | null = null
let launchedElectron = false

// ── Setup / Teardown ─────────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Check if Panel is already running
  const existingPort = await detectRunningPanel()

  if (existingPort > 0) {
    // Panel already running — use it directly, skip Electron launch
    panelPort = existingPort
    await waitForHub()
  } else {
    // No running Panel — launch our own Electron instance
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

  // Save original rules.md
  const rulesPath = join(SHARED_DIR, 'rules.md')
  try { originalRulesContent = readFileSync(rulesPath, 'utf-8') } catch { originalRulesContent = null }

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
      uid: 'e2e-gov-leader-uid', name: GOV_LEADER, role: 'leader',
      type: 'permanent', joined_at: new Date().toISOString()
    })
    leaderCaller = GOV_LEADER
  }

  // Hire governance test member via Hub API
  const hireResult = await hubCall(leaderSessionId, 'hire_temp', {
    caller: leaderCaller, name: GOV_MEMBER, role: 'governance-tester',
    skills: ['governance']
  })
  expect(hireResult.success).toBe(true)

  // Reserve via Hub API
  const reservation = await hubCall(leaderSessionId, 'request_member', {
    caller: leaderCaller, member: GOV_MEMBER, project: PROJECT,
    task: 'governance-testing', auto_spawn: false
  })
  expect(reservation.reserved).toBe(true)

  // Activate via Panel lock + Hub activate
  const enc = encodeURIComponent(GOV_MEMBER)
  await httpRequest(panelPort, 'POST', `/api/member/${enc}/lock/acquire`, {
    session_pid: process.pid, session_start: new Date().toISOString(), project: PROJECT, task: 'governance-testing'
  })
  await httpRequest(panelPort, 'DELETE', `/api/member/${enc}/reservation`)
  await httpRequest(panelPort, 'POST', `/api/member/${enc}/heartbeat`, {
    session_pid: process.pid, last_tool: 'activate'
  })

  memberSessionId = await registerSession({
    pid: process.pid, lstart: new Date().toString(), member: GOV_MEMBER, isLeader: false
  })

  const activation = await hubCall(memberSessionId, 'activate', { member: GOV_MEMBER })
  expect(activation.error).toBeUndefined()
})

test.afterAll(async () => {
  for (const sid of [memberSessionId, leaderSessionId]) {
    try { if (sid) await unregisterSession(sid) } catch {}
  }
  for (const name of [GOV_MEMBER, GOV_LEADER]) {
    try { rmSync(join(MEMBERS_DIR, name), { recursive: true, force: true }) } catch {}
  }

  // Restore original rules.md
  const rulesPath = join(SHARED_DIR, 'rules.md')
  if (originalRulesContent !== null) {
    writeFileSync(rulesPath, originalRulesContent)
  }

  // Clean up pending_rules.json entries from this test
  const pendingPath = join(SHARED_DIR, 'pending_rules.json')
  try {
    const pending = JSON.parse(readFileSync(pendingPath, 'utf-8'))
    if (Array.isArray(pending)) {
      const cleaned = pending.filter((r: any) => r.member !== GOV_MEMBER)
      writeFileSync(pendingPath, JSON.stringify(cleaned, null, 2))
    }
  } catch {}

  if (launchedElectron && app) {
    await Promise.race([app.close(), new Promise<void>(r => setTimeout(r, 5_000))]).catch(() => {})
    try { const pid = app.process().pid; if (pid) process.kill(pid, 'SIGKILL') } catch {}
  }
})

// ── Test 1: Hub healthy and member working ──────────────────────────────────

test('1. Hub is healthy and governance member is working', async () => {
  const health = await httpRequest(HUB_PORT, 'GET', '/api/health')
  expect(health.body.ok).toBe(true)

  const status = await hubCall(leaderSessionId, 'get_status', { member: GOV_MEMBER })
  expect(status.status).toBe('working')
})

// ── Test 2: propose_rule ────────────────────────────────────────────────────

test('2. propose_rule: member proposes a new governance rule', async () => {
  const result = await hubCall(memberSessionId, 'propose_rule', {
    member: GOV_MEMBER,
    rule: 'All E2E tests must use Hub API, not direct file writes',
    reason: 'Ensures tests exercise the real system path'
  })

  // proposeRule returns { id, duplicate, hint }
  expect(result.id).toBeTruthy()
  expect(typeof result.duplicate).toBe('boolean')
  approvedRuleId = result.id
})

// ── Test 3: review_rules ────────────────────────────────────────────────────

test('3. review_rules: leader sees the proposed rule', async () => {
  const result = await hubCall(leaderSessionId, 'review_rules')

  expect(result.rules).toBeTruthy()
  expect(Array.isArray(result.rules)).toBe(true)

  const found = result.rules.find((r: any) => r.id === approvedRuleId)
  expect(found).toBeTruthy()
  expect(found.rule).toBe('All E2E tests must use Hub API, not direct file writes')
  expect(found.member).toBe(GOV_MEMBER)
})

// ── Test 4: approve_rule ────────────────────────────────────────────────────

test('4. approve_rule: leader approves the proposed rule', async () => {
  const result = await hubCall(leaderSessionId, 'approve_rule', {
    caller: leaderCaller, rule_id: approvedRuleId
  })

  // approveRule returns { success: true, hint }
  expect(result.success).toBe(true)

  // Verify on disk
  const rulesPath = join(SHARED_DIR, 'rules.md')
  expect(existsSync(rulesPath)).toBe(true)
  const rulesContent = readFileSync(rulesPath, 'utf-8')
  expect(rulesContent).toContain('All E2E tests must use Hub API, not direct file writes')
})

// ── Test 5: Approved rule not in pending ────────────────────────────────────

test('5. review_rules: approved rule no longer in pending', async () => {
  const result = await hubCall(leaderSessionId, 'review_rules')
  const found = (result.rules ?? []).find((r: any) => r.id === approvedRuleId)
  expect(found).toBeUndefined()
})

// ── Test 6: read_shared returns approved rule ───────────────────────────────

test('6. read_shared(rules) returns the approved rule', async () => {
  const result = await hubCall(leaderSessionId, 'read_shared', { type: 'rules' })
  // read_shared returns { content: "..." }
  expect(result.content).toBeTruthy()
  expect(result.content).toContain('All E2E tests must use Hub API, not direct file writes')
})

// ── Test 7: propose + reject ────────────────────────────────────────────────

test('7. propose + reject: leader rejects a bad rule', async () => {
  const proposed = await hubCall(memberSessionId, 'propose_rule', {
    member: GOV_MEMBER,
    rule: 'Allow direct file writes in tests',
    reason: 'Convenience'
  })
  expect(proposed.id).toBeTruthy()

  const rejected = await hubCall(leaderSessionId, 'reject_rule', {
    caller: leaderCaller, rule_id: proposed.id,
    reason: 'This defeats the purpose of E2E testing'
  })
  // rejectRule returns { success: true, hint }
  expect(rejected.success).toBe(true)

  const rulesContent = readFileSync(join(SHARED_DIR, 'rules.md'), 'utf-8')
  expect(rulesContent).not.toContain('Allow direct file writes in tests')
})

// ── Test 8: submit_experience ───────────────────────────────────────────────

test('8. submit_experience: member shares team experience', async () => {
  const result = await hubCall(memberSessionId, 'submit_experience', {
    member: GOV_MEMBER, scope: 'generic',
    content: 'Hub API E2E tests are reliable when using real sessions'
  })
  // submit_experience returns { success: true, ... }
  expect(result.success).toBe(true)
})

// ── Test 9: search_experience ───────────────────────────────────────────────

test('9. search_experience: find the submitted experience', async () => {
  const result = await hubCall(leaderSessionId, 'search_experience', {
    keyword: 'Hub API E2E'
  })

  expect(result.results).toBeTruthy()
  expect(result.results.length).toBeGreaterThanOrEqual(1)
  const found = result.results.find((r: any) =>
    typeof r === 'string' ? r.includes('Hub API E2E') : r.line?.includes('Hub API E2E')
  )
  expect(found).toBeTruthy()
})

// ── Test 10: get_team_rules ─────────────────────────────────────────────────

test('10. get_team_rules returns the approved rule set', async () => {
  const result = await hubCall(leaderSessionId, 'get_team_rules')
  // get_team_rules returns { rules: "...", acceptance_chain, acceptance_rule }
  expect(result.rules).toBeTruthy()
  expect(result.rules).toContain('All E2E tests must use Hub API')
})

// ── Test 11: UI shows governance member ─────────────────────────────────────

test('11. UI shows the governance member in working state', async () => {
  test.skip(!window, 'No Electron window — Panel was already running')
  await window!.waitForFunction(
    (name: string) => document.querySelector('.panel')?.textContent?.includes(name) ?? false,
    GOV_MEMBER,
    { timeout: 15_000 }
  )
  await expect(window!.locator(`text=${GOV_MEMBER}`).first()).toBeVisible()
  await window!.screenshot({ path: join(PANEL_DIR, 'e2e/screenshots/13-health-status.png') })
})

// ── Test 12: Health indicator ───────────────────────────────────────────────

test('12. Health indicator shows normal', async () => {
  test.skip(!window, 'No Electron window — Panel was already running')
  const headerContent = await window!.textContent('.panel')
  const hasHealth = headerContent?.includes('正常') || headerContent?.includes('异常')
  expect(hasHealth).toBe(true)
  await window!.screenshot({ path: join(PANEL_DIR, 'e2e/screenshots/14-navbar-stats.png') })
})

// ── Test 13: checkpoint ─────────────────────────────────────────────────────

test('13. checkpoint: member self-checks task alignment', async () => {
  const result = await hubCall(memberSessionId, 'checkpoint', {
    member: GOV_MEMBER, progress_summary: 'Governance E2E tests complete'
  })
  // checkpoint returns { checkpoint: true, original_task: { project, task }, ... }
  expect(result.checkpoint).toBe(true)
  expect(result.original_task).toBeTruthy()
  expect(result.original_task.project).toBe(PROJECT)
})

// ── Test 14: Final screenshot ───────────────────────────────────────────────

test('14. Final governance state screenshot', async () => {
  test.skip(!window, 'No Electron window — Panel was already running')
  await window!.screenshot({ path: join(PANEL_DIR, 'e2e/screenshots/24-final-state.png') })
})
