import http from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  writeFileSync, rmSync, readFileSync, existsSync,
  mkdirSync, readdirSync, appendFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { scanAgentClis } from './agent-cli-scanner'
import {
  getPtySessions,
  killPtySession,
  writeToPty,
  getSessionByMemberId,
  waitForCliReady
} from './pty-manager'
import { openTerminalWindow } from './terminal-window'
import { createAskUserRequest, type AskUserType } from './ask-user-window'
import * as store from './member-store-service'
import type { Profile, Lock, Heartbeat, Reservation, WorkLogEntry } from './member-store-service'
import { proxyApiRequest, listApiKeys, addApiKey, removeApiKey } from './api-proxy'

// ── Config ────────────────────────────────────────────────────────────────────

const TEAM_HUB_DIR = join(homedir(), '.claude', 'team-hub')
const MEMBERS_DIR = join(TEAM_HUB_DIR, 'members')
const SHARED_DIR = join(TEAM_HUB_DIR, 'shared')
const PANEL_PORT_FILE = join(TEAM_HUB_DIR, 'panel.port')
const PANEL_HOST = '127.0.0.1'

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

// ── Message router reference (set after setupMessageRouter is called) ─────────

let _messageRouter: {
  sendMessage: (from: string, to: string, content: string, priority?: string) => { id: string; delivered: boolean; error?: string }
  getInbox: (memberId: string) => unknown[]
  consumeInbox: (memberId: string) => unknown[]
} | null = null

export function setMessageRouter(router: typeof _messageRouter): void {
  _messageRouter = router
}

// ── File Helpers (for shared/ operations not covered by member-store-service) ─

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

// ── Member Status Aggregation ────────────────────────────────────────────────

function getMemberStatus(name: string): {
  profile: Profile
  lock: Lock | null
  heartbeat: Heartbeat | null
  reservation: Reservation | null
  status: 'reserved' | 'working' | 'offline'
} | null {
  const profile = store.getMember(MEMBERS_DIR, name)
  if (!profile) return null

  const lock = store.readLock(MEMBERS_DIR, name)
  const heartbeat = store.readHeartbeat(MEMBERS_DIR, name)
  const reservation = store.readReservation(MEMBERS_DIR, name)
  // TTL check at API layer
  const validReservation = reservation && (Date.now() - reservation.created_at <= reservation.ttl_ms)
    ? reservation : null
  if (reservation && !validReservation) {
    store.deleteReservation(MEMBERS_DIR, name)
  }
  let status: 'reserved' | 'working' | 'offline'
  if (lock) {
    status = 'working'
  } else {
    const ptySession = getPtySessions().find((s) => s.memberId === name && s.status === 'running')
    if (ptySession) {
      status = 'working'
    } else if (validReservation) {
      status = 'reserved'
    } else {
      status = 'offline'
    }
  }

  return { profile, lock, heartbeat, reservation: validReservation, status }
}

// ── URL Pattern Matching ─────────────────────────────────────────────────────

function matchRoute(method: string, pattern: string, reqMethod: string, url: string): Record<string, string> | null {
  if (method !== reqMethod) return null
  const patternParts = pattern.split('/')
  const urlParts = url.split('?')[0].split('/')
  if (patternParts.length !== urlParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i])
    } else if (patternParts[i] !== urlParts[i]) {
      return null
    }
  }
  return params
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?')
  if (idx === -1) return {}
  const qs: Record<string, string> = {}
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=')
    if (k) qs[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
  }
  return qs
}

// ── Server ────────────────────────────────────────────────────────────────────

let panelServer: http.Server | null = null

