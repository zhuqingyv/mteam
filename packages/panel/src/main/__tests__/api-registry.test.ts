/**
 * api-registry.test.ts
 * Unit tests for API metadata registry
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { apiRegistry, REGISTRY_PATH, PRESETS } from '../api-registry'

describe('api-registry', () => {
  afterEach(() => {
    // Clean custom registry file
    if (existsSync(REGISTRY_PATH)) {
      rmSync(REGISTRY_PATH)
    }
  })

  // -- Presets --

  describe('presets', () => {
    test('OpenAI preset exists with correct config', () => {
      const def = apiRegistry.get('openai')
      expect(def).not.toBeNull()
      expect(def!.name).toBe('openai')
      expect(def!.base_url).toBe('https://api.openai.com')
      expect(def!.auth_type).toBe('bearer')
      expect(def!.auth_header).toBe('Authorization')
      expect(def!.auth_prefix).toBe('Bearer ')
      expect(def!.is_preset).toBe(true)
    })

    test('Anthropic preset has custom auth header', () => {
      const def = apiRegistry.get('anthropic')
      expect(def).not.toBeNull()
      expect(def!.auth_type).toBe('custom')
      expect(def!.auth_header).toBe('x-api-key')
      expect(def!.auth_prefix).toBeUndefined()
    })

    test('Google preset exists', () => {
      const def = apiRegistry.get('google')
      expect(def).not.toBeNull()
      expect(def!.base_url).toBe('https://generativelanguage.googleapis.com')
    })

    test('GitHub preset exists', () => {
      const def = apiRegistry.get('github')
      expect(def).not.toBeNull()
      expect(def!.base_url).toBe('https://api.github.com')
    })

    test('list includes all presets', () => {
      const all = apiRegistry.list()
      const presetNames = PRESETS.map((p) => p.name)
      for (const name of presetNames) {
        expect(all.some((d) => d.name === name)).toBe(true)
      }
    })

    test('get returns null for unknown API', () => {
      expect(apiRegistry.get('nonexistent')).toBeNull()
    })
  })

  // -- Custom APIs --

  describe('custom APIs', () => {
    test('register a custom API', () => {
      const result = apiRegistry.register({
        name: 'custom-llm',
        base_url: 'https://api.custom-llm.com',
        auth_type: 'bearer',
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
        description: 'Custom LLM provider',
      })
      expect(result.success).toBe(true)

      const def = apiRegistry.get('custom-llm')
      expect(def).not.toBeNull()
      expect(def!.name).toBe('custom-llm')
      expect(def!.is_preset).toBe(false)
    })

    test('cannot overwrite preset', () => {
      const result = apiRegistry.register({
        name: 'openai',
        base_url: 'https://fake.com',
        auth_type: 'bearer',
        auth_header: 'Authorization',
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('preset')
    })

    test('register validates required fields', () => {
      const result = apiRegistry.register({
        name: '',
        base_url: '',
        auth_type: 'bearer',
        auth_header: '',
      })
      expect(result.success).toBe(false)
    })

    test('register validates base_url format', () => {
      const result = apiRegistry.register({
        name: 'bad-url',
        base_url: 'not-a-url',
        auth_type: 'bearer',
        auth_header: 'Authorization',
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid base_url')
    })

    test('unregister removes custom API', () => {
      apiRegistry.register({
        name: 'temp-api',
        base_url: 'https://temp.com',
        auth_type: 'bearer',
        auth_header: 'Authorization',
      })
      expect(apiRegistry.get('temp-api')).not.toBeNull()

      const result = apiRegistry.unregister('temp-api')
      expect(result.success).toBe(true)
      expect(apiRegistry.get('temp-api')).toBeNull()
    })

    test('cannot unregister preset', () => {
      const result = apiRegistry.unregister('openai')
      expect(result.success).toBe(false)
      expect(result.error).toContain('preset')
    })

    test('unregister returns error for nonexistent', () => {
      const result = apiRegistry.unregister('nonexistent')
      expect(result.success).toBe(false)
    })

    test('list includes custom APIs', () => {
      apiRegistry.register({
        name: 'my-api',
        base_url: 'https://my-api.com',
        auth_type: 'custom',
        auth_header: 'X-Token',
      })

      const all = apiRegistry.list()
      expect(all.some((d) => d.name === 'my-api')).toBe(true)
    })
  })

  // -- URL Validation --

  describe('URL validation', () => {
    test('validates URL against base_url', () => {
      expect(apiRegistry.validateUrl('openai', 'https://api.openai.com/v1/chat/completions')).toBe(true)
      expect(apiRegistry.validateUrl('openai', 'https://api.openai.com/v1/embeddings')).toBe(true)
    })

    test('rejects URL with different origin', () => {
      expect(apiRegistry.validateUrl('openai', 'https://evil.com/v1/chat/completions')).toBe(false)
    })

    test('rejects URL for unknown API', () => {
      expect(apiRegistry.validateUrl('nonexistent', 'https://example.com')).toBe(false)
    })

    test('validates Anthropic URLs', () => {
      expect(apiRegistry.validateUrl('anthropic', 'https://api.anthropic.com/v1/messages')).toBe(true)
      expect(apiRegistry.validateUrl('anthropic', 'https://api.openai.com/v1/chat')).toBe(false)
    })
  })

  // -- Auth Value Builder --

  describe('buildAuthValue', () => {
    test('builds bearer auth with prefix', () => {
      const result = apiRegistry.buildAuthValue('openai', 'sk-test123')
      expect(result).not.toBeNull()
      expect(result!.header).toBe('Authorization')
      expect(result!.value).toBe('Bearer sk-test123')
    })

    test('builds custom auth without prefix', () => {
      const result = apiRegistry.buildAuthValue('anthropic', 'sk-ant-test')
      expect(result).not.toBeNull()
      expect(result!.header).toBe('x-api-key')
      expect(result!.value).toBe('sk-ant-test') // no prefix for custom
    })

    test('returns null for unknown API', () => {
      expect(apiRegistry.buildAuthValue('nonexistent', 'key')).toBeNull()
    })
  })

  // -- All presets have required fields --

  describe('preset integrity', () => {
    test('all presets have required fields', () => {
      for (const preset of PRESETS) {
        expect(preset.name).toBeTruthy()
        expect(preset.base_url).toBeTruthy()
        expect(preset.auth_type).toBeTruthy()
        expect(preset.auth_header).toBeTruthy()
        expect(preset.is_preset).toBe(true)

        // base_url should be valid
        expect(() => new URL(preset.base_url)).not.toThrow()
      }
    })
  })
})
