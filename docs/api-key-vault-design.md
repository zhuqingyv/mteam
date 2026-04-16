# API Key Vault -- Complete Design Document

> Version: 1.0
> Date: 2026-04-16
> Status: Design
> Decision: Method A (MCP Tool Proxy), NOT MITM Proxy

---

## 1. Overview

API Key Vault lets agents use external APIs (OpenAI, Anthropic, Google, etc.) without ever seeing the API key plaintext. The user stores keys via Touch ID / Passkey; agents call a MCP tool (`use_api`) that proxies the request through Panel, which decrypts the key in-memory and injects the auth header before forwarding.

```
User --> Panel UI --> Touch ID unlock --> vault.json (AES-256-GCM ciphertext)
Agent --> use_api("openai", url, body) --> Hub --> Panel --> decrypt key --> inject header --> forward --> return result
```

Agent never touches the key. Period.

---

## 2. Architecture

### 2.1 Data Flow

```
                                  +------------------+
                                  |   External API   |
                                  | (api.openai.com) |
                                  +--------+---------+
                                           ^
                                           | HTTPS (with injected auth)
                                           |
+----------+    MCP stdio     +-----------+----------+    HTTP     +------------------+
|  Agent   | ---- use_api --> |    Hub (hub.ts)      | ---------> | Panel HTTP API   |
|  (PTY)   |                  | POST /api/vault/proxy|            | panel-api.ts     |
+----------+                  +----------------------+            +--------+---------+
                                                                           |
                                                                           v
                                                                  +------------------+
                                                                  | api-proxy.ts     |
                                                                  | 1. session check |
                                                                  | 2. ACL check     |
                                                                  | 3. rate limit    |
                                                                  | 4. decrypt key   |
                                                                  | 5. inject header |
                                                                  | 6. forward req   |
                                                                  +--------+---------+
                                                                           |
                                                                  +--------+---------+
                                                                  | vault-manager.ts |
                                                                  | AES-256-GCM      |
                                                                  | HKDF derive      |
                                                                  | master key cache |
                                                                  +--------+---------+
                                                                           |
                                                                  +--------+---------+
                                                                  | vault.json       |
                                                                  | (encrypted, 600) |
                                                                  +------------------+
```

### 2.2 Why MCP Tool Proxy (Not MITM)

The prior research (`.claude/api-key-vault-research.md`) recommended MITM proxy. Team-lead overruled -- correctly. Reasons:

1. **MITM requires self-signed CA** -- adding a CA to macOS keychain is a system-wide trust change that every process inherits. A malicious agent script could abuse the trusted CA.
2. **HTTPS CONNECT tunnels are opaque** -- without MITM, a proxy cannot inject headers into TLS-encrypted streams. So "transparent proxy" is a misnomer: it requires MITM to actually work.
3. **MCP Tool proxy is simpler and more secure** -- agent explicitly calls `use_api(...)`, Panel controls the entire request lifecycle, zero CA trust changes needed.
4. **Auditability** -- every API call goes through a single MCP tool, trivially logged.

Trade-off: agents must use the tool instead of raw `curl`. This is acceptable because agents already use MCP tools for everything else.

---

## 3. Security Model

### 3.1 Core Threat: Malicious Agent Reads vault.json

**Defense layers:**

| Layer | Mechanism | What it stops |
|-------|-----------|---------------|
| 1. Encryption at rest | AES-256-GCM per-key encryption | File read = useless ciphertext |
| 2. Master key derivation | HKDF from Passkey challenge | No passkey = no master key |
| 3. Master key in-memory only | Never written to disk | File system scan finds nothing |
| 4. OS process isolation | Different process memory spaces | Agent PTY cannot read Panel memory |
| 5. File permissions | vault.json mode 0600 | Extra barrier (same-user, but defense-in-depth) |

### 3.2 Attack Surface Analysis

| Attack Vector | Risk | Defense |
|---------------|------|---------|
| `cat vault.json` | LOW -- file is ciphertext | AES-256-GCM, no key on disk |
| `env \| grep KEY` | NONE | Keys never in env vars |
| `ps aux` / `/proc` inspect | NONE | Master key in JS heap, not in env or cmdline |
| `tcpdump -i lo` on Panel API | MEDIUM | Session token required; sniffed request without token rejected |
| Direct `curl POST /api/vault/proxy` | MEDIUM | Session-based auth on Panel HTTP API |
| Agent spawns sub-process | NONE | No key material available to inject |
| `gdb -p <panel_pid>` | NONE on macOS | SIP prevents debugging other processes without entitlement |

