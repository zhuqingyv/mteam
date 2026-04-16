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
import { getApiKey, listApiKeyNames, saveApiKey, deleteApiKey } from './vault-manager'
import { getApiInfo, isApiRegistered } from './api-registry'

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
    if (!isApiRegistered(req.api_name)) {
      return {
        error: `API not registered: ${req.api_name}`,
        code: 'API_NOT_REGISTERED',
      }
    }

    // 2. Get API key from vault
    const apiKey = getApiKey(req.api_name)
    if (!apiKey) {
      return {
        error: `API key not found for ${req.api_name}. Use vault API to add it first.`,
        code: 'KEY_NOT_FOUND',
      }
    }

    // 3. Get API config
    const config = getApiInfo(req.api_name)
    if (!config) {
      return {
        error: `API config not found for ${req.api_name}`,
        code: 'CONFIG_NOT_FOUND',
      }
    }

    // 4. Build final URL
    const finalUrl = new URL(req.url, config.base_url).toString()

    // 5. Prepare headers with auth injection
    const headers: Record<string, string> = {
      ...req.headers,
    }

    // Inject Authorization header based on auth_type
    if (config.auth_type === 'bearer') {
      headers[config.auth_header] = `Bearer ${apiKey}`
    } else if (config.auth_type === 'token') {
      headers[config.auth_header] = `token ${apiKey}`
    } else {
      // Custom or header type: just pass the key as-is
      headers[config.auth_header] = apiKey
    }

    // 6. Forward request
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
export function listApiKeys(): string[] {
  return listApiKeyNames()
}

/**
 * Add API key to vault
 */
export function addApiKey(apiName: string, value: string): boolean {
  if (!isApiRegistered(apiName)) {
    console.warn(`[api-proxy] Warning: API '${apiName}' is not registered, but key can still be stored`)
  }
  return saveApiKey(apiName, value)
}

/**
 * Remove API key from vault
 */
export function removeApiKey(apiName: string): boolean {
  return deleteApiKey(apiName)
}
