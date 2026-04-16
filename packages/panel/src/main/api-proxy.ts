/**
 * API Key Vault Proxy — Secure API request forwarding with key injection
 *
 * Handles:
 * 1. Retrieve decrypted API key from vault-manager
 * 2. Lookup API config (auth_type, auth_header) from api-registry
 * 3. Inject Authorization header
 * 4. Forward request to real API endpoint
 * 5. Return response with error handling
 */

import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'
import { vaultManager } from './vault-manager'
import { apiRegistry } from './api-registry'

export interface ApiProxyRequest {
  api_name: string
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}

export interface ApiProxyResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface ApiProxyError {
  error: string
  code?: string
  details?: unknown
}

/**
 * Proxy an API request with key injection
 *
 * @throws Error if vault is locked, key not found, or request fails
 */
export async function proxyApiRequest(req: ApiProxyRequest): Promise<ApiProxyResponse | ApiProxyError> {
  try {
    // 1. Check if API is registered
    if (!vaultManager.isRegistered() || !vaultManager.isUnlocked()) {
      return {
        error: 'Vault is not initialized or unlocked. Use passkey to unlock first.',
        code: 'VAULT_LOCKED',
      }
    }

    // 2. Get API key from vault (requires vault to be unlocked)
    const apiKey = vaultManager.decryptKey(req.api_name)
    if (!apiKey) {
      return {
        error: `API key not found for ${req.api_name}. Use vault API to add it first.`,
        code: 'KEY_NOT_FOUND',
      }
    }

    // 3. Get API config from registry
    const apiDef = apiRegistry.get(req.api_name)
    if (!apiDef) {
      return {
        error: `API not registered: ${req.api_name}`,
        code: 'API_NOT_REGISTERED',
      }
    }

    // 4. Validate URL is within API's allowed domain
    if (!apiRegistry.validateUrl(req.api_name, req.url)) {
      return {
        error: `URL not allowed for API '${req.api_name}'. Must start with ${apiDef.base_url}`,
        code: 'URL_NOT_ALLOWED',
      }
    }

    // 5. Build final URL
    const finalUrl = new URL(req.url, apiDef.base_url).toString()

    // 6. Prepare headers with auth injection
    const headers: Record<string, string> = {
      ...req.headers,
    }

    // Build auth header value
    const auth = apiRegistry.buildAuthValue(req.api_name, apiKey)
    if (auth) {
      headers[auth.header] = auth.value
    }

    // 7. Forward request
    const response = await forwardRequest(finalUrl, req.method, headers, req.body)

    return response
  } catch (err) {
    return {
      error: `API proxy failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'PROXY_ERROR',
      details: err,
    }
  }
}

/**
 * Forward HTTP(S) request and return response
 */
async function forwardRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<ApiProxyResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === 'https:'
    const client = isHttps ? https : http

    const options = {
      method: method.toUpperCase(),
      headers: {
        ...headers,
        'Content-Length': body ? Buffer.byteLength(body) : 0,
      },
      timeout: 30000, // 30 second timeout
    }

    const req = client.request(parsedUrl, options, (res) => {
      const chunks: Buffer[] = []

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf-8')
        const responseHeaders: Record<string, string | string[] | undefined> = {}

        // Copy relevant response headers
        if (res.headers['content-type']) responseHeaders['content-type'] = res.headers['content-type']
        if (res.headers['content-length']) responseHeaders['content-length'] = res.headers['content-length']
        if (res.headers['x-ratelimit-remaining']) responseHeaders['x-ratelimit-remaining'] = res.headers['x-ratelimit-remaining']
        if (res.headers['x-ratelimit-reset']) responseHeaders['x-ratelimit-reset'] = res.headers['x-ratelimit-reset']

        resolve({
          status: res.statusCode || 500,
          headers: responseHeaders,
          body: responseBody,
        })
      })

      res.on('error', reject)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.on('error', reject)

    if (body) {
      req.write(body)
    }

    req.end()
  })
}

/**
 * List available API keys (names only, not values)
 */
export function listApiKeys(): Array<{ name: string; display_hint: string; created_at: string }> {
  return vaultManager.listKeys()
}

/**
 * Add API key to vault
 */
export function addApiKey(apiName: string, value: string): { success: boolean; display_hint?: string; error?: string } {
  if (!vaultManager.isUnlocked()) {
    return { success: false, error: 'Vault is locked. Unlock with passkey first.' }
  }
  return vaultManager.addKey(apiName, value)
}

/**
 * Remove API key from vault
 */
export function removeApiKey(apiName: string): { success: boolean; error?: string } {
  if (!vaultManager.isUnlocked()) {
    return { success: false, error: 'Vault is locked. Unlock with passkey first.' }
  }
  return vaultManager.removeKey(apiName)
}