### 3.3 Session Authentication (Panel HTTP API)

Problem: Panel HTTP API runs on localhost. Agent knows the port (from `panel.port`). Without auth, agent could bypass MCP and directly `curl` the proxy endpoint.

Solution: **Session token per MCP connection.**

```
Hub startup:
  1. Hub generates session_token = crypto.randomBytes(32).hex()
  2. Hub sends session_token to Panel via POST /api/session/register
  3. Hub includes X-Hub-Session header on every /api/vault/* call

Panel validation:
  1. Panel stores registered session tokens
  2. Every /api/vault/* request must have valid X-Hub-Session
  3. Agent PTY does not have access to the session token (it lives in Hub process memory)
```

Agent cannot forge this because:
- session_token is generated in Hub process memory
- Hub communicates with Panel over localhost HTTP (agent can sniff, but...)
- The session registration happens at Hub startup, before any agent PTY exists
- Even if sniffed, the token is tied to Hub process; re-registering requires Hub restart

For stronger isolation (future): move to Unix domain socket with 0600 permissions.

### 3.4 Member ACL

Leader configures which members can use which API keys:

```json
{
  "acl": {
    "openai": ["*"],
    "anthropic": ["alice", "bob"],
    "google": ["alice"]
  }
}
```

- `"*"` = all members
- Explicit list = only named members
- ACL stored in `vault-acl.json` (plaintext, not secret -- just names)
- Checked by `api-proxy.ts` before decrypting the key

### 3.5 Rate Limiting

Per-member, per-API rate limits to prevent cost blowup:

```json
{
  "rate_limits": {
    "openai": { "rpm": 30, "rpd": 500 },
    "anthropic": { "rpm": 20, "rpd": 300 },
    "default": { "rpm": 10, "rpd": 100 }
  }
}
```

- `rpm` = requests per minute
- `rpd` = requests per day
- Sliding window counters in memory (no persistence needed -- reset on Panel restart is fine)
- Exceeded limit returns `{ error: "rate_limit_exceeded", retry_after_ms: N }`

---

## 4. Encryption Design

### 4.1 Key Hierarchy

```
Passkey (Touch ID)
  |
  | WebAuthn assertion.response
  v
Challenge (base64url) + Salt (random 16B) + Context (hostname + uid)
  |
  | HKDF-SHA256, info = "mcp-team-hub-vault-master"
  v
Master Key (32 bytes) -- cached in Panel memory, TTL 30 min
  |
  | HKDF-SHA256, info = "api-{name}", salt = per-entry salt
  v
Per-API Key (32 bytes)
  |
  | AES-256-GCM, IV = random 12B
  v
Encrypted API secret (stored in vault.json)
```

### 4.2 vault.json Format

```json
{
  "version": 1,
  "master_salt": "hex(16 bytes)",
  "master_check": "hex(encrypted known plaintext for unlock verification)",
  "master_check_iv": "hex(12 bytes)",
  "master_check_tag": "hex(16 bytes)",
  "entries": {
    "openai": {
      "salt": "hex(16 bytes)",
      "iv": "hex(12 bytes)",
      "tag": "hex(16 bytes)",
      "ciphertext": "hex(...)",
      "created_at": "2026-04-16T10:00:00Z",
      "last_used": "2026-04-16T12:30:00Z",
      "display_hint": "sk-...a3Bf"
    },
    "anthropic": {
      "salt": "hex(16 bytes)",
      "iv": "hex(12 bytes)",
      "tag": "hex(16 bytes)",
      "ciphertext": "hex(...)",
      "created_at": "2026-04-16T10:05:00Z",
      "last_used": null,
      "display_hint": "sk-ant-...xK9m"
    }
  }
}
```

Notes:
- `master_check` is an encrypted known plaintext ("team-hub-vault-ok"). Used to verify the derived master key is correct on unlock without exposing any API key.
- `display_hint` stores the last 4 chars of the original key for UI display. Not secret.
- Each entry has its own `salt`, `iv`, `tag` -- independent encryption.
- File permission: 0600.

### 4.3 Passkey-to-Master-Key Derivation

