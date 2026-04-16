/**
 * Vault Manager — Passkey-protected API Key Storage
 *
 * Security model:
 * - Keys encrypted with AES-256-GCM, per-key salt/IV
 * - Master key derived via HKDF from Passkey challenge + machine-bound context
 * - Master key cached in process memory with TTL (never written to disk)
 * - vault.json stored with 0600 permissions
 *
 * Key hierarchy:
 *   Passkey challenge → HKDF → Master Key → HKDF(per-api) → Per-API Key → AES-256-GCM
 */

import { join } from 'node:path'
import { hostname } from 'node:os'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import crypto from 'node:crypto'

// ── Constants ────────────────────────────────────────────────────────────────

const TEAM_HUB_DIR = join(
  process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp',
  '.claude',
  'team-hub'
)
const VAULT_PATH = join(TEAM_HUB_DIR, 'vault.json')
const PASSKEY_PATH = join(TEAM_HUB_DIR, 'passkey.json')

const MASTER_KEY_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MASTER_CHECK_PLAINTEXT = 'team-hub-vault-ok'
const HKDF_MASTER_INFO_PREFIX = 'mcp-team-hub-vault-master'
const HKDF_ENTRY_INFO_PREFIX = 'api-'

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaultEntry {
  salt: string       // hex, 16 bytes
  iv: string         // hex, 12 bytes
  tag: string        // hex, 16 bytes (GCM auth tag)
  ciphertext: string // hex
  created_at: string // ISO 8601
  last_used: string | null
  display_hint: string // last 4 chars of original key
}

export interface VaultData {
  version: number
  master_salt: string        // hex, 16 bytes
  master_check: string       // hex, encrypted known plaintext
  master_check_iv: string    // hex, 12 bytes
  master_check_tag: string   // hex, 16 bytes
  entries: Record<string, VaultEntry>
}

export interface PasskeyCredential {
  credential_id: string    // base64
  public_key: string       // base64 (COSE or SPKI format)
  created_at: string
  rp_id: string
}

export interface VaultKeyInfo {
  name: string
  display_hint: string
  created_at: string
  last_used: string | null
}

// ── Encryption Primitives ────────────────────────────────────────────────────

function deriveMasterKey(challengeB64url: string, masterSalt: Buffer): Buffer {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'none'
  const info = `${HKDF_MASTER_INFO_PREFIX}:${hostname()}:${uid}`
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(challengeB64url, 'base64url'),
      masterSalt,
      Buffer.from(info),
      32
    )
  )
}

function deriveEntryKey(masterKey: Buffer, apiName: string, entrySalt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      masterKey,
      entrySalt,
      Buffer.from(`${HKDF_ENTRY_INFO_PREFIX}${apiName}`),
      32
    )
  )
}

function aesEncrypt(key: Buffer, plaintext: string): { iv: string; tag: string; ciphertext: string } {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  let enc = cipher.update(plaintext, 'utf-8', 'hex')
  enc += cipher.final('hex')
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: enc,
  }
}

function aesDecrypt(key: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'hex')
  )
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  let dec = decipher.update(ciphertext, 'hex', 'utf-8')
  dec += decipher.final('utf-8')
  return dec
}

// ── VaultManager Class ───────────────────────────────────────────────────────

class VaultManager {
  private masterKey: Buffer | null = null
  private masterKeyExpiry = 0

  // ── Passkey Lifecycle ──────────────────────────────────────────────────

  /**
   * Check if passkey has been registered (passkey.json exists)
   */
  isRegistered(): boolean {
    return existsSync(PASSKEY_PATH)
  }

  /**
   * Check if vault is unlocked (master key in memory and not expired)
   */
  isUnlocked(): boolean {
    return this.masterKey !== null && Date.now() < this.masterKeyExpiry
  }

  /**
   * Get vault status string
   */
  getStatus(): 'unregistered' | 'locked' | 'unlocked' {
    if (!this.isRegistered()) return 'unregistered'
    if (this.isUnlocked()) return 'unlocked'
    return 'locked'
  }