export function startPanelApi(): void {
  if (panelServer) return

  panelServer = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // GET /api/agent-clis
      if (method === 'GET' && url === '/api/agent-clis') {
        const result = await scanAgentClis()
        return jsonResponse(res, 200, result)
      }

      // POST /api/pty/spawn
      if (method === 'POST' && url === '/api/pty/spawn') {
        const body = await readBody(req) as {
          member?: string
          cli_name?: string
          cli_bin?: string
          is_leader?: boolean
          task?: string
          reservation_code?: string
          workspace_path?: string
        }
        if (!body.member || !body.cli_name) {
          return jsonResponse(res, 400, { error: 'member and cli_name are required' })
        }

        // Find bin: prefer provided cli_bin, otherwise scan
        let bin = body.cli_bin
        if (!bin) {
          const scan = await scanAgentClis()
          const found = scan.found.find((c) => c.name === body.cli_name)
          if (!found) {
            return jsonResponse(res, 404, { error: `CLI '${body.cli_name}' not found` })
          }
          bin = found.bin
        }

        // memberName is now the Chinese name (folder name = profile.name)
        const displayName = body.member

        // Pre-write workspace trust for member before spawning
        // so the member CLI doesn't prompt for trust dialog
        if (body.workspace_path) {
          const claudeJsonPath = join(homedir(), '.claude.json')
          try {
            let config: Record<string, unknown> = {}
            if (existsSync(claudeJsonPath)) {
              config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
            }
            if (!config.projects || typeof config.projects !== 'object') {
              config.projects = {}
            }
            const projects = config.projects as Record<string, Record<string, unknown>>
            if (!projects[body.workspace_path]) {
              projects[body.workspace_path] = {}
            }
            if (!projects[body.workspace_path].hasTrustDialogAccepted) {
              projects[body.workspace_path].hasTrustDialogAccepted = true
              writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), 'utf-8')
            }
          } catch { /* trust pre-write failed, openTerminalWindow will handle it */ }
        }

        // openTerminalWindow handles PTY spawn + window + persona injection
        const result = openTerminalWindow({
          memberName: body.member,
          cliBin: bin,
          cliName: body.cli_name,
          isLeader: body.is_leader ?? false,
          workspacePath: body.workspace_path
        })

        if (!result.ok) {
          const status = result.reason === 'trust_required' ? 403 : 500
          return jsonResponse(res, status, {
            error: result.reason,
            workspace_path: (result as { workspacePath?: string }).workspacePath
          })
        }

        return jsonResponse(res, 200, { ok: true, winId: result.winId })
      }

      // GET /api/pty/sessions
      if (method === 'GET' && url === '/api/pty/sessions') {
        return jsonResponse(res, 200, { sessions: getPtySessions() })
      }

      // POST /api/pty/write — 向成员的 PTY 写入内容（代理用户输入）
      // 支持等待：spawn 后 PTY + CLI 可能还未就绪，等待 CLI 输出 prompt 后再写入
      if (method === 'POST' && url === '/api/pty/write') {
        const body = await readBody(req) as { member?: string; content?: string; wait?: boolean }
        if (!body.member || !body.content) {
          return jsonResponse(res, 400, { error: 'member and content are required' })
        }
        const shouldWait = body.wait !== false // 默认等待
        let session = getSessionByMemberId(body.member)
        if (!session && shouldWait) {
          // 等待 PTY session 出现且 CLI 输出了 input prompt（最多 30 秒）
          const ready = await waitForCliReady(body.member, 30_000)
          if (ready) {
            session = getSessionByMemberId(body.member)
          }
        }
        if (!session) {
          return jsonResponse(res, 404, { error: `成员 ${body.member} 没有活跃终端（等待超时）` })
        }
        writeToPty(session.id, body.content + '\r')
        return jsonResponse(res, 200, { ok: true })
      }

      // POST /api/pty/kill
      if (method === 'POST' && url === '/api/pty/kill') {
        const body = await readBody(req) as { session_id?: string }
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: 'session_id is required' })
        }
        const killed = killPtySession(body.session_id)
        return jsonResponse(res, 200, { ok: killed })
      }

      // POST /api/message/send
      if (method === 'POST' && url === '/api/message/send') {
        const body = await readBody(req) as {
          from?: string
          to?: string
          content?: string
          priority?: string
        }
        if (!body.from || !body.to || !body.content) {
          return jsonResponse(res, 400, { error: 'from, to, and content are required' })
        }
        if (!_messageRouter) {
          return jsonResponse(res, 503, { error: 'message router not ready' })
        }
        const result = _messageRouter.sendMessage(body.from, body.to, body.content, body.priority)
        if (result.error) {
          return jsonResponse(res, 400, { ok: false, error: result.error })
        }
        return jsonResponse(res, 200, { ok: true, id: result.id, delivered: result.delivered })
      }

      // GET /api/message/inbox/:member — 只读查看（不消费）
      // DELETE /api/message/inbox/:member — 消费式读取（读后清空，避免重复 PTY 投递）
      const inboxMatch = url.match(/^\/api\/message\/inbox\/([^/]+)$/)
      if (inboxMatch && (method === 'GET' || method === 'DELETE')) {
        const member = decodeURIComponent(inboxMatch[1])
        if (!_messageRouter) {
          return jsonResponse(res, 503, { error: 'message router not ready' })
        }
        // DELETE = 消费式读取（check_inbox 使用），GET = 只读查看
        const messages = method === 'DELETE'
          ? _messageRouter.consumeInbox(member)
          : _messageRouter.getInbox(member)
        return jsonResponse(res, 200, { member, messages })
      }

      // ════════════════════════════════════════════════════════════════════════
      // Member Management API — /api/member/*
      // ════════════════════════════════════════════════════════════════════════

      let params: Record<string, string> | null

      // GET /api/member/list — 列出全部成员（profile + 实时状态聚合）
      if (method === 'GET' && url.split('?')[0] === '/api/member/list') {
        const profiles = store.listMembers(MEMBERS_DIR)
        const members = profiles.map((p) => {
          const s = getMemberStatus(p.name)
          return s ? {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status
          } : { ...p, status: 'offline' as const }
        })
        return jsonResponse(res, 200, { ok: true, data: members })
      }

      // POST /api/member/create — 创建成员
      if (method === 'POST' && url === '/api/member/create') {
        const body = await readBody(req) as Partial<Profile>
        if (!body.name || !body.role) {
          return jsonResponse(res, 400, { ok: false, error: 'name, role are required' })
        }
        const existing = store.getMember(MEMBERS_DIR, body.name)
        if (existing) {
          return jsonResponse(res, 409, { ok: false, error: `member ${body.name} already exists` })
        }
        const profile: Profile = {
          uid: body.uid ?? randomUUID(),
          name: body.name,
          role: body.role,
          type: body.type ?? 'temporary',
          joined_at: body.joined_at ?? new Date().toISOString(),
          skills: body.skills,
          description: body.description
        }
        store.createMember(MEMBERS_DIR, profile)
        return jsonResponse(res, 201, { ok: true, data: profile })
      }

      // GET /api/member/:name — 单成员详情
      params = matchRoute('GET', '/api/member/:name', method, url)
      if (params && params.name !== 'list') {
        const s = getMemberStatus(params.name)
        if (!s) return jsonResponse(res, 404, { ok: false, error: 'member not found' })

        // 额外加载 persona、memory、worklog
        const persona = store.readPersona(MEMBERS_DIR, params.name) || null
        const memory = store.readMemory(MEMBERS_DIR, params.name) || null
        const workLog = store.readWorkLog(MEMBERS_DIR, params.name, 50)

        return jsonResponse(res, 200, {
          ok: true,
          data: {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status,
            persona,
            memory,
            workLog
          }
        })
      }

      // DELETE /api/member/:name — 删除成员
      params = matchRoute('DELETE', '/api/member/:name', method, url)
      if (params) {
        const deleted = store.deleteMember(MEMBERS_DIR, params.name)
        if (!deleted) return jsonResponse(res, 404, { ok: false, error: 'member not found' })
        return jsonResponse(res, 200, { ok: true })
      }

      // PATCH /api/member/:name/profile — 更新 profile
      params = matchRoute('PATCH', '/api/member/:name/profile', method, url)
      if (params) {
        const existing = store.getMember(MEMBERS_DIR, params.name)
        if (!existing) return jsonResponse(res, 404, { ok: false, error: 'member not found' })
        const body = await readBody(req) as Partial<Profile>
        const updated = { ...existing, ...body, name: existing.name, uid: existing.uid }
        store.createMember(MEMBERS_DIR, updated)
        return jsonResponse(res, 200, { ok: true, data: updated })
      }

      // GET /api/member/:name/status — 成员状态
      params = matchRoute('GET', '/api/member/:name/status', method, url)
      if (params) {
        const s = getMemberStatus(params.name)
        if (!s) return jsonResponse(res, 404, { ok: false, error: 'member not found' })
        return jsonResponse(res, 200, { ok: true, data: { name: params.name, status: s.status } })
      }

      // ── Lock routes ──────────────────────────────────────────────────────

      // POST /api/member/:name/lock/acquire
      params = matchRoute('POST', '/api/member/:name/lock/acquire', method, url)
      if (params) {
        const body = await readBody(req) as {
          session_pid?: number; session_start?: string; project?: string; task?: string
        }
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'session_pid, session_start, project, task required' })
        }
        const result = store.acquireLock(MEMBERS_DIR, params.name, body.session_pid, body.session_start, body.project, body.task)
        const status = result.success ? 200 : 409
        return jsonResponse(res, status, { ok: result.success, nonce: result.nonce, error: result.error })
      }

      // POST /api/member/:name/lock/release
      params = matchRoute('POST', '/api/member/:name/lock/release', method, url)
      if (params) {
        const body = await readBody(req) as { nonce?: string }
        if (!body.nonce) return jsonResponse(res, 400, { ok: false, error: 'nonce required' })
        const result = store.releaseLock(MEMBERS_DIR, params.name, body.nonce)
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error })
      }

      // POST /api/member/:name/lock/update
      params = matchRoute('POST', '/api/member/:name/lock/update', method, url)
      if (params) {
        const body = await readBody(req) as { nonce?: string; project?: string; task?: string }
        if (!body.nonce || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'nonce, project, task required' })
        }
        const result = store.updateLock(MEMBERS_DIR, params.name, body.nonce, body.project, body.task)
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error })
      }

      // POST /api/member/:name/lock/takeover
      params = matchRoute('POST', '/api/member/:name/lock/takeover', method, url)
      if (params) {
        const body = await readBody(req) as {
          session_pid?: number; session_start?: string; project?: string; task?: string
        }
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'session_pid, session_start, project, task required' })
        }
        const result = store.takeoverLock(MEMBERS_DIR, params.name, body.session_pid, body.session_start, body.project, body.task)
        const status = result.success ? 200 : 409
        return jsonResponse(res, status, { ok: result.success, nonce: result.nonce, error: result.error })
      }

      // POST /api/member/:name/lock/force-release
      params = matchRoute('POST', '/api/member/:name/lock/force-release', method, url)
      if (params) {
        const result = store.forceReleaseLock(MEMBERS_DIR, params.name)
        return jsonResponse(res, result.success ? 200 : 404, { ok: result.success, error: result.error })
      }

      // GET /api/member/:name/lock
      params = matchRoute('GET', '/api/member/:name/lock', method, url)
      if (params) {
        const lock = store.readLock(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true, data: lock })
      }

      // ── Heartbeat routes ─────────────────────────────────────────────────

      // POST /api/member/:name/heartbeat
      params = matchRoute('POST', '/api/member/:name/heartbeat', method, url)
      if (params) {
        const body = await readBody(req) as { session_pid?: number; last_tool?: string }
        if (!body.session_pid || !body.last_tool) {
          return jsonResponse(res, 400, { ok: false, error: 'session_pid, last_tool required' })
        }
        store.touchHeartbeat(MEMBERS_DIR, params.name, body.session_pid, body.last_tool)
        return jsonResponse(res, 200, { ok: true })
      }

      // GET /api/member/:name/heartbeat
      params = matchRoute('GET', '/api/member/:name/heartbeat', method, url)
      if (params) {
        const hb = store.readHeartbeat(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true, data: hb })
      }

      // DELETE /api/member/:name/heartbeat
      params = matchRoute('DELETE', '/api/member/:name/heartbeat', method, url)
      if (params) {
        store.removeHeartbeat(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true })
      }

      // GET /api/heartbeat/stale
      if (method === 'GET' && url.split('?')[0] === '/api/heartbeat/stale') {
        const stale = store.scanStaleHeartbeats(MEMBERS_DIR)
        return jsonResponse(res, 200, { ok: true, data: stale })
      }

      // ── Reservation routes ───────────────────────────────────────────────

      // POST /api/member/:name/reservation
      params = matchRoute('POST', '/api/member/:name/reservation', method, url)
      if (params) {
        const body = await readBody(req) as Partial<Reservation>
        if (!body.code || !body.caller || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'code, caller, project, task required' })
        }
        const reservation: Reservation = {
          code: body.code,
          member: body.member ?? params.name,
          caller: body.caller,
          project: body.project,
          task: body.task,
          session_id: body.session_id ?? '',
          created_at: body.created_at ?? Date.now(),
          ttl_ms: body.ttl_ms ?? 210_000
        }
        store.writeReservation(MEMBERS_DIR, params.name, reservation)
        return jsonResponse(res, 200, { ok: true, data: reservation })
      }

      // GET /api/member/:name/reservation
      params = matchRoute('GET', '/api/member/:name/reservation', method, url)
      if (params) {
        const reservation = store.readReservation(MEMBERS_DIR, params.name)
        // TTL check
        if (reservation && Date.now() - reservation.created_at > reservation.ttl_ms) {
          store.deleteReservation(MEMBERS_DIR, params.name)
          return jsonResponse(res, 200, { ok: true, data: null })
        }
        return jsonResponse(res, 200, { ok: true, data: reservation })
      }

      // DELETE /api/member/:name/reservation
      params = matchRoute('DELETE', '/api/member/:name/reservation', method, url)
      if (params) {
        store.deleteReservation(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true })
      }

      // ── Memory routes ────────────────────────────────────────────────────

      // POST /api/member/:name/memory/save
      params = matchRoute('POST', '/api/member/:name/memory/save', method, url)
      if (params) {
        const body = await readBody(req) as { scope?: string; content?: string; project?: string }
        if (!body.content) {
          return jsonResponse(res, 400, { ok: false, error: 'content required' })
        }
        const scope = (body.scope === 'project' ? 'project' : 'generic') as 'generic' | 'project'
        store.saveMemory(MEMBERS_DIR, params.name, scope, body.content, body.project)
        return jsonResponse(res, 200, { ok: true })
      }

      // GET /api/member/:name/memory
      params = matchRoute('GET', '/api/member/:name/memory', method, url)
      if (params) {
        const query = parseQuery(url)
        const memScope = query.scope === 'project' ? 'project' as const : query.scope === 'generic' ? 'generic' as const : undefined
        const content = store.readMemory(MEMBERS_DIR, params.name, memScope, query.project)
        return jsonResponse(res, 200, { ok: true, data: content || null })
      }

      // GET /api/member/:name/persona
      params = matchRoute('GET', '/api/member/:name/persona', method, url)
      if (params) {
        const content = store.readPersona(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true, data: content || null })
      }

      // ── WorkLog routes ───────────────────────────────────────────────────

      // POST /api/member/:name/worklog
      params = matchRoute('POST', '/api/member/:name/worklog', method, url)
      if (params) {
        const body = await readBody(req) as WorkLogEntry
        if (!body.event || !body.timestamp || !body.project) {
          return jsonResponse(res, 400, { ok: false, error: 'event, timestamp, project required' })
        }
        store.appendWorkLog(MEMBERS_DIR, params.name, body)
        return jsonResponse(res, 200, { ok: true })
      }

      // GET /api/member/:name/worklog
      params = matchRoute('GET', '/api/member/:name/worklog', method, url)
      if (params) {
        const query = parseQuery(url)
        const limit = query.limit ? parseInt(query.limit, 10) : undefined
        const entries = store.readWorkLog(MEMBERS_DIR, params.name, limit)
        return jsonResponse(res, 200, { ok: true, data: entries })
      }

      // POST /api/member/:name/evaluate — 追加评价记录
      params = matchRoute('POST', '/api/member/:name/evaluate', method, url)
      if (params) {
        const body = await readBody(req) as { content?: string }
        if (!body.content) {
          return jsonResponse(res, 400, { ok: false, error: 'content required' })
        }
        mkdirSync(join(MEMBERS_DIR, params.name), { recursive: true })
        appendFileSync(join(MEMBERS_DIR, params.name, 'evaluations.md'), body.content + '\n', 'utf-8')
        return jsonResponse(res, 200, { ok: true })
      }

      // ── Shared Experience routes ─────────────────────────────────────────

      // POST /api/shared/experience
      if (method === 'POST' && url === '/api/shared/experience') {
        const body = await readBody(req) as {
          member?: string; scope?: string; content?: string; project?: string
        }
        if (!body.member || !body.content) {
          return jsonResponse(res, 400, { ok: false, error: 'member, content required' })
        }
        mkdirSync(SHARED_DIR, { recursive: true })
        const scope = body.scope ?? 'generic'
        if (scope === 'team') {
          // 提交到 pending rules
          const pendingPath = join(SHARED_DIR, 'pending_rules.json')
          let pending: unknown[] = []
          try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) } catch { /* empty */ }
          pending.push({
            id: `rule_${Date.now()}`,
            member: body.member,
            rule: body.content,
            reason: '',
            proposed_at: new Date().toISOString()
          })
          writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf-8')
          return jsonResponse(res, 200, { ok: true, data: { saved: true, similar_lines: [] } })
        }

        const expFile = scope === 'project' && body.project
          ? join(SHARED_DIR, `experience_proj_${body.project}.md`)
          : join(SHARED_DIR, 'experience_generic.md')
        mkdirSync(SHARED_DIR, { recursive: true })
        const header = `\n## [${body.member}] ${new Date().toISOString()}\n`
        appendFileSync(expFile, header + body.content + '\n', 'utf-8')
        return jsonResponse(res, 200, { ok: true, data: { saved: true } })
      }

      // GET /api/shared/experience
      if (method === 'GET' && url.split('?')[0] === '/api/shared/experience') {
        const query = parseQuery(url)
        const scope = query.scope
        const project = query.project
        let content = ''
        if (!scope || scope === 'generic') {
          content = safeReadFile(join(SHARED_DIR, 'experience_generic.md'))
          if (project) {
            const projExp = safeReadFile(join(SHARED_DIR, `experience_proj_${project}.md`))
            if (projExp) content = [content, projExp].filter(Boolean).join('\n\n---\n\n')
          }
        } else if (scope === 'project' && project) {
          content = safeReadFile(join(SHARED_DIR, `experience_proj_${project}.md`))
        }
        return jsonResponse(res, 200, { ok: true, data: content || null })
      }

      // GET /api/shared/experience/search
      if (method === 'GET' && url.split('?')[0] === '/api/shared/experience/search') {
        const query = parseQuery(url)
        if (!query.keyword) {
          return jsonResponse(res, 400, { ok: false, error: 'keyword required' })
        }
        const files: string[] = []
        if (existsSync(SHARED_DIR)) {
          const allFiles = readdirSync(SHARED_DIR).filter((f) => f.startsWith('experience_'))
          files.push(...allFiles.map((f) => join(SHARED_DIR, f)))
        }
        const lowerKw = query.keyword.toLowerCase()
        const hits: { line: string; source: string }[] = []
        const seen = new Set<string>()
        for (const filePath of files) {
          const content = safeReadFile(filePath)
          if (!content) continue
          const source = filePath.split('/').pop()!
          for (const line of content.split('\n')) {
            if (line.toLowerCase().includes(lowerKw)) {
              const trimmed = line.trim()
              if (trimmed && !seen.has(trimmed)) {
                seen.add(trimmed)
                hits.push({ line: trimmed, source })
              }
            }
          }
        }
        return jsonResponse(res, 200, { ok: true, data: hits })
      }

      // ── Rules routes ─────────────────────────────────────────────────────

      // GET /api/shared/rules
      if (method === 'GET' && url === '/api/shared/rules') {
        const content = safeReadFile(join(SHARED_DIR, 'rules.md'))
        return jsonResponse(res, 200, { ok: true, data: content || null })
      }

      // POST /api/shared/rules/propose
      if (method === 'POST' && url === '/api/shared/rules/propose') {
        const body = await readBody(req) as { member?: string; rule?: string; reason?: string }
        if (!body.member || !body.rule) {
          return jsonResponse(res, 400, { ok: false, error: 'member, rule required' })
        }
        mkdirSync(SHARED_DIR, { recursive: true })
        const pendingPath = join(SHARED_DIR, 'pending_rules.json')
        let pending: unknown[] = []
        try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) } catch { /* empty */ }
        const newRule = {
          id: `rule_${Date.now()}`,
          member: body.member,
          rule: body.rule,
          reason: body.reason ?? '',
          proposed_at: new Date().toISOString()
        }
        pending.push(newRule)
        writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf-8')
        return jsonResponse(res, 200, { ok: true, data: newRule })
      }

      // GET /api/shared/rules/pending
      if (method === 'GET' && url === '/api/shared/rules/pending') {
        const pendingPath = join(SHARED_DIR, 'pending_rules.json')
        let pending: unknown[] = []
        try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) } catch { /* empty */ }
        return jsonResponse(res, 200, { ok: true, data: pending })
      }

      // POST /api/shared/rules/approve
      if (method === 'POST' && url === '/api/shared/rules/approve') {
        const body = await readBody(req) as { id?: string }
        if (!body.id) return jsonResponse(res, 400, { ok: false, error: 'id required' })
        mkdirSync(SHARED_DIR, { recursive: true })
        const pendingPath = join(SHARED_DIR, 'pending_rules.json')
        let pending: { id: string; rule: string; member: string; reason: string }[] = []
        try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) } catch { /* empty */ }
        const idx = pending.findIndex((r) => r.id === body.id)
        if (idx === -1) return jsonResponse(res, 404, { ok: false, error: 'rule not found' })
        const [approved] = pending.splice(idx, 1)
        writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf-8')
        // Append to rules.md
        const rulesPath = join(SHARED_DIR, 'rules.md')
        appendFileSync(rulesPath, `\n- ${approved.rule} (by ${approved.member})\n`, 'utf-8')
        return jsonResponse(res, 200, { ok: true, data: approved })
      }

      // POST /api/shared/rules/reject
      if (method === 'POST' && url === '/api/shared/rules/reject') {
        const body = await readBody(req) as { id?: string }
        if (!body.id) return jsonResponse(res, 400, { ok: false, error: 'id required' })
        const pendingPath = join(SHARED_DIR, 'pending_rules.json')
        let pending: { id: string }[] = []
        try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) } catch { /* empty */ }
        const idx = pending.findIndex((r) => r.id === body.id)
        if (idx === -1) return jsonResponse(res, 404, { ok: false, error: 'rule not found' })
        const [rejected] = pending.splice(idx, 1)
        writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf-8')
        return jsonResponse(res, 200, { ok: true, data: rejected })
      }

      // GET /api/shared/governance
      if (method === 'GET' && url === '/api/shared/governance') {
        const content = readJsonFile<unknown>(join(SHARED_DIR, 'governance.json'))
        return jsonResponse(res, 200, { ok: true, data: content })
      }

      // ════════════════════════════════════════════════════════════════════════
      // REST API — /api/members/* (canonical routes for hub.ts HTTP proxy)
      // ════════════════════════════════════════════════════════════════════════

      // GET /api/members — list all members with status
      if (method === 'GET' && url.split('?')[0] === '/api/members') {
        const profiles = store.listMembers(MEMBERS_DIR)
        const members = profiles.map((p) => {
          const s = getMemberStatus(p.name)
          return s ? {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status
          } : { ...p, status: 'offline' as const }
        })
        return jsonResponse(res, 200, { ok: true, data: members })
      }

      // POST /api/members — create/save profile
      if (method === 'POST' && url === '/api/members') {
        const body = await readBody(req) as Partial<Profile>
        if (!body.name || !body.role) {
          return jsonResponse(res, 400, { ok: false, error: 'name, role are required' })
        }
        const existing = store.getMember(MEMBERS_DIR, body.name)
        if (existing) {
          return jsonResponse(res, 409, { ok: false, error: `member ${body.name} already exists` })
        }
        const profile: Profile = {
          uid: body.uid ?? randomUUID(),
          name: body.name,
          role: body.role,
          type: body.type ?? 'temporary',
          joined_at: body.joined_at ?? new Date().toISOString(),
          skills: body.skills,
          description: body.description
        }
        store.createMember(MEMBERS_DIR, profile)
        return jsonResponse(res, 201, { ok: true, data: profile })
      }

      // POST /api/members/scan-orphan-locks
      if (method === 'POST' && url === '/api/members/scan-orphan-locks') {
        const cleaned = store.scanOrphanLocks(MEMBERS_DIR)
        return jsonResponse(res, 200, { ok: true, data: cleaned })
      }

      // POST /api/members/scan-stale-heartbeats
      if (method === 'POST' && url.split('?')[0] === '/api/members/scan-stale-heartbeats') {
        const query = parseQuery(url)
        const timeoutMs = query.timeout_ms ? parseInt(query.timeout_ms, 10) : undefined
        const stale = store.scanStaleHeartbeats(MEMBERS_DIR, timeoutMs)
        return jsonResponse(res, 200, { ok: true, data: stale })
      }

      // GET /api/members/:name — single member status
      params = matchRoute('GET', '/api/members/:name', method, url)
      if (params) {
        const s = getMemberStatus(params.name)
        if (!s) return jsonResponse(res, 404, { ok: false, error: 'member not found' })
        return jsonResponse(res, 200, {
          ok: true,
          data: {
            ...s.profile,
            lock: s.lock,
            heartbeat: s.heartbeat,
            reservation: s.reservation,
            status: s.status
          }
        })
      }

      // DELETE /api/members/:name — delete member
      params = matchRoute('DELETE', '/api/members/:name', method, url)
      if (params) {
        const deleted = store.deleteMember(MEMBERS_DIR, params.name)
        if (!deleted) return jsonResponse(res, 404, { ok: false, error: 'member not found' })
        return jsonResponse(res, 200, { ok: true })
      }

      // ── /api/members/:name/lock ──────────────────────────────────────────

      // GET /api/members/:name/lock
      params = matchRoute('GET', '/api/members/:name/lock', method, url)
      if (params) {
        const lock = store.readLock(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true, data: lock })
      }

      // POST /api/members/:name/lock/acquire
      params = matchRoute('POST', '/api/members/:name/lock/acquire', method, url)
      if (params) {
        const body = await readBody(req) as {
          session_pid?: number; session_start?: string; project?: string; task?: string
        }
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'session_pid, session_start, project, task required' })
        }
        const result = store.acquireLock(MEMBERS_DIR, params.name, body.session_pid, body.session_start, body.project, body.task)
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, nonce: result.nonce, error: result.error })
      }

      // POST /api/members/:name/lock/release
      params = matchRoute('POST', '/api/members/:name/lock/release', method, url)
      if (params) {
        const body = await readBody(req) as { nonce?: string }
        if (!body.nonce) return jsonResponse(res, 400, { ok: false, error: 'nonce required' })
        const result = store.releaseLock(MEMBERS_DIR, params.name, body.nonce)
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error })
      }

      // POST /api/members/:name/lock/force-release
      params = matchRoute('POST', '/api/members/:name/lock/force-release', method, url)
      if (params) {
        const result = store.forceReleaseLock(MEMBERS_DIR, params.name)
        return jsonResponse(res, result.success ? 200 : 404, { ok: result.success, error: result.error })
      }

      // POST /api/members/:name/lock/update
      params = matchRoute('POST', '/api/members/:name/lock/update', method, url)
      if (params) {
        const body = await readBody(req) as { nonce?: string; project?: string; task?: string }
        if (!body.nonce || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'nonce, project, task required' })
        }
        const result = store.updateLock(MEMBERS_DIR, params.name, body.nonce, body.project, body.task)
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, error: result.error })
      }

      // POST /api/members/:name/lock/takeover
      params = matchRoute('POST', '/api/members/:name/lock/takeover', method, url)
      if (params) {
        const body = await readBody(req) as {
          session_pid?: number; session_start?: string; project?: string; task?: string
        }
        if (!body.session_pid || !body.session_start || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'session_pid, session_start, project, task required' })
        }
        const result = store.takeoverLock(MEMBERS_DIR, params.name, body.session_pid, body.session_start, body.project, body.task)
        return jsonResponse(res, result.success ? 200 : 409, { ok: result.success, nonce: result.nonce, error: result.error })
      }

      // ── /api/members/:name/heartbeat ─────────────────────────────────────

      // POST /api/members/:name/heartbeat
      params = matchRoute('POST', '/api/members/:name/heartbeat', method, url)
      if (params) {
        const body = await readBody(req) as { session_pid?: number; last_tool?: string }
        if (!body.session_pid || !body.last_tool) {
          return jsonResponse(res, 400, { ok: false, error: 'session_pid, last_tool required' })
        }
        store.touchHeartbeat(MEMBERS_DIR, params.name, body.session_pid, body.last_tool)
        return jsonResponse(res, 200, { ok: true })
      }

      // GET /api/members/:name/heartbeat
      params = matchRoute('GET', '/api/members/:name/heartbeat', method, url)
      if (params) {
        const hb = store.readHeartbeat(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true, data: hb })
      }

      // DELETE /api/members/:name/heartbeat
      params = matchRoute('DELETE', '/api/members/:name/heartbeat', method, url)
      if (params) {
        store.removeHeartbeat(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true })
      }

      // ── /api/members/:name/reservation ───────────────────────────────────

      // GET /api/members/:name/reservation
      params = matchRoute('GET', '/api/members/:name/reservation', method, url)
      if (params) {
        const reservation = store.readReservation(MEMBERS_DIR, params.name)
        if (reservation && Date.now() - reservation.created_at > reservation.ttl_ms) {
          store.deleteReservation(MEMBERS_DIR, params.name)
          return jsonResponse(res, 200, { ok: true, data: null })
        }
        return jsonResponse(res, 200, { ok: true, data: reservation })
      }

      // POST /api/members/:name/reservation
      params = matchRoute('POST', '/api/members/:name/reservation', method, url)
      if (params) {
        const body = await readBody(req) as Partial<Reservation>
        if (!body.code || !body.caller || !body.project || !body.task) {
          return jsonResponse(res, 400, { ok: false, error: 'code, caller, project, task required' })
        }
        const reservation: Reservation = {
          code: body.code,
          member: body.member ?? params.name,
          session_id: body.session_id ?? '',
          caller: body.caller,
          project: body.project,
          task: body.task,
          created_at: body.created_at ?? Date.now(),
          ttl_ms: body.ttl_ms ?? 210_000
        }
        store.writeReservation(MEMBERS_DIR, params.name, reservation)
        return jsonResponse(res, 200, { ok: true, data: reservation })
      }

      // DELETE /api/members/:name/reservation
      params = matchRoute('DELETE', '/api/members/:name/reservation', method, url)
      if (params) {
        store.deleteReservation(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true })
      }

      // ── /api/members/:name/memory ────────────────────────────────────────

      // GET /api/members/:name/memory
      params = matchRoute('GET', '/api/members/:name/memory', method, url)
      if (params) {
        const query = parseQuery(url)
        const memScope = query.scope === 'project' ? 'project' as const : query.scope === 'generic' ? 'generic' as const : undefined
        const content = store.readMemory(MEMBERS_DIR, params.name, memScope, query.project)
        return jsonResponse(res, 200, { ok: true, data: content || null })
      }

      // POST /api/members/:name/memory
      params = matchRoute('POST', '/api/members/:name/memory', method, url)
      if (params) {
        const body = await readBody(req) as { scope?: string; content?: string; project?: string }
        if (!body.content) {
          return jsonResponse(res, 400, { ok: false, error: 'content required' })
        }
        const scope = (body.scope === 'project' ? 'project' : 'generic') as 'generic' | 'project'
        store.saveMemory(MEMBERS_DIR, params.name, scope, body.content, body.project)
        return jsonResponse(res, 200, { ok: true })
      }

      // ── /api/members/:name/persona ───────────────────────────────────────

      // GET /api/members/:name/persona
      params = matchRoute('GET', '/api/members/:name/persona', method, url)
      if (params) {
        const content = store.readPersona(MEMBERS_DIR, params.name)
        return jsonResponse(res, 200, { ok: true, data: content || null })
      }

      // ── /api/members/:name/worklog ───────────────────────────────────────

      // GET /api/members/:name/worklog
      params = matchRoute('GET', '/api/members/:name/worklog', method, url)
      if (params) {
        const query = parseQuery(url)
        const limit = query.limit ? parseInt(query.limit, 10) : undefined
        const entries = store.readWorkLog(MEMBERS_DIR, params.name, limit)
        return jsonResponse(res, 200, { ok: true, data: entries })
      }

      // POST /api/members/:name/worklog
      params = matchRoute('POST', '/api/members/:name/worklog', method, url)
      if (params) {
        const body = await readBody(req) as WorkLogEntry
        if (!body.event || !body.timestamp || !body.project) {
          return jsonResponse(res, 400, { ok: false, error: 'event, timestamp, project required' })
        }
        store.appendWorkLog(MEMBERS_DIR, params.name, body)
        return jsonResponse(res, 200, { ok: true })
      }

      // ════════════════════════════════════════════════════════════════════════
      // Ask User API — synchronous blocking endpoint
      // ════════════════════════════════════════════════════════════════════════
      // Vault Routes — API Key management and proxying
      // ════════════════════════════════════════════════════════════════════════

      // POST /api/vault/proxy — Forward API request with key injection
      if (method === 'POST' && url === '/api/vault/proxy') {
        const body = await readBody(req) as {
          session_id?: string
          api_name?: string
          url?: string
          method?: string
          headers?: Record<string, string>
          body?: string
        }

        // Session validation
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: 'session_id is required' })
        }
        const session = getSessionByMemberId(body.session_id)
        if (!session) {
          return jsonResponse(res, 401, { error: 'invalid session_id' })
        }

        // Validate required params
        if (!body.api_name || !body.url || !body.method) {
          return jsonResponse(res, 400, { error: 'api_name, url, method are required' })
        }

        // Proxy the request
        const proxyResult = await proxyApiRequest({
          api_name: body.api_name,
          url: body.url,
          method: body.method,
          headers: body.headers,
          body: body.body,
        })

        if ('error' in proxyResult) {
          return jsonResponse(res, 400, proxyResult)
        }

        // Return proxied response
        const responseBody = JSON.stringify({
          status: proxyResult.status,
          headers: proxyResult.headers,
          body: proxyResult.body,
        })
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(responseBody)
        })
        res.end(responseBody)
      }

      // GET /api/vault/list — List available API keys
      if (method === 'GET' && url === '/api/vault/list') {
        const query = parseQuery(url)
        const sessionId = query.session_id

        // Session validation
        if (!sessionId) {
          return jsonResponse(res, 400, { error: 'session_id query param is required' })
        }
        const session = getSessionByMemberId(sessionId)
        if (!session) {
          return jsonResponse(res, 401, { error: 'invalid session_id' })
        }

        // List keys (only names, not values)
        const keys = listApiKeys()
        return jsonResponse(res, 200, { keys })
      }

      // POST /api/vault/add — Add API key
      if (method === 'POST' && url === '/api/vault/add') {
        const body = await readBody(req) as {
          session_id?: string
          api_name?: string
          value?: string
        }

        // Session validation
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: 'session_id is required' })
        }
        const session = getSessionByMemberId(body.session_id)
        if (!session) {
          return jsonResponse(res, 401, { error: 'invalid session_id' })
        }

        // Validate params
        if (!body.api_name || !body.value) {
          return jsonResponse(res, 400, { error: 'api_name and value are required' })
        }

        // Add key
        const result = addApiKey(body.api_name, body.value)
        if (!result.success) {
          return jsonResponse(res, 400, { error: result.error ?? 'failed to add key' })
        }

        return jsonResponse(res, 200, { success: true, display_hint: result.display_hint, message: `Key for ${body.api_name} added` })
      }

      // DELETE /api/vault/remove — Remove API key
      if (method === 'DELETE' && url.split('?')[0] === '/api/vault/remove') {
        const body = await readBody(req) as {
          session_id?: string
          api_name?: string
        }

        // Session validation
        if (!body.session_id) {
          return jsonResponse(res, 400, { error: 'session_id is required' })
        }
        const session = getSessionByMemberId(body.session_id)
        if (!session) {
          return jsonResponse(res, 401, { error: 'invalid session_id' })
        }

        // Validate params
        if (!body.api_name) {
          return jsonResponse(res, 400, { error: 'api_name is required' })
        }

        // Remove key
        const result = removeApiKey(body.api_name)
        if (!result.success) {
          return jsonResponse(res, 400, { error: result.error ?? 'failed to remove key' })
        }

        return jsonResponse(res, 200, { success: true, message: `Key for ${body.api_name} removed` })
      }

      // ════════════════════════════════════════════════════════════════════════

      // POST /api/ask-user — create a popup, block until user answers or timeout
      if (method === 'POST' && url === '/api/ask-user') {
        const body = await readBody(req) as {
          member_name?: string
          type?: string
          title?: string
          question?: string
          options?: string[]
          timeout_ms?: number
        }
        if (!body.member_name || !body.type || !body.title || !body.question) {
          return jsonResponse(res, 400, { error: 'member_name, type, title, question are required' })
        }
        const validTypes: AskUserType[] = ['confirm', 'single_choice', 'multi_choice', 'input']
        if (!validTypes.includes(body.type as AskUserType)) {
          return jsonResponse(res, 400, { error: `type must be one of: ${validTypes.join(', ')}` })
        }
        if ((body.type === 'single_choice' || body.type === 'multi_choice') && (!body.options || body.options.length === 0)) {
          return jsonResponse(res, 400, { error: 'options are required for single_choice/multi_choice types' })
        }

        // This blocks until user responds or timeout
        const response = await createAskUserRequest({
          member_name: body.member_name,
          type: body.type as AskUserType,
          title: body.title,
          question: body.question,
          options: body.options,
          timeout_ms: body.timeout_ms,
        })

        return jsonResponse(res, 200, response)
      }

      return jsonResponse(res, 404, { error: 'not found' })
    } catch (err) {
      return jsonResponse(res, 500, { error: String(err) })
    }
  })

  panelServer.listen(0, PANEL_HOST, () => {
    const addr = panelServer!.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      writeFileSync(PANEL_PORT_FILE, String(port), 'utf-8')
    } catch { /* ignore */ }
    process.stderr.write(`[panel-api] started on ${PANEL_HOST}:${port}\n`)
  })
}

export function stopPanelApi(): void {
  if (panelServer) {
    panelServer.close()
    panelServer = null
  }
  try {
    rmSync(PANEL_PORT_FILE, { force: true })
  } catch { /* ignore */ }
}