```typescript
function deriveMasterKey(
  challengeB64url: string,
  masterSalt: Buffer
): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(challengeB64url, 'base64url'),
    masterSalt,
    Buffer.from(`mcp-team-hub-vault-master:${os.hostname()}:${process.getuid?.() ?? 'none'}`),
    32
  ))
}
```

Context binding (`hostname + uid`) means the same passkey on a different machine or user produces a different master key -- vault file is not portable.

### 4.4 Per-API Key Derivation and Encrypt/Decrypt

```typescript
function deriveEntryKey(masterKey: Buffer, apiName: string, entrySalt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    masterKey,
    entrySalt,
    Buffer.from(`api-${apiName}`),
    32
  ))
}

function encrypt(entryKey: Buffer, plaintext: string): { iv: string; tag: string; ciphertext: string } {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', entryKey, iv)
  let enc = cipher.update(plaintext, 'utf-8', 'hex')
  enc += cipher.final('hex')
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: enc
  }
}

function decrypt(entryKey: Buffer, entry: { iv: string; tag: string; ciphertext: string }): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    entryKey,
    Buffer.from(entry.iv, 'hex')
  )
  decipher.setAuthTag(Buffer.from(entry.tag, 'hex'))
  let dec = decipher.update(entry.ciphertext, 'hex', 'utf-8')
  dec += decipher.final('utf-8')
  return dec
}
```

---

## 5. Module Specifications

### 5.1 vault-manager.ts

**Location**: `packages/panel/src/main/vault-manager.ts`

**Responsibilities**:
- Passkey registration (store credential ID + public key)
- Passkey authentication (verify assertion, derive master key)
- Master key cache with TTL (default 30 min)
- Encrypt/decrypt individual API keys
- CRUD operations on vault.json entries
- Master key verification on unlock (master_check)

**Exports**:

```typescript
class VaultManager {
  // Passkey lifecycle
  getRegistrationChallenge(): { challenge: string; options: PublicKeyCredentialCreationOptions }
  completeRegistration(attestation: AttestationData): { success: boolean }
  getAuthenticationChallenge(): { challenge: string; options: PublicKeyCredentialRequestOptions }
  completeAuthentication(assertion: AssertionData): { success: boolean }

  // State
  isUnlocked(): boolean
  isRegistered(): boolean
  lock(): void  // clear master key from memory

  // Key CRUD
  addKey(apiName: string, secretValue: string): { success: boolean; display_hint: string }
  removeKey(apiName: string): { success: boolean }
  listKeys(): Array<{ name: string; display_hint: string; created_at: string; last_used: string | null }>
  
  // Internal -- used by api-proxy.ts
  decryptKey(apiName: string): string | null
}
```

**IPC Handlers** (registered in vault-manager.ts):

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `vault:get-reg-challenge` | Renderer -> Main | Get WebAuthn registration options |
| `vault:complete-reg` | Renderer -> Main | Submit attestation |
| `vault:get-auth-challenge` | Renderer -> Main | Get WebAuthn authentication options |
| `vault:complete-auth` | Renderer -> Main | Submit assertion, unlock vault |
| `vault:lock` | Renderer -> Main | Lock vault (clear master key) |
| `vault:is-unlocked` | Renderer -> Main | Check unlock status |
| `vault:add-key` | Renderer -> Main | Add API key (vault must be unlocked) |
| `vault:remove-key` | Renderer -> Main | Remove API key |
| `vault:list-keys` | Renderer -> Main | List key names + hints |

**File locations**:

| File | Path | Permissions |
|------|------|-------------|
| Vault data | `~/.claude/team-hub/vault.json` | 0600 |
| Passkey credential | `~/.claude/team-hub/passkey.json` | 0600 |
| ACL config | `~/.claude/team-hub/vault-acl.json` | 0644 |

### 5.2 api-registry.ts

**Location**: `packages/panel/src/main/api-registry.ts`

**Responsibilities**:
- Manage API metadata (base URL, auth type, auth header name)
- Provide presets for common APIs
- Allow custom API registration
- URL validation against registered base URLs

**Exports**:

```typescript
interface ApiDefinition {
  name: string
  base_url: string
  auth_type: 'bearer' | 'custom' | 'query_param'
  auth_header: string       // e.g. "Authorization", "x-api-key"
  auth_prefix?: string      // e.g. "Bearer " (for bearer type)
  description?: string
}

class ApiRegistry {
  get(name: string): ApiDefinition | null
  list(): ApiDefinition[]
  register(def: ApiDefinition): void
  unregister(name: string): boolean
  validateUrl(apiName: string, url: string): boolean  // url must start with base_url
}
```