  /**
   * Generate a random challenge for WebAuthn registration.
   * Returns base64url-encoded challenge.
   */
  getRegistrationChallenge(): { challenge: string; rp_id: string } {
    const challenge = crypto.randomBytes(32).toString('base64url')
    return { challenge, rp_id: 'mcp-team-hub' }
  }

  /**
   * Complete passkey registration.
   * Stores the credential and initializes an empty vault.
   *
   * @param credentialId - base64 encoded credential ID
   * @param publicKey - base64 encoded public key
   * @param challengeB64url - the original challenge (base64url)
   */
  completeRegistration(
    credentialId: string,
    publicKey: string,
    challengeB64url: string
  ): { success: boolean; error?: string } {
    try {
      mkdirSync(TEAM_HUB_DIR, { recursive: true })

      // Save passkey credential
      const credential: PasskeyCredential = {
        credential_id: credentialId,
        public_key: publicKey,
        created_at: new Date().toISOString(),
        rp_id: 'mcp-team-hub',
      }
      writeFileSync(PASSKEY_PATH, JSON.stringify(credential, null, 2), { mode: 0o600 })

      // Derive master key from challenge
      const masterSalt = crypto.randomBytes(16)
      const mk = deriveMasterKey(challengeB64url, masterSalt)

      // Encrypt the known plaintext as verification check
      const check = aesEncrypt(mk, MASTER_CHECK_PLAINTEXT)

      // Initialize empty vault
      const vault: VaultData = {
        version: 1,
        master_salt: masterSalt.toString('hex'),
        master_check: check.ciphertext,
        master_check_iv: check.iv,
        master_check_tag: check.tag,
        entries: {},
      }
      writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 })

      // Cache master key
      this.masterKey = mk
      this.masterKeyExpiry = Date.now() + MASTER_KEY_TTL_MS

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  /**
   * Generate a random challenge for WebAuthn authentication.
   */
  getAuthenticationChallenge(): { challenge: string; credential_id: string } | { error: string } {
    if (!this.isRegistered()) {
      return { error: 'Passkey not registered. Register first.' }
    }
    const cred = this.loadCredential()
    if (!cred) return { error: 'Failed to load passkey credential.' }

    const challenge = crypto.randomBytes(32).toString('base64url')
    return { challenge, credential_id: cred.credential_id }
  }

