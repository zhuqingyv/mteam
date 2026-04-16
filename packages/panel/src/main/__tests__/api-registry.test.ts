/**
 * api-registry.test.ts
 * Unit tests for API metadata registry
 */

import { describe, test, expect } from 'bun:test'
import {
  getApiConfig,
  listRegisteredApis,
  isApiRegistered,
  getApiInfo,
  registerCustomApi
} from '../api-registry'

describe('api-registry', () => {
  test('getApiConfig returns OpenAI config', () => {
    const config = getApiConfig('openai')
    expect(config).toBeDefined()
    expect(config?.name).toBe('openai')
    expect(config?.base_url).toBe('https://api.openai.com')
    expect(config?.auth_type).toBe('bearer')
    expect(config?.auth_header).toBe('Authorization')
  })

  test('getApiConfig returns Anthropic config', () => {
    const config = getApiConfig('anthropic')
    expect(config).toBeDefined()
    expect(config?.name).toBe('anthropic')
    expect(config?.base_url).toBe('https://api.anthropic.com')
    expect(config?.auth_type).toBe('bearer')
    expect(config?.auth_header).toBe('x-api-key')
  })

  test('getApiConfig returns GitHub config', () => {
    const config = getApiConfig('github')
    expect(config).toBeDefined()
    expect(config?.name).toBe('github')
    expect(config?.base_url).toBe('https://api.github.com')
    expect(config?.auth_type).toBe('token')
    expect(config?.auth_header).toBe('Authorization')
  })

  test('getApiConfig returns null for unknown API', () => {
    const config = getApiConfig('unknown-api')
    expect(config).toBeNull()
  })

  test('listRegisteredApis returns all registered APIs', () => {
    const apis = listRegisteredApis()
    expect(apis.length).toBeGreaterThan(0)
    expect(apis).toContain('openai')
    expect(apis).toContain('anthropic')
    expect(apis).toContain('github')
    expect(apis).toContain('slack')
  })

  test('isApiRegistered checks registration', () => {
    expect(isApiRegistered('openai')).toBe(true)
    expect(isApiRegistered('anthropic')).toBe(true)
    expect(isApiRegistered('unknown-api')).toBe(false)
  })

  test('getApiInfo returns minimal config without description', () => {
    const info = getApiInfo('openai')
    expect(info).toBeDefined()
    expect(info?.name).toBe('openai')
    expect(info?.base_url).toBe('https://api.openai.com')
    expect(info?.auth_type).toBe('bearer')
    expect(info?.auth_header).toBe('Authorization')
    expect(info?.description).toBeUndefined()
  })

  test('getApiInfo returns null for unknown API', () => {
    const info = getApiInfo('unknown-api')
    expect(info).toBeNull()
  })

  test('registerCustomApi stores custom API', () => {
    const customApi = {
      name: 'custom-api',
      base_url: 'https://custom.example.com',
      auth_type: 'bearer' as const,
      auth_header: 'X-Custom-Auth',
      description: 'A custom API for testing'
    }

    const registered = registerCustomApi(customApi)
    expect(registered).toBe(true)

    const retrieved = getApiConfig('custom-api')
    expect(retrieved).toBeDefined()
    expect(retrieved?.name).toBe('custom-api')
    expect(retrieved?.base_url).toBe('https://custom.example.com')
  })

  test('all default APIs have required fields', () => {
    const apis = listRegisteredApis()
    for (const apiName of apis) {
      const config = getApiConfig(apiName)
      expect(config).toBeDefined()
      expect(config?.name).toBeDefined()
      expect(config?.base_url).toBeDefined()
      expect(config?.auth_type).toBeDefined()
      expect(config?.auth_header).toBeDefined()
      expect(typeof config?.name).toBe('string')
      expect(typeof config?.base_url).toBe('string')
      expect(['bearer', 'token', 'custom', 'header']).toContain(config?.auth_type)
      expect(typeof config?.auth_header).toBe('string')
    }
  })

  test('Hugging Face config is present', () => {
    const config = getApiConfig('huggingface')
    expect(config).toBeDefined()
    expect(config?.base_url).toContain('huggingface')
  })

  test('Slack config is present', () => {
    const config = getApiConfig('slack')
    expect(config).toBeDefined()
    expect(config?.base_url).toContain('slack')
  })
})