**Presets** (built-in, cannot be removed):

```typescript
const PRESETS: ApiDefinition[] = [
  {
    name: 'openai',
    base_url: 'https://api.openai.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    auth_prefix: 'Bearer ',
    description: 'OpenAI API (GPT, DALL-E, Whisper, etc.)'
  },
  {
    name: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth_type: 'custom',
    auth_header: 'x-api-key',
    description: 'Anthropic API (Claude models)'
  },
  {
    name: 'google',
    base_url: 'https://generativelanguage.googleapis.com',
    auth_type: 'bearer',
    auth_header: 'Authorization',
    auth_prefix: 'Bearer ',
    description: 'Google Generative AI API (Gemini)'
  }
]
```

**Storage**: `~/.claude/team-hub/api-registry.json` (custom entries only; presets are in code).

### 5.3 api-proxy.ts

**Location**: `packages/panel/src/main/api-proxy.ts`

**Responsibilities**:
- Receive proxied API request from Panel HTTP API
- Validate session, ACL, rate limit
- Decrypt API key via vault-manager
- Inject auth header per api-registry definition
- Forward HTTPS request to external API
- Return response to caller
- Log all calls for audit

**Exports**:

```typescript
interface ProxyRequest {
  member_name: string
  api_name: string
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}

interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body: string
}

async function proxyApiRequest(req: ProxyRequest): Promise<ProxyResponse | { error: string }>
```

**Request flow**:

```
1. Validate member_name is not empty
2. Check vault is unlocked --> error "vault_locked" if not
3. Check ACL: member allowed for this api_name? --> error "acl_denied"
4. Check rate limit --> error "rate_limit_exceeded" with retry_after_ms
5. Get ApiDefinition from registry --> error "unknown_api" if not found
6. Validate URL starts with base_url --> error "url_not_allowed"
7. Decrypt key --> error "key_not_found" if missing
8. Build outgoing headers:
   - Copy request headers
   - Inject auth: auth_header = auth_prefix + decrypted_key
9. Forward HTTPS request
10. Update last_used timestamp in vault.json
11. Log: { member, api_name, url, method, status, timestamp }
12. Return { status, headers, body }
```

**Rate limiter** (in-memory sliding window):

```typescript
class RateLimiter {
  private counters: Map<string, { minute: number[]; day: number[] }>

  check(member: string, apiName: string): { allowed: boolean; retry_after_ms?: number }
  record(member: string, apiName: string): void
}
```

### 5.4 Panel HTTP API Routes