  /**
   * Complete authentication: derive master key from challenge, verify against vault check.
   *
   * @param challengeB64url - the challenge that was signed (base64url)
   */
  completeAuthentication(challengeB64url: string): { success: boolean; error?: string } {
    try {
      const vault = this.loadVault()
      if (!vault) return { success: false, error: 'Vault file not found.' }

      const masterSalt = Buffer.from(vault.master_salt, 'hex')
      const mk = deriveMasterKey(challengeB64url, masterSalt)

      // Verify master key by decrypting the check value
      try {
        const decrypted = aesDecrypt(mk, vault.master_check_iv, vault.master_check_tag, vault.master_check)
        if (decrypted !== MASTER_CHECK_PLAINTEXT) {
          return { success: false, error: 'Master key verification failed.' }
        }
      } catch {
        return { success: false, error: 'Invalid passkey or corrupted vault.' }
      }

      // Cache master key
      this.masterKey = mk
      this.masterKeyExpiry = Date.now() + MASTER_KEY_TTL_MS

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  /**
   * Lock the vault: clear master key from memory.
   */
  lock(): void {
    if (this.masterKey) {
      // Overwrite buffer contents before releasing
      this.masterKey.fill(0)
      this.masterKey = null
    }
    this.masterKeyExpiry = 0
  }

  // ── Key CRUD ───────────────────────────────────────────────────────────

  /**
   * Add or update an API key in the vault.
   * Vault must be unlocked.
   */
  addKey(apiName: string, secretValue: string): { success: boolean; display_hint?: string; error?: string } {
    if (!this.isUnlocked()) {
      return { success: false, error: 'Vault is locked. Unlock with passkey first.' }
    }

    try {
      const vault = this.loadVault()
      if (!vault) return { success: false, error: 'Vault file not found.' }

      const entrySalt = crypto.randomBytes(16)
      const entryKey = deriveEntryKey(this.masterKey!, apiName, entrySalt)
      const encrypted = aesEncrypt(entryKey, secretValue)

      const displayHint = secretValue.length >= 4
        ? `...${secretValue.slice(-4)}`
        : '****'

      vault.entries[apiName] = {
        salt: entrySalt.toString('hex'),
        iv: encrypted.iv,
        tag: encrypted.tag,
        ciphertext: encrypted.ciphertext,
        created_at: new Date().toISOString(),
        last_used: null,
        display_hint: displayHint,
      }

      this.saveVault(vault)
      return { success: true, display_hint: displayHint }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  /**
   * Remove an API key from the vault.
   * Vault must be unlocked.
   */
  removeKey(apiName: string): { success: boolean; error?: string } {
    if (!this.isUnlocked()) {
      return { success: false, error: 'Vault is locked.' }
    }

    try {
      const vault = this.loadVault()
      if (!vault) return { success: false, error: 'Vault file not found.' }

      if (!(apiName in vault.entries)) {
        return { success: false, error: `Key '${apiName}' not found in vault.` }
      }

      delete vault.entries[apiName]
      this.saveVault(vault)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  /**
   * List all key names and metadata (no secrets).
   */
  listKeys(): VaultKeyInfo[] {
    try {
      const vault = this.loadVault()
      if (!vault) return []

      return Object.entries(vault.entries).map(([name, entry]) => ({
        name,
        display_hint: entry.display_hint,
        created_at: entry.created_at,
        last_used: entry.last_used,
      }))
    } catch {
      return []
    }
  }

  /**
   * Decrypt and return an API key. Used internally by api-proxy.
   * Vault must be unlocked. Updates last_used timestamp.
   */
  decryptKey(apiName: string): string | null {
    if (!this.isUnlocked()) return null

    try {
      const vault = this.loadVault()
      if (!vault) return null

      const entry = vault.entries[apiName]
      if (!entry) return null

      const entrySalt = Buffer.from(entry.salt, 'hex')
      const entryKey = deriveEntryKey(this.masterKey!, apiName, entrySalt)
      const plaintext = aesDecrypt(entryKey, entry.iv, entry.tag, entry.ciphertext)

      // Update last_used
      entry.last_used = new Date().toISOString()
      this.saveVault(vault)

      return plaintext
    } catch {
      return null
    }
  }

  /**
   * Check if a specific key exists in the vault (does not require unlock).
   */
  hasKey(apiName: string): boolean {
    try {
      const vault = this.loadVault()
      return vault !== null && apiName in vault.entries
    } catch {
      return false
    }
  }

  // ── File I/O ───────────────────────────────────────────────────────────

  private loadVault(): VaultData | null {
    try {
      if (!existsSync(VAULT_PATH)) return null
      const raw = readFileSync(VAULT_PATH, 'utf-8')
      return JSON.parse(raw) as VaultData
    } catch {
      return null
    }
  }

  private saveVault(vault: VaultData): void {
    mkdirSync(TEAM_HUB_DIR, { recursive: true })
    writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 })
    // Ensure permissions even if file already existed
    try { chmodSync(VAULT_PATH, 0o600) } catch { /* ignore on Windows */ }
  }

  private loadCredential(): PasskeyCredential | null {
    try {
      if (!existsSync(PASSKEY_PATH)) return null
      const raw = readFileSync(PASSKEY_PATH, 'utf-8')
      return JSON.parse(raw) as PasskeyCredential
    } catch {
      return null
    }
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────────

export const vaultManager = new VaultManager()

// Re-export types and constants for testing
export { VAULT_PATH, PASSKEY_PATH, TEAM_HUB_DIR, MASTER_KEY_TTL_MS }
export { deriveMasterKey, deriveEntryKey, aesEncrypt, aesDecrypt }
