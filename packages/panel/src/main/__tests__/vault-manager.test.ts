/**
 * vault-manager.test.ts
 * Unit tests for passkey-protected API key vault
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'

// We test the module internals by importing the class + helpers
import {
  vaultManager,
  VAULT_PATH,
  PASSKEY_PATH,
  TEAM_HUB_DIR,
  deriveMasterKey,
  deriveEntryKey,
  aesEncrypt,
  aesDecrypt,
} from '../vault-manager'

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanVaultFiles(): void {
  for (const f of [VAULT_PATH, PASSKEY_PATH]) {
    if (existsSync(f)) rmSync(f)
  }
  // Always lock
  vaultManager.lock()
}

function registerAndUnlock(): string {
  const challenge = crypto.randomBytes(32).toString('base64url')
  const credId = crypto.randomBytes(16).toString('base64')
  const pubKey = crypto.randomBytes(32).toString('base64')

  vaultManager.completeRegistration(credId, pubKey, challenge)
  // completeRegistration auto-caches master key, so vault is unlocked
  return challenge
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('vault-manager', () => {
  beforeEach(() => cleanVaultFiles())
  afterEach(() => cleanVaultFiles())

  // -- Encryption primitives --

  describe('crypto primitives', () => {
    test('aesEncrypt + aesDecrypt round-trip', () => {
      const key = crypto.randomBytes(32)
      const plaintext = 'sk-abc123xyz789'
      const encrypted = aesEncrypt(key, plaintext)

      expect(encrypted.iv).toHaveLength(24) // 12 bytes hex
      expect(encrypted.tag).toHaveLength(32) // 16 bytes hex
      expect(encrypted.ciphertext.length).toBeGreaterThan(0)

      const decrypted = aesDecrypt(key, encrypted.iv, encrypted.tag, encrypted.ciphertext)
      expect(decrypted).toBe(plaintext)
    })

    test('aesDecrypt with wrong key throws', () => {
      const key1 = crypto.randomBytes(32)
      const key2 = crypto.randomBytes(32)
      const encrypted = aesEncrypt(key1, 'secret')

      expect(() => aesDecrypt(key2, encrypted.iv, encrypted.tag, encrypted.ciphertext)).toThrow()
    })

    test('aesDecrypt with tampered ciphertext throws', () => {
      const key = crypto.randomBytes(32)
      const encrypted = aesEncrypt(key, 'secret')
      const tampered = 'ff' + encrypted.ciphertext.slice(2)

      expect(() => aesDecrypt(key, encrypted.iv, encrypted.tag, tampered)).toThrow()
    })

    test('deriveMasterKey is deterministic with same inputs', () => {
      const challenge = crypto.randomBytes(32).toString('base64url')
      const salt = crypto.randomBytes(16)

      const key1 = deriveMasterKey(challenge, salt)
      const key2 = deriveMasterKey(challenge, salt)

      expect(key1.toString('hex')).toBe(key2.toString('hex'))
    })

    test('deriveMasterKey differs with different salt', () => {
      const challenge = crypto.randomBytes(32).toString('base64url')
      const salt1 = crypto.randomBytes(16)
      const salt2 = crypto.randomBytes(16)

      const key1 = deriveMasterKey(challenge, salt1)
      const key2 = deriveMasterKey(challenge, salt2)

      expect(key1.toString('hex')).not.toBe(key2.toString('hex'))
    })

    test('deriveEntryKey differs per API name', () => {
      const master = crypto.randomBytes(32)
      const salt = crypto.randomBytes(16)

      const k1 = deriveEntryKey(master, 'openai', salt)
      const k2 = deriveEntryKey(master, 'anthropic', salt)

      expect(k1.toString('hex')).not.toBe(k2.toString('hex'))
    })
  })

  // -- Registration --

  describe('registration', () => {
    test('isRegistered returns false before registration', () => {
      expect(vaultManager.isRegistered()).toBe(false)
    })

    test('getStatus returns unregistered before registration', () => {
      expect(vaultManager.getStatus()).toBe('unregistered')
    })

    test('completeRegistration creates vault.json and passkey.json', () => {
      registerAndUnlock()

      expect(existsSync(VAULT_PATH)).toBe(true)
      expect(existsSync(PASSKEY_PATH)).toBe(true)
    })

    test('completeRegistration makes vault unlocked', () => {
      registerAndUnlock()

      expect(vaultManager.isRegistered()).toBe(true)
      expect(vaultManager.isUnlocked()).toBe(true)
      expect(vaultManager.getStatus()).toBe('unlocked')
    })

    test('vault.json has correct structure', () => {
      registerAndUnlock()

      const vault = JSON.parse(readFileSync(VAULT_PATH, 'utf-8'))
      expect(vault.version).toBe(1)
      expect(vault.master_salt).toBeDefined()
      expect(vault.master_check).toBeDefined()
      expect(vault.master_check_iv).toBeDefined()
      expect(vault.master_check_tag).toBeDefined()
      expect(vault.entries).toEqual({})
    })

    test('passkey.json has correct structure', () => {
      registerAndUnlock()

      const cred = JSON.parse(readFileSync(PASSKEY_PATH, 'utf-8'))
      expect(cred.credential_id).toBeDefined()
      expect(cred.public_key).toBeDefined()
      expect(cred.created_at).toBeDefined()
      expect(cred.rp_id).toBe('mcp-team-hub')
    })

    test('getRegistrationChallenge returns challenge and rp_id', () => {
      const result = vaultManager.getRegistrationChallenge()
      expect(result.challenge).toBeDefined()
      expect(result.challenge.length).toBeGreaterThan(0)
      expect(result.rp_id).toBe('mcp-team-hub')
    })
  })

  // -- Authentication --

  describe('authentication', () => {
    test('getAuthenticationChallenge fails when not registered', () => {
      const result = vaultManager.getAuthenticationChallenge()
      expect('error' in result).toBe(true)
    })

    test('completeAuthentication with correct challenge unlocks vault', () => {
      const challenge = registerAndUnlock()
      vaultManager.lock()
      expect(vaultManager.isUnlocked()).toBe(false)

      // Re-authenticate with same challenge
      const result = vaultManager.completeAuthentication(challenge)
      expect(result.success).toBe(true)
      expect(vaultManager.isUnlocked()).toBe(true)
    })

    test('completeAuthentication with wrong challenge fails', () => {
      registerAndUnlock()
      vaultManager.lock()

      const wrongChallenge = crypto.randomBytes(32).toString('base64url')
      const result = vaultManager.completeAuthentication(wrongChallenge)
      expect(result.success).toBe(false)
      expect(vaultManager.isUnlocked()).toBe(false)
    })
  })

  // -- Lock / Unlock --

  describe('lock', () => {
    test('lock clears master key', () => {
      registerAndUnlock()
      expect(vaultManager.isUnlocked()).toBe(true)

      vaultManager.lock()
      expect(vaultManager.isUnlocked()).toBe(false)
      expect(vaultManager.getStatus()).toBe('locked')
    })

    test('lock then operations return errors', () => {
      registerAndUnlock()
      vaultManager.lock()

      const addResult = vaultManager.addKey('test', 'secret')
      expect(addResult.success).toBe(false)

      const decrypted = vaultManager.decryptKey('test')
      expect(decrypted).toBeNull()
    })
  })

  // -- Key CRUD --

  describe('key CRUD', () => {
    test('addKey and decryptKey round-trip', () => {
      registerAndUnlock()

      const result = vaultManager.addKey('openai', 'sk-abc123')
      expect(result.success).toBe(true)
      expect(result.display_hint).toBe('...c123')

      const decrypted = vaultManager.decryptKey('openai')
      expect(decrypted).toBe('sk-abc123')
    })

    test('addKey stores display_hint with last 4 chars', () => {
      registerAndUnlock()

      const result = vaultManager.addKey('openai', 'sk-proj-abcdefghijklmnop')
      expect(result.display_hint).toBe('...mnop')
    })

    test('addKey with short key uses ****', () => {
      registerAndUnlock()

      const result = vaultManager.addKey('test', 'abc')
      expect(result.display_hint).toBe('****')
    })

    test('addKey overwrites existing key', () => {
      registerAndUnlock()

      vaultManager.addKey('openai', 'old-key')
      vaultManager.addKey('openai', 'new-key')

      expect(vaultManager.decryptKey('openai')).toBe('new-key')
    })

    test('removeKey deletes entry', () => {
      registerAndUnlock()

      vaultManager.addKey('openai', 'sk-abc')
      expect(vaultManager.hasKey('openai')).toBe(true)

      const result = vaultManager.removeKey('openai')
      expect(result.success).toBe(true)
      expect(vaultManager.hasKey('openai')).toBe(false)
    })

    test('removeKey returns error for non-existent key', () => {
      registerAndUnlock()

      const result = vaultManager.removeKey('nonexistent')
      expect(result.success).toBe(false)
    })

    test('listKeys returns all stored keys metadata', () => {
      registerAndUnlock()

      vaultManager.addKey('openai', 'sk-open123')
      vaultManager.addKey('anthropic', 'sk-ant-xyz')

      const keys = vaultManager.listKeys()
      expect(keys).toHaveLength(2)

      const names = keys.map((k) => k.name).sort()
      expect(names).toEqual(['anthropic', 'openai'])

      const openai = keys.find((k) => k.name === 'openai')!
      expect(openai.display_hint).toBe('...n123')
      expect(openai.created_at).toBeDefined()
    })

    test('listKeys returns empty when vault is empty', () => {
      registerAndUnlock()
      expect(vaultManager.listKeys()).toHaveLength(0)
    })

    test('decryptKey updates last_used', () => {
      registerAndUnlock()

      vaultManager.addKey('openai', 'sk-test')

      // Initially last_used is null
      const before = vaultManager.listKeys().find((k) => k.name === 'openai')!
      expect(before.last_used).toBeNull()

      // After decrypt, last_used is set
      vaultManager.decryptKey('openai')
      const after = vaultManager.listKeys().find((k) => k.name === 'openai')!
      expect(after.last_used).not.toBeNull()
    })

    test('decryptKey returns null for non-existent key', () => {
      registerAndUnlock()
      expect(vaultManager.decryptKey('nonexistent')).toBeNull()
    })

    test('hasKey works without unlock', () => {
      registerAndUnlock()
      vaultManager.addKey('openai', 'sk-test')
      vaultManager.lock()

      // hasKey reads vault.json directly, doesn't need master key
      expect(vaultManager.hasKey('openai')).toBe(true)
      expect(vaultManager.hasKey('nonexistent')).toBe(false)
    })
  })

  // -- Special characters --

  describe('special characters', () => {
    test('handles empty string value', () => {
      registerAndUnlock()
      vaultManager.addKey('empty', '')
      expect(vaultManager.decryptKey('empty')).toBe('')
    })

    test('handles special characters in key value', () => {
      registerAndUnlock()
      const special = 'sk-\n\r\t!@#$%^&*()_+-=[]{}|;:\'",.<>?/'
      vaultManager.addKey('special', special)
      expect(vaultManager.decryptKey('special')).toBe(special)
    })

    test('handles unicode in key value', () => {
      registerAndUnlock()
      const unicode = 'sk-测试密钥-🔑'
      vaultManager.addKey('unicode', unicode)
      expect(vaultManager.decryptKey('unicode')).toBe(unicode)
    })

    test('handles very long key value', () => {
      registerAndUnlock()
      const longKey = 'sk-' + 'a'.repeat(10000)
      vaultManager.addKey('long', longKey)
      expect(vaultManager.decryptKey('long')).toBe(longKey)
    })
  })

  // -- Multiple keys --

  describe('multiple keys', () => {
    test('each key has independent encryption', () => {
      registerAndUnlock()

      vaultManager.addKey('openai', 'sk-openai-123')
      vaultManager.addKey('anthropic', 'sk-ant-456')
      vaultManager.addKey('google', 'AIza-789')

      expect(vaultManager.decryptKey('openai')).toBe('sk-openai-123')
      expect(vaultManager.decryptKey('anthropic')).toBe('sk-ant-456')
      expect(vaultManager.decryptKey('google')).toBe('AIza-789')

      // Each entry in vault.json should have different salt/iv
      const vault = JSON.parse(readFileSync(VAULT_PATH, 'utf-8'))
      const salts = Object.values(vault.entries).map((e: any) => e.salt)
      const ivs = Object.values(vault.entries).map((e: any) => e.iv)

      // Salts should all be different (random)
      expect(new Set(salts).size).toBe(3)
      // IVs should all be different (random)
      expect(new Set(ivs).size).toBe(3)
    })

    test('removing one key does not affect others', () => {
      registerAndUnlock()

      vaultManager.addKey('openai', 'sk-1')
      vaultManager.addKey('anthropic', 'sk-2')
      vaultManager.addKey('google', 'sk-3')

      vaultManager.removeKey('anthropic')

      expect(vaultManager.decryptKey('openai')).toBe('sk-1')
      expect(vaultManager.decryptKey('anthropic')).toBeNull()
      expect(vaultManager.decryptKey('google')).toBe('sk-3')
      expect(vaultManager.listKeys()).toHaveLength(2)
    })
  })

  // -- File permissions --

  describe('file security', () => {
    test('vault.json is created with 0600 permissions', () => {
      registerAndUnlock()
      // On Unix, check file mode
      if (process.platform !== 'win32') {
        const { statSync } = require('node:fs')
        const stat = statSync(VAULT_PATH)
        const mode = stat.mode & 0o777
        expect(mode).toBe(0o600)
      }
    })

    test('passkey.json is created with 0600 permissions', () => {
      registerAndUnlock()
      if (process.platform !== 'win32') {
        const { statSync } = require('node:fs')
        const stat = statSync(PASSKEY_PATH)
        const mode = stat.mode & 0o777
        expect(mode).toBe(0o600)
      }
    })

    test('vault.json contains no plaintext secrets', () => {
      registerAndUnlock()
      vaultManager.addKey('openai', 'sk-super-secret-key-12345')

      const content = readFileSync(VAULT_PATH, 'utf-8')
      expect(content).not.toContain('sk-super-secret-key-12345')
      expect(content).not.toContain('super-secret')
    })
  })
})
