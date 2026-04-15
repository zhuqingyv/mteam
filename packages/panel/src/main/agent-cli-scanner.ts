import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentCli {
  name: string
  bin: string
  version: string
  status: 'found' | 'no_permission'
}

export interface ScanResult {
  found: AgentCli[]
  not_found: string[]
  scannedAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_CLI_NAMES = ['claude', 'chatgpt', 'gemini', 'aider', 'cursor']
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_PATH = join(homedir(), '.claude', 'team-hub', 'agent_clis.json')
const WHICH_TIMEOUT_MS = 3000
const VERSION_TIMEOUT_MS = 5000

// ── Helpers ───────────────────────────────────────────────────────────────────

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null)
      } else {
        resolve(stdout.trim())
      }
    })
    child.on('error', () => resolve(null))
  })
}

async function whichBin(name: string): Promise<string | null> {
  return runCommand('which', [name], WHICH_TIMEOUT_MS)
}

async function getVersion(bin: string): Promise<string | null> {
  return runCommand(bin, ['--version'], VERSION_TIMEOUT_MS)
}

function extractVersion(raw: string | null): string {
  if (!raw) return 'unknown'
  // Try to extract semver-like pattern e.g. "1.2.3" or "v1.2.3"
  const match = raw.match(/v?(\d+\.\d+[\.\d]*)/)
  return match ? match[1] : raw.split('\n')[0].trim() || 'unknown'
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheFile {
  result: ScanResult
  cachedAt: number
}

function readCache(): ScanResult | null {
  try {
    const raw = readFileSync(CACHE_PATH, 'utf-8')
    const cache = JSON.parse(raw) as CacheFile
    if (
      typeof cache.cachedAt !== 'number' ||
      !cache.result ||
      !Array.isArray(cache.result.found) ||
      !Array.isArray(cache.result.not_found)
    ) {
      return null
    }
    if (Date.now() - cache.cachedAt > CACHE_TTL_MS) return null
    return cache.result
  } catch {
    return null
  }
}

function writeCache(result: ScanResult): void {
  try {
    const dir = join(homedir(), '.claude', 'team-hub')
    mkdirSync(dir, { recursive: true })
    const cache: CacheFile = { result, cachedAt: Date.now() }
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch {
    // non-fatal: cache write failure is fine
  }
}

// ── Scanner ───────────────────────────────────────────────────────────────────

async function checkPermission(bin: string): Promise<boolean> {
  // Try running with a harmless flag; if EACCES we get no_permission
  return new Promise((resolve) => {
    if (!existsSync(bin)) {
      resolve(true) // bin path is valid, permission unknown until run
      return
    }
    execFile(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'EACCES') {
        resolve(false)
      } else {
        resolve(true)
      }
    })
  })
}

export async function scanAgentClis(force?: boolean): Promise<ScanResult> {
  // Return cached result unless force=true
  if (!force) {
    const cached = readCache()
    if (cached) return cached
  }

  const found: AgentCli[] = []
  const not_found: string[] = []

  await Promise.all(
    AGENT_CLI_NAMES.map(async (name) => {
      const bin = await whichBin(name)
      if (!bin) {
        not_found.push(name)
        return
      }

      // Check permission
      const hasPermission = await checkPermission(bin)
      if (!hasPermission) {
        found.push({ name, bin, version: 'unknown', status: 'no_permission' })
        return
      }

      const versionRaw = await getVersion(bin)
      found.push({
        name,
        bin,
        version: extractVersion(versionRaw),
        status: 'found'
      })
    })
  )

  // Sort consistently by original order
  found.sort((a, b) => AGENT_CLI_NAMES.indexOf(a.name) - AGENT_CLI_NAMES.indexOf(b.name))
  not_found.sort((a, b) => AGENT_CLI_NAMES.indexOf(a) - AGENT_CLI_NAMES.indexOf(b))

  const result: ScanResult = { found, not_found, scannedAt: new Date().toISOString() }
  writeCache(result)
  return result
}
