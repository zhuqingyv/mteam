/**
 * member-store-service.ts — 成员数据的唯一读写层
 *
 * 整合了 member-store、lock-manager、heartbeat、reservation、memory、persona、worklog
 * 所有操作基于可配置的 membersDir / sharedDir 路径，不硬编码。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  linkSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { execSync } from 'node:child_process'

// ── 类型定义 ─────────────────────────────────────────────────────────────────

export type MemberRole = 'leader' | 'dev' | 'qa' | 'pm' | 'infra' | string
export type MemberType = 'permanent' | 'temporary'

export interface Profile {
  uid: string
  name: string
  role: MemberRole
  type: MemberType
  joined_at: string
  skills?: string[]
  description?: string
}

export interface Lock {
  nonce: string
  session_pid: number
  session_start: string
  project: string
  task: string
  locked_at: string
}

export interface Heartbeat {
  last_seen: string
  last_seen_ms: number
  session_pid: number
  last_tool: string
}

export interface Reservation {
  code: string
  member: string
  caller: string
  project: string
  task: string
  session_id: string
  created_at: number
  ttl_ms: number
}

export interface Memory {
  scope: 'generic' | 'project'
  project?: string
  content: string
}

export interface WorkLogEntry {
  event: 'check_in' | 'check_out'
  timestamp: string
  project: string
  task?: string
  note?: string
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function memberDir(membersDir: string, name: string): string {
  return join(membersDir, name)
}

function isProcessAlive(pid: number, sessionStart: string): boolean {
  try {
    execSync(`kill -0 ${pid}`, { stdio: 'pipe' })
    const actualStart = execSync(`ps -p ${pid} -o lstart=`, {
      encoding: 'utf-8'
    }).trim()
    return actualStart === sessionStart
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    if (stderr.includes('Operation not permitted') || stderr.includes('not permitted')) {
      return true
    }
    return false
  }
}

// ── Profile CRUD ─────────────────────────────────────────────────────────────

export function listMembers(membersDir: string): Profile[] {
  if (!existsSync(membersDir)) return []
  const entries = readdirSync(membersDir, { withFileTypes: true })
  const result: Profile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profile = getMember(membersDir, entry.name)
    if (profile) result.push(profile)
  }
  return result
}

export function getMember(membersDir: string, name: string): Profile | null {
  const filePath = join(memberDir(membersDir, name), 'profile.json')
  const profile = safeReadJson<Profile>(filePath)
  if (!profile) return null
  // 自动迁移：老 profile 没有 uid 则生成并回写
  if (!profile.uid) {
    profile.uid = crypto.randomUUID()
    try {
      writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8')
    } catch {
      // 无法写回也不阻塞读
    }
  }
  return profile
}

export function createMember(membersDir: string, profile: Profile): void {
  const dir = memberDir(membersDir, profile.name)
  ensureDir(dir)
  const filePath = join(dir, 'profile.json')
  writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8')
}

export function deleteMember(membersDir: string, name: string): boolean {
  const dir = memberDir(membersDir, name)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

// ── Lock 操作 ────────────────────────────────────────────────────────────────

export function readLock(membersDir: string, name: string): Lock | null {
  return safeReadJson<Lock>(join(memberDir(membersDir, name), 'lock.json'))
}

export function acquireLock(
  membersDir: string,
  name: string,
  sessionPid: number,
  sessionStart: string,
  project: string,
  task: string
): { success: boolean; nonce?: string; error?: string } {
  const dir = memberDir(membersDir, name)
  ensureDir(dir)

  const lockPath = join(dir, 'lock.json')
  const nonce = crypto.randomUUID()
  const tmpPath = join(dir, `lock.tmp.${nonce}`)

  const lockData: Lock = {
    nonce,
    session_pid: sessionPid,
    session_start: sessionStart,
    project,
    task,
    locked_at: new Date().toISOString()
  }

  try {
    writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), 'utf-8')
    try {
      // linkSync: 如果 lockPath 已存在则 EEXIST 失败 — 保证原子性
      linkSync(tmpPath, lockPath)
      unlinkSync(tmpPath)
      return { success: true, nonce }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'EEXIST') {
        return { success: false, error: 'lock already held' }
      }
      throw err
    }
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 已被清理
    }
  }
}

export function releaseLock(
  membersDir: string,
  name: string,
  expectedNonce: string
): { success: boolean; error?: string } {
  const lockPath = join(memberDir(membersDir, name), 'lock.json')
  const lock = safeReadJson<Lock>(lockPath)

  if (!lock) return { success: false, error: 'no lock found' }
  if (lock.nonce !== expectedNonce) return { success: false, error: 'nonce mismatch, not the lock owner' }

  const ts = Date.now()
  const removingPath = `${lockPath}.removing.${ts}`
  try {
    renameSync(lockPath, removingPath)
    unlinkSync(removingPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function forceReleaseLock(
  membersDir: string,
  name: string
): { success: boolean; error?: string } {
  const lockPath = join(memberDir(membersDir, name), 'lock.json')
  if (!existsSync(lockPath)) return { success: false, error: 'no lock found' }

  const ts = Date.now()
  const removingPath = `${lockPath}.removing.${ts}`
  try {
    renameSync(lockPath, removingPath)
    unlinkSync(removingPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function updateLock(
  membersDir: string,
  name: string,
  expectedNonce: string,
  project: string,
  task: string
): { success: boolean; error?: string } {
  const dir = memberDir(membersDir, name)
  const lockPath = join(dir, 'lock.json')
  const existing = safeReadJson<Lock>(lockPath)

  if (!existing) return { success: false, error: 'no lock found' }
  if (existing.nonce !== expectedNonce) return { success: false, error: 'nonce mismatch' }

  const updated: Lock = { ...existing, project, task, locked_at: new Date().toISOString() }
  const tmpPath = join(dir, `lock.tmp.${expectedNonce}`)
  try {
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf-8')
    renameSync(tmpPath, lockPath)
    return { success: true }
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    return { success: false, error: (err as Error).message }
  }
}

export function takeoverLock(
  membersDir: string,
  name: string,
  sessionPid: number,
  sessionStart: string,
  project: string,
  task: string
): { success: boolean; nonce?: string; error?: string } {
  const dir = memberDir(membersDir, name)
  ensureDir(dir)

  const lockPath = join(dir, 'lock.json')
  const existing = safeReadJson<Lock>(lockPath)

  if (!existing) {
    return acquireLock(membersDir, name, sessionPid, sessionStart, project, task)
  }

  if (isProcessAlive(existing.session_pid, existing.session_start)) {
    return { success: false, error: 'lock holder is still alive' }
  }

  const nonce = crypto.randomUUID()
  const tmpPath = join(dir, `lock.tmp.${nonce}`)

  const lockData: Lock = {
    nonce,
    session_pid: sessionPid,
    session_start: sessionStart,
    project,
    task,
    locked_at: new Date().toISOString()
  }

  try {
    writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), 'utf-8')
    renameSync(tmpPath, lockPath)

    // 读回验证 nonce
    const verify = safeReadJson<Lock>(lockPath)
    if (verify?.nonce !== nonce) {
      return { success: false, error: 'nonce mismatch after takeover, race condition' }
    }
    return { success: true, nonce }
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    return { success: false, error: (err as Error).message }
  }
}

export function scanOrphanLocks(membersDir: string): string[] {
  const cleaned: string[] = []
  if (!existsSync(membersDir)) return cleaned

  const entries = readdirSync(membersDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const lockPath = join(membersDir, entry.name, 'lock.json')
    const lock = safeReadJson<Lock>(lockPath)
    if (!lock) continue
    if (!isProcessAlive(lock.session_pid, lock.session_start)) {
      const ts = Date.now()
      const removingPath = `${lockPath}.removing.${ts}`
      try {
        renameSync(lockPath, removingPath)
        unlinkSync(removingPath)
        cleaned.push(entry.name)
      } catch {
        // 并发清理，忽略
      }
    }
  }
  return cleaned
}

// ── Heartbeat 操作 ───────────────────────────────────────────────────────────

export const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000

export function touchHeartbeat(
  membersDir: string,
  name: string,
  sessionPid: number,
  lastTool: string
): void {
  const dir = memberDir(membersDir, name)
  if (!existsSync(dir)) return

  const hbPath = join(dir, 'heartbeat.json')
  const tmpPath = join(dir, `heartbeat.tmp.${sessionPid}`)
  const now = Date.now()

  const data: Heartbeat = {
    last_seen: new Date(now).toISOString(),
    last_seen_ms: now,
    session_pid: sessionPid,
    last_tool: lastTool
  }

  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmpPath, hbPath)
  } catch {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

export function readHeartbeat(membersDir: string, name: string): Heartbeat | null {
  return safeReadJson<Heartbeat>(join(memberDir(membersDir, name), 'heartbeat.json'))
}

export function removeHeartbeat(membersDir: string, name: string): void {
  try {
    unlinkSync(join(memberDir(membersDir, name), 'heartbeat.json'))
  } catch {
    // ENOENT 等，忽略
  }
}

export function isHeartbeatStale(
  membersDir: string,
  name: string,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS
): boolean {
  const hb = readHeartbeat(membersDir, name)
  if (!hb) return false
  return Date.now() - hb.last_seen_ms > timeoutMs
}

export function scanStaleHeartbeats(
  membersDir: string,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS
): string[] {
  const stale: string[] = []
  if (!existsSync(membersDir)) return stale

  const entries = readdirSync(membersDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (isHeartbeatStale(membersDir, entry.name, timeoutMs)) {
      stale.push(entry.name)
    }
  }
  return stale
}

// ── Reservation 操作 ─────────────────────────────────────────────────────────

export function readReservation(membersDir: string, name: string): Reservation | null {
  return safeReadJson<Reservation>(join(memberDir(membersDir, name), 'reservation.json'))
}

export function writeReservation(membersDir: string, name: string, reservation: Reservation): void {
  const dir = memberDir(membersDir, name)
  ensureDir(dir)
  writeFileSync(join(dir, 'reservation.json'), JSON.stringify(reservation, null, 2), 'utf-8')
}

export function deleteReservation(membersDir: string, name: string): void {
  try {
    rmSync(join(memberDir(membersDir, name), 'reservation.json'), { force: true })
  } catch {
    // 忽略
  }
}

// ── Memory 操作 ──────────────────────────────────────────────────────────────

function memoryFilePath(membersDir: string, member: string, scope: 'generic' | 'project', project?: string): string {
  if (scope === 'generic') {
    return join(memberDir(membersDir, member), 'memory_generic.md')
  }
  if (!project) throw new Error('project required for scope=project')
  return join(memberDir(membersDir, member), `memory_proj_${project}.md`)
}

export function readMemory(
  membersDir: string,
  member: string,
  scope?: 'generic' | 'project',
  project?: string
): string {
  if (!scope) {
    // 返回所有记忆
    const generic = safeReadFile(memoryFilePath(membersDir, member, 'generic'))
    const parts = [generic]
    const dir = memberDir(membersDir, member)
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f: string) => f.startsWith('memory_proj_'))
      for (const f of files) {
        parts.push(safeReadFile(join(dir, f)))
      }
    }
    return parts.filter(Boolean).join('\n\n---\n\n')
  }
  return safeReadFile(memoryFilePath(membersDir, member, scope, project))
}

export function saveMemory(
  membersDir: string,
  member: string,
  scope: 'generic' | 'project',
  content: string,
  project?: string
): void {
  const filePath = memoryFilePath(membersDir, member, scope, project)
  ensureDir(dirname(filePath))
  appendFileSync(filePath, content + '\n', 'utf-8')
}

// ── Persona 操作 ─────────────────────────────────────────────────────────────

export function readPersona(membersDir: string, name: string): string {
  const filePath = join(memberDir(membersDir, name), 'persona.md')
  return safeReadFile(filePath)
}

// ── WorkLog 操作 ─────────────────────────────────────────────────────────────

export function appendWorkLog(membersDir: string, name: string, entry: WorkLogEntry): void {
  const dir = memberDir(membersDir, name)
  ensureDir(dir)
  const logPath = join(dir, 'work_log.jsonl')
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8')
}

export function readWorkLog(membersDir: string, name: string, limit?: number): WorkLogEntry[] {
  const logPath = join(memberDir(membersDir, name), 'work_log.jsonl')
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l: string) => l.trim())
  const result: WorkLogEntry[] = []
  for (const line of lines) {
    try {
      result.push(JSON.parse(line) as WorkLogEntry)
    } catch {
      // 跳过损坏行
    }
  }
  if (limit && limit > 0) {
    return result.slice(-limit)
  }
  return result
}

// ── 导出 isProcessAlive（供 Panel 巡检用） ──────────────────────────────────

export { isProcessAlive }
