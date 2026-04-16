/**
 * Vault Manager — Secure API Key Storage
 *
 * Manages encrypted storage and retrieval of API keys.
 * Keys are stored in ~/.claude/team-hub/vault/
 * Each key file is encrypted with a simple XOR cipher (for now, TODO: use libsodium)
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'

const VAULT_DIR = join(homedir(), '.claude', 'team-hub', 'vault')

/**
 * Simple XOR encryption (TODO: replace with libsodium)
 * Not cryptographically secure, but prevents casual reading
 */
function xorEncrypt(data: string, key: Buffer): Buffer {
  const dataBuffer = Buffer.from(data, 'utf-8')
  const encrypted = Buffer.alloc(dataBuffer.length)
  for (let i = 0; i < dataBuffer.length; i++) {
    encrypted[i] = dataBuffer[i] ^ key[i % key.length]
  }
  return encrypted
}

function xorDecrypt(encrypted: Buffer, key: Buffer): string {
  const decrypted = Buffer.alloc(encrypted.length)
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ key[i % key.length]
  }
  return decrypted.toString('utf-8')
}

/**
 * Derive encryption key from master password/system info
 * (TODO: use proper KDF like argon2 or PBKDF2)
 */
function getDerivedKey(): Buffer {
  const masterSecret = process.env.VAULT_MASTER_SECRET || 'default-insecure-key'
  return createHash('sha256').update(masterSecret).digest()
}

/**
 * Get the file path for an API key
 */
function getKeyPath(apiName: string): string {
  return join(VAULT_DIR, `${apiName}.enc`)
}

/**
 * Store an API key encrypted
 */
export function saveApiKey(apiName: string, value: string): boolean {
  try {
    mkdirSync(VAULT_DIR, { recursive: true })
    const key = getDerivedKey()
    const encrypted = xorEncrypt(value, key)
    const keyPath = getKeyPath(apiName)
    writeFileSync(keyPath, encrypted, 'binary')
    return true
  } catch (err) {
    console.error(`[vault] Error saving key for ${apiName}:`, err)
    return false
  }
}

/**
 * Retrieve a decrypted API key
 */
export function getApiKey(apiName: string): string | null {
  try {
    const keyPath = getKeyPath(apiName)
    if (!existsSync(keyPath)) {
      return null
    }
    const key = getDerivedKey()
    const encrypted = readFileSync(keyPath, 'binary')
    const decrypted = xorDecrypt(Buffer.from(encrypted, 'binary'), key)
    return decrypted
  } catch (err) {
    console.error(`[vault] Error retrieving key for ${apiName}:`, err)
    return null
  }
}

/**
 * List available API key names (without values)
 */
export function listApiKeyNames(): string[] {
  try {
    if (!existsSync(VAULT_DIR)) {
      return []
    }
    const files = readdirSync(VAULT_DIR)
    return files
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.slice(0, -4)) // Remove .enc extension
  } catch (err) {
    console.error('[vault] Error listing keys:', err)
    return []
  }
}

/**
 * Delete an API key
 */
export function deleteApiKey(apiName: string): boolean {
  try {
    const keyPath = getKeyPath(apiName)
    if (!existsSync(keyPath)) {
      return false
    }
    rmSync(keyPath)
    return true
  } catch (err) {
    console.error(`[vault] Error deleting key for ${apiName}:`, err)
    return false
  }
}

/**
 * Check if a key exists
 */
export function hasApiKey(apiName: string): boolean {
  return existsSync(getKeyPath(apiName))
}
