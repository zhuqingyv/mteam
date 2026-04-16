/**
 * vault-manager.test.ts
 * Unit tests for vault key storage/retrieval
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, rmSync } from 'node:fs'
import { saveApiKey, getApiKey, listApiKeyNames, deleteApiKey, hasApiKey } from '../vault-manager'

const VAULT_DIR = join(homedir(), '.claude', 'team-hub', 'vault')

describe('vault-manager', () => {
  beforeEach(() => {
    // Clean vault before each test
    if (existsSync(VAULT_DIR)) {
      rmSync(VAULT_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up after tests
    if (existsSync(VAULT_DIR)) {
      rmSync(VAULT_DIR, { recursive: true })
    }
  })

  test('saveApiKey and getApiKey round-trip', () => {
    const apiName = 'test-api'
    const secret = 'my-secret-key-12345'

    const saved = saveApiKey(apiName, secret)
    expect(saved).toBe(true)

    const retrieved = getApiKey(apiName)
    expect(retrieved).toBe(secret)
  })

  test('getApiKey returns null for non-existent key', () => {
    const retrieved = getApiKey('non-existent')
    expect(retrieved).toBeNull()
  })

  test('saveApiKey overwrites existing key', () => {
    const apiName = 'test-api'
    saveApiKey(apiName, 'key-1')
    saveApiKey(apiName, 'key-2')

    const retrieved = getApiKey(apiName)
    expect(retrieved).toBe('key-2')
  })

  test('listApiKeyNames returns all stored keys', () => {
    saveApiKey('api-1', 'secret-1')
    saveApiKey('api-2', 'secret-2')
    saveApiKey('api-3', 'secret-3')

    const names = listApiKeyNames()
    expect(names.length).toBe(3)
    expect(names.sort()).toEqual(['api-1', 'api-2', 'api-3'])
  })

  test('listApiKeyNames returns empty for no keys', () => {
    const names = listApiKeyNames()
    expect(names.length).toBe(0)
  })

  test('deleteApiKey removes a key', () => {
    saveApiKey('test-api', 'secret')
    const exists1 = hasApiKey('test-api')
    expect(exists1).toBe(true)

    const deleted = deleteApiKey('test-api')
    expect(deleted).toBe(true)

    const exists2 = hasApiKey('test-api')
    expect(exists2).toBe(false)
  })

  test('deleteApiKey returns false for non-existent key', () => {
    const deleted = deleteApiKey('non-existent')
    expect(deleted).toBe(false)
  })

  test('hasApiKey checks key existence', () => {
    saveApiKey('test-api', 'secret')
    expect(hasApiKey('test-api')).toBe(true)
    expect(hasApiKey('other-api')).toBe(false)
  })

  test('handles empty strings', () => {
    saveApiKey('empty-key', '')
    const retrieved = getApiKey('empty-key')
    expect(retrieved).toBe('')
  })

  test('handles special characters in values', () => {
    const specialChars = 'sk-\n\r\t\x00!@#$%^&*()_+-=[]{}|;:\'",.<>?/'
    saveApiKey('special', specialChars)
    const retrieved = getApiKey('special')
    expect(retrieved).toBe(specialChars)
  })

  test('handles multiple keys with similar names', () => {
    saveApiKey('openai', 'secret-openai')
    saveApiKey('openai-backup', 'secret-openai-backup')
    saveApiKey('anthropic', 'secret-anthropic')

    const names = listApiKeyNames().sort()
    expect(names).toEqual(['anthropic', 'openai', 'openai-backup'])

    expect(getApiKey('openai')).toBe('secret-openai')
    expect(getApiKey('openai-backup')).toBe('secret-openai-backup')
    expect(getApiKey('anthropic')).toBe('secret-anthropic')
  })
})