**Location**: `packages/panel/src/main/panel-api.ts` (new routes)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/vault/proxy` | X-Hub-Session | Proxy API request (main endpoint) |
| `GET` | `/api/vault/list` | X-Hub-Session | List available key names |
| `GET` | `/api/vault/status` | none | Vault lock status (unlocked/locked/unregistered) |
| `POST` | `/api/vault/add` | IPC only | Add key (from UI, vault must be unlocked) |
| `DELETE` | `/api/vault/remove` | IPC only | Remove key (from UI) |
| `POST` | `/api/session/register` | localhost | Register Hub session token |

Notes:
- `/api/vault/proxy` and `/api/vault/list` require `X-Hub-Session` header
- `/api/vault/add` and `/api/vault/remove` are called from Renderer via IPC, not from Hub. No HTTP route needed -- IPC handlers in vault-manager.ts.
- `/api/vault/status` is public (no secret in response) -- used by Hub to check if vault is available

### 5.5 MCP Tools (hub.ts)

#### list_api_keys

```typescript
{
  name: "list_api_keys",
  description: "查看可用的 API Key 名字列表（不含密钥明文）。返回 key 名字、末4位提示、上次使用时间。",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```

**Permission**: All (leader + member).

**Handler**: `callPanel("GET", "/api/vault/list", null, { "X-Hub-Session": sessionToken })`

**Return**:
```json
{
  "keys": [
    { "name": "openai", "display_hint": "...a3Bf", "last_used": "2026-04-16T12:30:00Z" },
    { "name": "anthropic", "display_hint": "...xK9m", "last_used": null }
  ],
  "vault_status": "unlocked"
}
```

#### use_api

```typescript
{
  name: "use_api",
  description: "通过 Panel 代理发送 API 请求。密钥由 Vault 自动注入，Agent 看不到明文。仅支持已注册的 API（openai/anthropic/google 等）。URL 必须匹配 API 的 base_url。",
  inputSchema: {
    type: "object",
    properties: {
      api_name: {
        type: "string",
        description: "API 名称（如 openai, anthropic, google）。用 list_api_keys 查看可用列表。"
      },
      url: {
        type: "string",
        description: "完整请求 URL（必须以 API 的 base_url 开头）"
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description: "HTTP 方法，默认 POST"
      },
      headers: {
        type: "object",
        description: "自定义请求头（不要包含 Authorization，会被自动注入）"
      },
      body: {
        type: "string",
        description: "请求体（JSON string）"
      }
    },
    required: ["api_name", "url"]
  }
}
```

**Permission**: All (leader + member). ACL checked server-side.

**Handler**:
```typescript
// 1. Infer member_name from session (same as send_msg from inference)
const member_name = inferCallerMember(session) || "leader"

// 2. Forward to Panel
const result = await callPanel("POST", "/api/vault/proxy", {
  member_name,
  api_name,
  url,
  method: method || "POST",
  headers: headers || {},
  body: body || ""
}, {
  "X-Hub-Session": sessionToken,
  timeout: 30000  // 30s timeout for API calls
})

// 3. Return result (status + headers + body) or error
```

**Return** (success):
```json
{
  "status": 200,
  "headers": { "content-type": "application/json", "..." : "..." },
  "body": "{\"id\":\"chatcmpl-...\",\"choices\":[...]}"
}
```

**Return** (errors):
```json
{ "error": "vault_locked", "hint": "Vault 未解锁。请在 Panel 桌面应用中用 Touch ID 解锁。" }
{ "error": "acl_denied", "hint": "当前成员无权使用 openai API。请联系 leader。" }
{ "error": "rate_limit_exceeded", "retry_after_ms": 5000 }
{ "error": "unknown_api", "hint": "API 'xxx' 未注册。用 list_api_keys 查看可用列表。" }
{ "error": "url_not_allowed", "hint": "URL 必须以 https://api.openai.com 开头" }
{ "error": "key_not_found", "hint": "API 'openai' 的密钥未存储。请在 Panel 中添加。" }
```

---

## 6. Frontend (Panel Renderer)

### 6.1 Passkey Registration / Unlock UI

Integrated into Panel main window (not a separate window).

**States**:
1. **Unregistered** -- show "Set up API Key Vault" button --> triggers passkey registration flow
2. **Locked** -- show "Unlock Vault (Touch ID)" button --> triggers passkey authentication
3. **Unlocked** -- show key management UI + lock button

**Flow**:
```
Unregistered:
  [Set up Vault] --> Touch ID prompt --> Registration complete --> Unlocked

Locked:
  [Unlock] --> Touch ID prompt --> Authentication complete --> Unlocked

Unlocked:
  [Lock] --> Clear master key --> Locked
  (Auto-lock after 30 min idle)
```

### 6.2 Key Management Page

When vault is unlocked:

```
+--------------------------------------------+
| API Keys                          [Lock]   |
+--------------------------------------------+
| openai       sk-...a3Bf    2026-04-16  [x] |
| anthropic    sk-ant-...K9m  never used [x] |
+--------------------------------------------+
| [+ Add Key]                                |
+--------------------------------------------+
| API Registry                               |
| openai      api.openai.com      (preset)   |
| anthropic   api.anthropic.com   (preset)   |
| google      googleapis.com      (preset)   |
| [+ Add Custom API]                         |
+--------------------------------------------+
```

- Only key name + last 4 chars displayed, never full key
- Add Key: dropdown to select API name + text input for key value
- Delete: confirmation dialog before removing
- Custom API: form for name, base_url, auth_type, auth_header

### 6.3 ACL Management (Leader Only)

```
+--------------------------------------------+
| Access Control                             |
+--------------------------------------------+
| openai:     [*] All members               |
| anthropic:  [x] alice  [x] bob  [ ] carol |
| google:     [x] alice  [ ] bob  [ ] carol |
+--------------------------------------------+
```

---

## 7. File Layout

```
packages/panel/src/main/
  vault-manager.ts       -- Passkey + encryption + vault CRUD
  api-registry.ts        -- API metadata + presets
  api-proxy.ts           -- Request proxy + ACL + rate limit + audit
  panel-api.ts           -- (modified) new /api/vault/* routes

packages/panel/src/preload/
  vault-preload.ts       -- contextBridge for vault UI (WebAuthn calls)

packages/panel/src/renderer/
  vault-settings.tsx     -- Key management + ACL UI component
  vault-settings.css     -- Styles

packages/mcp-server/src/
  hub.ts                 -- (modified) new list_api_keys + use_api tools

~/.claude/team-hub/
  vault.json             -- Encrypted API keys (0600)
  passkey.json           -- WebAuthn credential data (0600)
  vault-acl.json         -- Member ACL config (0644)
  api-registry.json      -- Custom API definitions (0644)
```

---

## 8. Edge Cases

### 8.1 Vault Locked When Agent Calls use_api

Hub returns `{ error: "vault_locked", hint: "..." }`. Agent should inform user. If ask_user is available, agent can use `ask_user({ type: "confirm", title: "Vault Locked", question: "Please unlock the vault via Touch ID in Panel" })` to prompt.

### 8.2 Panel Not Running

Hub's `callPanel` throws. Handler returns `{ error: "Panel 未运行，无法执行此操作" }` -- same pattern as other Panel-dependent tools.

### 8.3 Master Key TTL Expiry During Work

Master key cached for 30 minutes. If it expires mid-session:
- Next `use_api` call returns `vault_locked`
- User re-authenticates with Touch ID (takes 2 seconds)
- Agent retries

### 8.4 Concurrent use_api Calls

Multiple agents calling `use_api` simultaneously:
- Each call is independent -- no shared mutable state in the proxy path
- Rate limiter uses atomic counter updates
- vault.json reads are per-call (no caching of the file -- master key is cached, file is re-read for freshness)

### 8.5 API Key Rotation

User updates key in Panel UI:
1. Old entry is overwritten with new encrypted value
2. New IV + salt generated (not reused)
3. Next `use_api` call automatically uses new key
4. No agent restart needed

### 8.6 Large Response Bodies

`use_api` returns the full response body as a string. For large responses (e.g., streaming completions), this could be problematic. 

Phase 1 limitation: no streaming support. Agent gets the complete response after the upstream request finishes. Streaming can be added later if needed.

---

## 9. Audit Log

All `use_api` calls are logged to `~/.claude/team-hub/vault-audit.log`:

```
2026-04-16T12:30:00Z | alice | openai | POST | https://api.openai.com/v1/chat/completions | 200 | 1234ms
2026-04-16T12:30:05Z | bob | anthropic | POST | https://api.anthropic.com/v1/messages | 429 | 89ms
2026-04-16T12:31:00Z | alice | openai | POST | https://api.openai.com/v1/chat/completions | 200 | 2100ms
```

Fields: timestamp, member, api_name, method, url, response_status, latency_ms.

Request/response bodies are NOT logged (privacy + size). Only metadata.

---

## 10. Implementation Phases

### Phase 1: Core Backend (current)

- `vault-manager.ts` -- encryption + passkey + CRUD
- `api-registry.ts` -- API metadata + presets
- Unit tests for both modules

### Phase 2: Proxy + HTTP Routes

- `api-proxy.ts` -- request proxy + ACL + rate limit
- `panel-api.ts` new routes
- Hub tools: `list_api_keys`, `use_api`
- Session token auth
- Integration tests

### Phase 3: Frontend

- `vault-preload.ts` -- WebAuthn bridge
- `vault-settings.tsx` + `vault-settings.css` -- UI
- Passkey registration/unlock flow
- Key management CRUD UI
- ACL management UI

### Phase 4: Polish

- Auto-lock on idle
- Audit log viewer in Panel
- Rate limit configuration UI
- Streaming support (if needed)
- Security audit

---

## 11. Dependencies

No new npm packages needed for Phase 1-2. All crypto is from Node.js built-in `crypto` module.

For WebAuthn (Phase 3), evaluate:
- `@simplewebauthn/server` + `@simplewebauthn/browser` -- for proper attestation/assertion verification
- Or use Electron's built-in `navigator.credentials` API directly with manual verification

For HTTPS forwarding (Phase 2):
- Node.js built-in `https.request` -- sufficient, no external HTTP client needed

---

**End of design document.**
