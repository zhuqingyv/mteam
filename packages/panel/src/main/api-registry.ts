/**
 * API Registry — Metadata for known APIs
 *
 * Stores configuration for various APIs:
 * - Base URL
 * - Authentication type (bearer, token, custom)
 * - Authorization header name
 */

export interface ApiConfig {
  name: string
  base_url: string
  auth_type: 'bearer' | 'token' | 'custom' | 'header'
  auth_header: string
  description?: string
}

/**
 * Built-in API registry
 * Extend with custom APIs as needed
 */
const REGISTRY: Record<string, ApiConfig> = {
  openai: {
    name: 'openai',
    base_url: 'https://api.openai.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    description: 'OpenAI API (GPT, embeddings, etc.)'
  },

  anthropic: {
    name: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth_type: 'bearer',
    auth_header: 'x-api-key',
    description: 'Anthropic API (Claude)'
  },

  github: {
    name: 'github',
    base_url: 'https://api.github.com',
    auth_type: 'token',
    auth_header: 'Authorization',
    description: 'GitHub API'
  },

  huggingface: {
    name: 'huggingface',
    base_url: 'https://api-inference.huggingface.co',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    description: 'Hugging Face API'
  },

  stripe: {
    name: 'stripe',
    base_url: 'https://api.stripe.com',
    auth_type: 'custom',
    auth_header: 'Authorization',
    description: 'Stripe API (payments)'
  },

  slack: {
    name: 'slack',
    base_url: 'https://slack.com/api',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    description: 'Slack API'
  },

  sendgrid: {
    name: 'sendgrid',
    base_url: 'https://api.sendgrid.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    description: 'SendGrid API (email)'
  },

  twilio: {
    name: 'twilio',
    base_url: 'https://api.twilio.com',
    auth_type: 'custom',
    auth_header: 'Authorization',
    description: 'Twilio API (SMS, calls)'
  },
}

/**
 * Get API config by name
 */
export function getApiConfig(apiName: string): ApiConfig | null {
  return REGISTRY[apiName] ?? null
}

/**
 * List all registered API names
 */
export function listRegisteredApis(): string[] {
  return Object.keys(REGISTRY)
}

/**
 * Check if API is registered
 */
export function isApiRegistered(apiName: string): boolean {
  return apiName in REGISTRY
}

/**
 * Register a custom API
 */
export function registerCustomApi(config: ApiConfig): boolean {
  if (config.name in REGISTRY) {
    console.warn(`[api-registry] API ${config.name} already registered, overwriting`)
  }
  REGISTRY[config.name] = config
  return true
}

/**
 * Get full API info (name, base URL, auth type)
 */
export function getApiInfo(apiName: string): Omit<ApiConfig, 'description'> | null {
  const config = getApiConfig(apiName)
  if (!config) return null
  return {
    name: config.name,
    base_url: config.base_url,
    auth_type: config.auth_type,
    auth_header: config.auth_header
  }
}
