/**
 * API Registry — Metadata for known and custom APIs
 *
 * Manages API definitions: base URL, auth type, auth header, prefix.
 * Presets for OpenAI/Anthropic/Google are built-in and cannot be removed.
 * Custom APIs are persisted to ~/.claude/team-hub/api-registry.json.
 */

import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApiDefinition {
  name: string
  base_url: string
  auth_type: 'bearer' | 'custom' | 'query_param'
  auth_header: string
  auth_prefix?: string   // e.g. "Bearer " for bearer type
  description?: string
  is_preset: boolean     // true for built-in, false for user-added
}

// ── Constants ────────────────────────────────────────────────────────────────

const TEAM_HUB_DIR = join(
  process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp',
  '.claude',
  'team-hub'
)
const REGISTRY_PATH = join(TEAM_HUB_DIR, 'api-registry.json')

// ── Presets ──────────────────────────────────────────────────────────────────

const PRESETS: ApiDefinition[] = [
  {
    name: 'openai',
    base_url: 'https://api.openai.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    auth_prefix: 'Bearer ',
    description: 'OpenAI API (GPT, DALL-E, Whisper, Embeddings)',
    is_preset: true,
  },
  {
    name: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth_type: 'custom',
    auth_header: 'x-api-key',
    description: 'Anthropic API (Claude models)',
    is_preset: true,
  },
  {
    name: 'google',
    base_url: 'https://generativelanguage.googleapis.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    auth_prefix: 'Bearer ',
    description: 'Google Generative AI API (Gemini)',
    is_preset: true,
  },
  {
    name: 'github',
    base_url: 'https://api.github.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    auth_prefix: 'Bearer ',
    description: 'GitHub REST API',
    is_preset: true,
  },
]

// ── ApiRegistry Class ────────────────────────────────────────────────────────

class ApiRegistry {
  private customApis: Map<string, ApiDefinition> = new Map()
  private loaded = false

  /**
   * Get an API definition by name. Checks presets first, then custom.
   */
  get(name: string): ApiDefinition | null {
    this.ensureLoaded()
    const preset = PRESETS.find((p) => p.name === name)
    if (preset) return preset
    return this.customApis.get(name) ?? null
  }

  /**
   * List all registered APIs (presets + custom).
   */
  list(): ApiDefinition[] {
    this.ensureLoaded()
    return [...PRESETS, ...Array.from(this.customApis.values())]
  }

  /**
   * Register a custom API definition.
   * Cannot overwrite presets.
   */
  register(def: Omit<ApiDefinition, 'is_preset'>): { success: boolean; error?: string } {
    this.ensureLoaded()

    if (PRESETS.some((p) => p.name === def.name)) {
      return { success: false, error: `Cannot overwrite preset API '${def.name}'.` }
    }

    if (!def.name || !def.base_url || !def.auth_type || !def.auth_header) {
      return { success: false, error: 'Missing required fields: name, base_url, auth_type, auth_header.' }
    }

    // Validate base_url format
    try {
      new URL(def.base_url)
    } catch {
      return { success: false, error: `Invalid base_url: '${def.base_url}'.` }
    }

    this.customApis.set(def.name, { ...def, is_preset: false })
    this.persist()
    return { success: true }
  }

  /**
   * Remove a custom API definition.
   * Cannot remove presets.
   */
  unregister(name: string): { success: boolean; error?: string } {
    this.ensureLoaded()

    if (PRESETS.some((p) => p.name === name)) {
      return { success: false, error: `Cannot remove preset API '${name}'.` }
    }

    if (!this.customApis.has(name)) {
      return { success: false, error: `Custom API '${name}' not found.` }
    }

    this.customApis.delete(name)
    this.persist()
    return { success: true }
  }

  /**
   * Validate that a URL is allowed for the given API (must start with base_url).
   */
  validateUrl(apiName: string, url: string): boolean {
    const def = this.get(apiName)
    if (!def) return false

    try {
      const parsed = new URL(url)
      const base = new URL(def.base_url)
      return parsed.origin === base.origin && parsed.pathname.startsWith(base.pathname)
    } catch {
      return false
    }
  }

  /**
   * Build the auth header value for a given API and key.
   */
  buildAuthValue(apiName: string, key: string): { header: string; value: string } | null {
    const def = this.get(apiName)
    if (!def) return null

    const value = def.auth_prefix ? `${def.auth_prefix}${key}` : key
    return { header: def.auth_header, value }
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true

    try {
      if (!existsSync(REGISTRY_PATH)) return
      const raw = readFileSync(REGISTRY_PATH, 'utf-8')
      const data = JSON.parse(raw) as Array<Omit<ApiDefinition, 'is_preset'>>
      for (const def of data) {
        // Skip if it conflicts with a preset
        if (!PRESETS.some((p) => p.name === def.name)) {
          this.customApis.set(def.name, { ...def, is_preset: false })
        }
      }
    } catch {
      // Corrupted file -- start fresh
      this.customApis.clear()
    }
  }

  private persist(): void {
    try {
      mkdirSync(TEAM_HUB_DIR, { recursive: true })
      const data = Array.from(this.customApis.values()).map(({ is_preset: _, ...rest }) => rest)
      writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error('[api-registry] Failed to persist:', err)
    }
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────────

export const apiRegistry = new ApiRegistry()

// Re-export for backward compatibility and direct use
export { REGISTRY_PATH, PRESETS }
