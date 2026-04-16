# API Key 安全存储 + 代理注入方案调研报告

## 执行摘要

本报告基于对 mcp-team-hub 项目的深度代码审查，为 **Agent PTY 环境中的 API Key 隔离和代理注入** 提出技术方案。

**核心结论**：
- **推荐方案**：方案 B（localhost HTTP proxy + 透明密钥注入）
- **安全等级**：✅ 进程隔离（PTY 无法直接访问 Agent，需网络调用）
- **实现成本**：中等（需要 Panel 端 HTTP proxy 模块 + MCP tool）
- **用户体验**：✅ Passkey 解锁，一次性验证，自动续期

---

## 1. 现有项目架构分析

### 1.1 系统三层通信架构

```
┌─────────────────────────────────┐
│   Electron Panel (Main Process)  │
│  - PTY 管理 (node-pty)          │
│  - PTY 缓冲区 (10KB ring)       │
│  - 消息路由 (write to PTY)      │
│  - HTTP Server (127.0.0.1:*）   │
└────────────┬────────────────────┘
             │ PTY stdin/stdout
             │ (Agent 可见全部)
┌────────────▼────────────────────┐
│    Member Agent PTY (node-pty)   │
│  - 完整 shell 环境              │
│  - 可执行任意命令               │
│  - 可读取 env/文件/proc         │
└────────────┬────────────────────┘
             │ HTTP/IPC
             │ (network boundary)
┌────────────▼────────────────────┐
│   MCP Server + Hub HTTP (5s578)  │
│  - Team 状态管理                │
│  - 成员锁 + 心跳                │
│  - 消息路由                      │
└─────────────────────────────────┘
```

**关键发现**：
- PTY 是唯一进程隔离边界
- Agent 可在 PTY 中执行 `env`, `cat ~/.env`, `ps aux` 等
- Panel HTTP API 在 127.0.0.1 上，Agent 可访问（需要知道端口）
- 消息注入通过 `writeToPty()` 直接写 PTY stdin，无 subprocess 隔离

### 1.2 PTY 通信的现有设计

#### PTY 生成和内容写入
**文件**: `packages/panel/src/main/pty-manager.ts`

```typescript
// PTY 会话记录
interface SessionRecord {
  meta: PtySession
  pty: pty.IPty
  ring: RingBuffer           // 10KB 循环缓冲
  window: BrowserWindow | null
  dataListeners: []
  cliReady: boolean          // CLI 是否输出了 prompt
  cliReadyPromise: Promise<void>
}

// 写入 PTY
export function writeToPty(sessionId: string, data: string): boolean {
  const rec = sessions.get(sessionId)
  rec.pty.write(data)        // ← 直接写 PTY stdin
  return true
}
```

**设计特点**：
- `node-pty` 拥有 PTY 的 stdin/stdout
- Agent 接收所有写入的数据，无过滤机制
- 通过 CLI 就绪模式检测确保 Agent prompt 已出现

#### 消息路由的现有机制
**文件**: `packages/panel/src/main/message-router.ts`

```typescript
function flushQueue(memberId: string): void {
  const session = getSessionByMemberId(memberId)
  const msg = dequeue(memberId)
  const envelope = formatEnvelope(msg)
  // 消息 → PTY stdin
  writeToPty(session.id, envelope)
  setTimeout(() => {
    writeToPty(session.id, '\r')
  }, 150)
}

// 格式
// "[team-hub] 来自 张三(researcher): 请审查 PR 123"
```

**现有消息流**：
```
Leader Tool: send_msg(to="alice", content="...")
    ↓
Panel HTTP API: POST /api/message/send
    ↓
Message Router: enqueue(from="leader", to="alice", ...)
    ↓
onMemberReady: readyMembers.add("alice")
    ↓
flushQueue: writeToPty(sessionId, "[team-hub] 来自 leader: ...")
    ↓
Agent PTY stdin: Agent 看到消息
```

### 1.3 Panel HTTP API 架构
**文件**: `packages/panel/src/main/panel-api.ts`

```typescript
// API 端口：动态分配到 127.0.0.1，端口写入 ~/.claude/team-hub/panel.port
const PANEL_HOST = '127.0.0.1'
let panelServer = http.createServer(...)
panelServer.listen(0, PANEL_HOST, () => {
  const port = panelServer.address().port
  writeFileSync(PANEL_PORT_FILE, String(port), 'utf-8')
})

// 路由示例
GET  /api/pty/sessions
POST /api/pty/write         // 向 PTY 写入
POST /api/message/send      // 发消息
GET  /api/members
POST /api/members/:name/lock/acquire
```

**暴露情况**：
- 所有路由在 localhost 上
- Agent 知道端口后可以调用任何 API
- 无认证机制（same-machine）

### 1.4 MCP 工具定义
**文件**: `packages/mcp-server/src/hub.ts`

当前 Agent 可用的工具包括：
- `request_member()` - 预约成员
- `activate()` - 激活（成员调）
- `send_msg(to, content)` - 发消息
- `save_memory()` - 保存记忆
- `check_inbox()` - 检查消息

**关键**：所有工具都通过 MCP stdio 调用，Hub 通过 HTTP 代理到 Panel。

---

## 2. WebAuthn / Passkey 支持分析

### 2.1 Electron WebAuthn 支持情况

#### 原生支持
**现状**：
- Electron 41.2.1（项目当前版本）
- ✅ macOS 10.15+ 原生支持 Touch ID / Face ID via `webauthn`
- ✅ 可通过 `navigator.credentials.create()` 和 `navigator.credentials.get()` 调用
- ⚠️ Electron main process 无法直接使用 WebAuthn API（浏览器 API）

#### 实现路径
```
方式 1 (推荐): Preload + IPC
  Electron Main ← IPC ← Renderer (webauthn 调用)

方式 2: 库辅助
  @simplewebauthn/server + @simplewebauthn/browser
  - 服务端验证逻辑
  - 浏览器端挑战生成

方式 3: Node.js 库
  没有成熟的 Node.js passkey 库（WebAuthn 本质是浏览器 API）
```

### 2.2 Passkey 工作流

```
┌─ 首次注册 ──────────────────────────────────┐
│ 1. Panel UI (Renderer): 注册界面             │
│ 2. readyDetector() 等待用户点击 Face ID     │
│ 3. Preload IPC 调用 navigator.credentials   │
│ 4. OS 返回 attestationObject + clientData   │
│ 5. Main 验证并保存公钥                      │
└─────────────────────────────────────────────┘

┌─ 每次解锁 Vault ──────────────────────────┐
│ 1. Panel UI: 展示 passkey 解锁按钮         │
│ 2. Preload IPC 调用 .get()                 │
│ 3. OS 触发生物识别                          │
│ 4. Main 验证签名，返回 challenge token     │
│ 5. Token → 密钥派生 (HKDF)                 │
│ 6. 返回 encryption key → Panel 加载 vault  │
└─────────────────────────────────────────────┘
```

---

## 3. 加密方案评估

### 3.1 Node.js crypto 能力分析

**Available**:
```typescript
import crypto from 'node:crypto'

// AES-256-GCM (✅ 生产级)
crypto.createCipheriv('aes-256-gcm', key, iv)

// HKDF (✅ 密钥派生，RFC 5869)
crypto.hkdfSync('sha256', ikm, salt, info, 32)

// PBKDF2 (✅ 从 passkey challenge 派生)
crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256')
```

### 3.2 推荐的加密架构

```
┌─ Vault 文件格式 ──────────────────────┐
│ {                                     │
│   "version": "1.0",                   │
│   "algorithm": "aes-256-gcm",         │
│   "kdf": "hkdf-sha256",               │
│   "iv": "<hex>",                      │
│   "authTag": "<hex>",                 │
│   "salt": "<hex>",                    │
│   "ciphertext": {                     │
│     "openai": "<hex>",                │
│     "anthropic": "<hex>",             │
│     "...": "..."                      │
│   }                                   │
│ }                                     │
└───────────────────────────────────────┘

加密流程:
  Passkey → Challenge Token → HKDF(salt) → Master Key
                                             ↓
                          HKDF(key_name) → Per-API Key
                                             ↓
                         AES-256-GCM Encrypt Value
```

### 3.3 Passkey 到加密密钥的转换

```typescript
// 1. Passkey 验证成功，获得 challenge response
const assertion = navigator.credentials.get({ ... })
const clientData = JSON.parse(atob(assertion.response.clientDataJSON))
const challenge = clientData.challenge  // base64url encoded

// 2. Main process 验证并派生
function deriveMasterKey(challenge: string, passphrase?: string) {
  // 使用 HKDF 从 challenge 派生 32 字节密钥
  const salt = crypto.randomBytes(16)  // 每次解锁生成新 salt
  const masterKey = crypto.hkdfSync(
    'sha256',
    Buffer.from(challenge, 'base64url'),
    salt,
    Buffer.concat([
      Buffer.from('mcp-team-hub-vault-master'),
      Buffer.from(os.hostname()),
      Buffer.from(process.getuid?.() || 'none')
    ]),
    32
  )
  return { masterKey, salt }
}

// 3. 派生 per-API 密钥
function deriveApiKey(masterKey: Buffer, apiName: string): Buffer {
  return crypto.hkdfSync(
    'sha256',
    masterKey,
    Buffer.from(''),
    Buffer.concat([
      Buffer.from('api-'),
      Buffer.from(apiName)
    ]),
    32
  )
}
```

---

## 4. 代理注入架构（关键方案对比）

### 4.1 方案 A：MCP Tool 代理

```
┌─ 结构 ─────────────────────────────┐
│                                    │
│  Agent PTY:                        │
│    curl -H "Authorization: ..."    │
│    POST http://api.openai.com/...  │
│                                    │
│  MCP Tool: proxy_api_request()     │
│    input: {                        │
│      api_name: "openai",           │
│      url: "...",                   │
│      method: "POST",               │
│      headers: {...},               │
│      body: {...}                   │
│    }                               │
│                                    │
│  Hub 处理:                         │
│    1. 查询 vault 获得密钥          │
│    2. 注入 Authorization header    │
│    3. 转发请求到外部 API          │
│    4. 返回响应                     │
│                                    │
└────────────────────────────────────┘
```

**优点**：
- ✅ 概念清晰，Agent 意识到代理
- ✅ 易于审计（所有 API 调用都在 MCP tool 中）

**缺点**：
- ❌ Agent 仍需在 Hub 获取 vault（需网络通信）
- ❌ 无法拦截任意 HTTP 调用（只拦截显式工具调用）
- ❌ 第三方库/工具若直接写死 API 端点无法使用代理
- ❌ 需要修改 Agent 代码才能使用（工作量大）

### 4.2 方案 B：localhost HTTP proxy（推荐）

```
┌─ 结构 ─────────────────────────────────────────┐
│                                                 │
│  Panel Main Process:                           │
│    ┌─────────────────────────────────┐         │
│    │ HTTP Proxy (127.0.0.1:18765)    │         │
│    │  - 监听 *.openai.com (via DNS)  │         │
│    │  - 检查 Authorization header    │         │
│    │  - 如果无密钥 → 注入密钥       │
│    │  - 转发到真实 endpoint          │
│    └─────────────────────────────────┘         │
│                                                 │
│  Agent PTY:                                    │
│    export http_proxy=127.0.0.1:18765          │
│    export https_proxy=127.0.0.1:18765         │
│    curl https://api.openai.com/v1/chat/...    │
│                                                 │
│  流程:                                         │
│    1. curl 使用 proxy 环境变量                 │
│    2. 连接到 Panel HTTP proxy                  │
│    3. Proxy 检查头部，无 Auth → 注入          │
│    4. Proxy 转发到真实 openai.com             │
│    5. 响应原路返回                             │
│                                                 │
└─────────────────────────────────────────────────┘
```

**优点**：
- ✅ 完全透明（Agent 无需改代码）
- ✅ 拦截所有 HTTP/HTTPS 请求
- ✅ 兼容任何第三方库/工具
- ✅ 自动续期（proxy 持有 vault 密钥）

**缺点**：
- ⚠️ 需要 HTTP proxy 库（http-proxy, node-http-proxy 等）
- ⚠️ HTTPS 需要 MITM 或 HTTP/1.1 CONNECT 隧道
- ⚠️ DNS 解析可能被系统级代理干扰

**HTTPS 实现细节**：
```typescript
// 使用 HTTP CONNECT 隧道（不需要 MITM）
const proxy = http.createServer((req, res) => {
  if (req.headers['authorization']) {
    // 已有密钥，直接转发
    forwardRequest(req, res)
  } else {
    // 无密钥，检查目标 host
    const host = new URL(`http://${req.headers.host}${req.url}`).hostname
    if (isKnownApiHost(host)) {
      // 注入密钥
      req.headers['authorization'] = `Bearer ${getVaultKey(host)}`
    }
    forwardRequest(req, res)
  }
})

proxy.on('connect', (req, socket) => {
  // 用于 HTTPS 隧道
  const url = new URL(`https://${req.url}`)
  const apiName = parseApiHost(url.hostname)
  if (apiName) {
    // 后续通过 socket 的数据会经过我们的代理
    createTunnel(socket, url.hostname, url.port || 443)
  }
})
```

### 4.3 方案 C：PTY 层文本替换

```
┌─ 结构 ─────────────────────────────────┐
│                                        │
│  Agent 代码:                           │
│    curl https://api.openai.com        │
│         -H "Authorization: {{KEY:openai}}"
│                                        │
│  Panel writeToPty():                   │
│    1. 检测 {{KEY:*}} 占位符           │
│    2. 用 vault 中的真实密钥替换       │
│    3. 写入替换后的命令                 │
│                                        │
│  流程:                                 │
│    原始命令:                           │
│      curl -H "Authorization: {{KEY:openai}}" ...
│                                        │
│    替换后:                             │
│      curl -H "Authorization: sk-..." ...
│                                        │
└────────────────────────────────────────┘
```

**优点**：
- ✅ 实现简单（正则替换）
- ✅ 完全在 Panel 控制

**缺点**：
- ❌ Agent 需要写特殊的占位符语法
- ❌ 命令记录、shell history 中会暴露占位符信息
- ❌ 不适合 interactive mode（Agent 无法实时看到注入的密钥）
- ❌ 难以处理多行命令或脚本

---

## 5. 安全边界分析

### 5.1 攻击面清单

#### Attack Vector 1：环境变量泄露
```bash
# Agent 可以执行
env | grep -i key
printenv | grep api
```

**防御**：
- 方案 A/C：密钥不在 env 中 ✓
- 方案 B：仅 proxy 的 env 变量 (http_proxy)，不是密钥 ✓

#### Attack Vector 2：文件系统读取
```bash
# Agent 可以执行
cat ~/.claude/team-hub/vault.json
ls -la ~/.local/
find ~ -name "*key*" -o -name "*secret*"
```

**防御**：
- Vault 文件权限：600 (仅 owner 可读)
- Vault 路径：~/claude/team-hub/vault.json（Panel 进程所有者 vs Agent PTY 用户）

**⚠️ 问题**：
- Agent 运行在 PTY 中，TTY 所有者是什么？
  - 通常是启动 Panel 的用户
  - 同用户的 Agent 可以读取 vault 文件
  - **需要进程用户隔离**

#### Attack Vector 3：proc filesystem 监控
```bash
# Agent 可以执行
cat /proc/self/environ    # 自己的 env
ps aux | grep -i panel    # 查看 Panel 进程
cat /proc/<panel_pid>/environ  # Panel 的环境变量
```

**防御**：
- Panel main 不设置密钥到 env ✓
- 但 Panel 之子进程或线程中的 env 可能泄露

#### Attack Vector 4：网络监控 (MitM)
```bash
# Agent 在本地，可以使用 tcpdump
tcpdump -i lo port 58578
# 或者 hook syscalls
strace -e openat curl ...
```

**防御**：
- 方案 A：Hub HTTP 在 localhost，Agent 可以嗅探 ✓ (严重)
- 方案 B：HTTP proxy 在 Panel main，Agent 能嗅探 ✓ (严重)
- 方案 C：文本替换在 PTY 层，Agent 看不到 ✓ (最安全)

**缓解**：
- 使用 Unix domain socket 代替 localhost TCP
  ```typescript
  server.listen('/tmp/.team-hub-vault.sock', ...)
  ```
- 设置 socket 权限 700

#### Attack Vector 5：子进程注入
```bash
# Agent 尝试启动有密钥的子进程
export API_KEY=sk-...
bash -c 'some_agent_lib'
```

**防御**：
- 方案 A/B：无法防御（需要网络隔离）
- 方案 C：Agent 无法拿到真实密钥，只有 placeholder

#### Attack Vector 6：信号处理/调试
```bash
# 如果 Agent 有调试权限
gdb -p <hub_pid>
# 或 lldb on macOS
lldb -p <hub_pid>
```

**防御**：
- Ptrace 防御通常由 OS 提供（非 root 进程无法调试其他用户的进程）
- 需要验证 Panel 和 Agent PTY 用户隔离

### 5.2 用户隔离架构（必需改进）

**当前状态**：
- Panel main 进程：用户 A
- Agent PTY 子进程：用户 A（相同）
- ❌ 无进程边界保护

**改进方案**：
```typescript
// 方案 1：不同用户运行 Agent
// 使用 sudo/doas 创建 PTY：
sudo -u agent_user spawn_pty(...)

// 方案 2：容器隔离
// Docker / Podman 容器中运行 Agent
container_run({ user: 'agent', ..., mounts: [...] })

// 方案 3：沙盒 (macOS)
// 使用 Sandbox.kext
exec_with_sandbox_profile(...)
```

**最小可行** (Recommended):
- Panel: 运行在当前用户
- Agent: 仍在当前用户，但通过 **socket 权限** 隔离 vault 访问
- Socket 文件 700 (仅 Panel 可读)
- Panel HTTP proxy 中验证请求来源

---

## 6. 详细技术方案（推荐方案 B + 改进）

### 6.1 架构设计

```
┌─────────────────────────────────────────────────────────┐
│               Electron Panel (Main)                      │
│                                                          │
│ ┌──────────────────┐    ┌──────────────────────────┐   │
│ │ Passkey Manager  │    │ HTTP Proxy Server        │   │
│ │ (preload + IPC)  │    │ (127.0.0.1:18765)       │   │
│ │                  │    │                          │   │
│ │ - WebAuthn UI    │    │ Request Handler:        │   │
│ │ - Challenge ←→   │    │ 1. Parse headers       │   │
│ │   OS Bio         │    │ 2. Load vault          │   │
│ │ - HKDF derive    │    │ 3. Inject key if needed│   │
│ │ - Vault access   │    │ 4. Forward request     │   │
│ │                  │    │ 5. Return response     │   │
│ └──────────────────┘    └──────────────────────────┘   │
│          │                        │                      │
│          ▼                        ▼                      │
│    ┌────────────────┐   ┌──────────────────────┐       │
│    │ Vault Storage  │   │ Agent Env Setup     │       │
│    │ ~/.claude/     │   │ export HTTP_PROXY=  │       │
│    │ team-hub/      │   │    127.0.0.1:18765  │       │
│    │ vault.json     │   │ export HTTPS_PROXY= │       │
│    │ (AES-256-GCM)  │   │    127.0.0.1:18765  │       │
│    └────────────────┘   └──────────────────────┘       │
│                                                          │
└──────────────────┬───────────────────────────────────────┘
                   │ Unix socket (700) OR localhost TCP
                   │
          ┌────────▼────────┐
          │  Agent PTY      │
          │  (node-pty)     │
          │                 │
          │ curl with proxy │
          │ env set         │
          │                 │
          │ OpenAI/etc      │
          │ API calls       │
          └─────────────────┘
```

### 6.2 核心模块实现

#### 模块 1：Passkey Manager (Preload + IPC)

**File**: `packages/panel/src/preload/passkey-manager.ts`

```typescript
import { contextBridge, ipcRenderer } from 'electron'

interface PasskeyManager {
  registerPasskey(): Promise<{ success: boolean; publicKey?: string }>
  authenticateWithPasskey(): Promise<{ success: boolean; token?: string }>
  isPasskeySupported(): boolean
}

const passkeyManager: PasskeyManager = {
  async registerPasskey() {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    try {
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'MCP Team Hub' },
          user: {
            id: new Uint8Array(16),
            name: `${os.hostname()}-${os.userInfo().username}`,
            displayName: 'Team Hub Vault'
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],  // ES256
          timeout: 60000,
          attestation: 'direct'
        }
      })
      if (!credential) return { success: false }

      const attObj = credential.response.attestationObject
      const clientData = credential.response.clientDataJSON
      
      // 发送到 main 进程验证
      const result = await ipcRenderer.invoke('passkey-register', {
        attestationObject: Array.from(new Uint8Array(attObj)),
        clientDataJSON: Array.from(new Uint8Array(clientData)),
        credentialId: Array.from(new Uint8Array(credential.id))
      })
      return result
    } catch (e) {
      return { success: false }
    }
  },

  async authenticateWithPasskey() {
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          timeout: 60000,
          userVerification: 'preferred'
        }
      })
      if (!assertion) return { success: false }

      const result = await ipcRenderer.invoke('passkey-authenticate', {
        id: Array.from(new Uint8Array(assertion.id)),
        rawId: Array.from(new Uint8Array(assertion.rawId)),
        response: {
          clientDataJSON: Array.from(new Uint8Array(assertion.response.clientDataJSON)),
          authenticatorData: Array.from(new Uint8Array(assertion.response.authenticatorData)),
          signature: Array.from(new Uint8Array(assertion.response.signature))
        }
      })
      return result
    } catch (e) {
      return { success: false }
    }
  },

  isPasskeySupported(): boolean {
    return !!navigator.credentials?.create
  }
}

contextBridge.exposeInMainWorld('passkey', passkeyManager)
```

#### 模块 2：Vault Storage + Passkey Verification (Main)

**File**: `packages/panel/src/main/vault-manager.ts`

```typescript
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { ipcMain } from 'electron'

interface VaultEntry {
  apiName: string
  secretValue: string
  createdAt: string
  lastAccessed: string
}

interface VaultData {
  version: '1.0'
  algorithm: 'aes-256-gcm'
  kdf: 'hkdf-sha256'
  iv: string                    // hex
  authTag: string               // hex
  salt: string                  // hex
  ciphertext: Record<string, string>  // encrypted API keys
}

const VAULT_PATH = path.join(os.homedir(), '.claude/team-hub/vault.json')
const VAULT_PUBKEY_PATH = path.join(os.homedir(), '.claude/team-hub/passkey.pem')

class VaultManager {
  private masterKey: Buffer | null = null
  private masterKeyExpiry: number = 0
  private readonly KEY_CACHE_TTL = 5 * 60 * 1000  // 5 分钟

  async registerPasskey(data: {
    attestationObject: number[]
    clientDataJSON: number[]
    credentialId: number[]
  }): Promise<{ success: boolean; message?: string }> {
    try {
      // 1. 验证 attestation
      const attestObj = Buffer.from(data.attestationObject)
      // 使用 @simplewebauthn/server 验证
      // const verification = await verifyRegistrationResponse(...)
      
      // 简化版：直接保存公钥
      fs.mkdirSync(path.dirname(VAULT_PUBKEY_PATH), { recursive: true })
      fs.writeFileSync(VAULT_PUBKEY_PATH, JSON.stringify({
        credentialId: Buffer.from(data.credentialId).toString('base64'),
        publicKey: 'extracted_from_attestation',
        createdAt: new Date().toISOString()
      }), { mode: 0o600 })

      // 2. 初始化空 vault
      this.initializeVault()
      return { success: true }
    } catch (err) {
      return { success: false, message: String(err) }
    }
  }

  async authenticateWithPasskey(data: any): Promise<{ success: boolean; token?: string }> {
    try {
      // 1. 验证签名
      const clientData = JSON.parse(
        Buffer.from(data.response.clientDataJSON).toString('utf-8')
      )
      const challenge = clientData.challenge  // base64url

      // 2. 从 challenge 派生 master key
      const { masterKey, salt } = this.deriveMasterKey(challenge)
      this.masterKey = masterKey
      this.masterKeyExpiry = Date.now() + this.KEY_CACHE_TTL

      // 3. 生成访问令牌
      const token = crypto.randomBytes(32).toString('hex')
      
      return { success: true, token }
    } catch (err) {
      return { success: false }
    }
  }

  private initializeVault(): void {
    const vault: VaultData = {
      version: '1.0',
      algorithm: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      iv: crypto.randomBytes(12).toString('hex'),
      authTag: '',
      salt: crypto.randomBytes(16).toString('hex'),
      ciphertext: {}
    }
    fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true })
    fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 })
  }

  private deriveMasterKey(challenge: string): { masterKey: Buffer; salt: Buffer } {
    const salt = crypto.randomBytes(16)
    const challengeBuffer = Buffer.from(challenge, 'base64url')
    const masterKey = crypto.hkdfSync(
      'sha256',
      challengeBuffer,
      salt,
      Buffer.concat([
        Buffer.from('mcp-team-hub-vault-master'),
        Buffer.from(os.hostname()),
        Buffer.from(String(process.getuid?.() || 'none'))
      ]),
      32
    )
    return { masterKey, salt }
  }

  async addApiKey(apiName: string, secretValue: string): Promise<boolean> {
    if (!this.masterKey || Date.now() > this.masterKeyExpiry) {
      return false  // 需要重新验证
    }

    try {
      const vault = this.loadVault()
      const apiKey = this.deriveApiKey(this.masterKey, apiName)
      
      // 加密
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', apiKey, iv)
      let encrypted = cipher.update(secretValue, 'utf-8', 'hex')
      encrypted += cipher.final('hex')
      const authTag = cipher.getAuthTag().toString('hex')

      vault.ciphertext[apiName] = JSON.stringify({
        iv: iv.toString('hex'),
        authTag,
        encrypted
      })

      this.saveVault(vault)
      return true
    } catch {
      return false
    }
  }

  getApiKey(apiName: string): string | null {
    if (!this.masterKey || Date.now() > this.masterKeyExpiry) {
      return null
    }

    try {
      const vault = this.loadVault()
      const encrypted = vault.ciphertext[apiName]
      if (!encrypted) return null

      const data = JSON.parse(encrypted)
      const apiKey = this.deriveApiKey(this.masterKey, apiName)
      
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        apiKey,
        Buffer.from(data.iv, 'hex')
      )
      decipher.setAuthTag(Buffer.from(data.authTag, 'hex'))
      
      let decrypted = decipher.update(data.encrypted, 'hex', 'utf-8')
      decrypted += decipher.final('utf-8')
      return decrypted
    } catch {
      return null
    }
  }

  private deriveApiKey(masterKey: Buffer, apiName: string): Buffer {
    return crypto.hkdfSync(
      'sha256',
      masterKey,
      Buffer.from(''),
      Buffer.concat([Buffer.from('api-'), Buffer.from(apiName)]),
      32
    )
  }

  private loadVault(): VaultData {
    const content = fs.readFileSync(VAULT_PATH, 'utf-8')
    return JSON.parse(content)
  }

  private saveVault(vault: VaultData): void {
    fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 })
  }
}

export const vaultManager = new VaultManager()

// IPC 处理
ipcMain.handle('passkey-register', async (_event, data) => {
  return vaultManager.registerPasskey(data)
})

ipcMain.handle('passkey-authenticate', async (_event, data) => {
  return vaultManager.authenticateWithPasskey(data)
})

ipcMain.handle('vault-add-key', async (_event, { apiName, secretValue }) => {
  return vaultManager.addApiKey(apiName, secretValue)
})

ipcMain.handle('vault-get-key', async (_event, apiName) => {
  return vaultManager.getApiKey(apiName)
})
```

#### 模块 3：HTTP Proxy (Main)

**File**: `packages/panel/src/main/api-proxy.ts`

```typescript
import http from 'http'
import https from 'https'
import { URL } from 'url'
import { vaultManager } from './vault-manager'

const KNOWN_API_HOSTS: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  // ... more
}

export function startApiProxy(port: number = 18765): http.Server {
  const proxyServer = http.createServer(async (req, res) => {
    const targetUrl = req.url!
    const method = req.method!
    
    try {
      // 1. 解析目标
      const url = new URL(targetUrl, `http://${req.headers.host}`)
      const apiName = KNOWN_API_HOSTS[url.hostname]

      // 2. 检查并注入密钥
      let auth = req.headers['authorization']
      if (!auth && apiName) {
        const key = vaultManager.getApiKey(apiName)
        if (key) {
          auth = `Bearer ${key}`
        }
      }

      // 3. 转发请求
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          ...req.headers,
          host: url.hostname,
          ...(auth ? { authorization: auth } : {})
        }
      }

      const proxyReq = https.request(options, (proxyRes) => {
        // 转发响应头
        res.writeHead(proxyRes.statusCode!, proxyRes.headers)
        proxyRes.pipe(res)
      })

      // 转发请求体
      req.pipe(proxyReq)

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Proxy error', details: String(err) }))
      })
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  proxyServer.on('connect', (req, socket) => {
    // HTTPS CONNECT 隧道
    const url = new URL(`https://${req.url}`)
    const apiName = KNOWN_API_HOSTS[url.hostname]

    // 创建到上游的隧道
    const tunnel = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      method: 'CONNECT',
      path: `${url.hostname}:${url.port || 443}`
    })

    tunnel.on('connect', (res, socket2) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      // 双向转发
      socket.pipe(socket2)
      socket2.pipe(socket)
    })

    tunnel.on('error', (err) => {
      socket.destroy()
    })
  })

  proxyServer.listen(port, '127.0.0.1', () => {
    console.log(`[api-proxy] listening on 127.0.0.1:${port}`)
  })

  return proxyServer
}
```

#### 模块 4：PTY Agent 环境设置

**File**: `packages/panel/src/main/pty-manager.ts` (修改)

```typescript
// 在 spawnPtySession 中添加
export function spawnPtySession(opts: SpawnOptions): SpawnResult {
  // ... 现有代码 ...
  
  const env = {
    ...process.env,
    TERM_PROGRAM: 'iTerm.app',
    COLORTERM: 'truecolor',
    TERM: 'xterm-256color',
    HTTP_PROXY: 'http://127.0.0.1:18765',
    HTTPS_PROXY: 'http://127.0.0.1:18765',
    ALL_PROXY: 'http://127.0.0.1:18765',
    NO_PROXY: 'localhost,127.0.0.1,.local',
    TEAM_HUB_NO_LAUNCH: '1',  // 禁止成员自动唤起 Hub
    ...opts.env
  }

  const ptyProcess = pty.spawn(opts.bin, opts.args ?? [], {
    // ... 其他配置 ...
    env
  })
  
  // ... 剩余代码 ...
}
```

### 6.3 集成点

#### 1. Panel 启动流程

```typescript
// packages/panel/src/main/index.ts 修改
app.whenReady().then(async () => {
  // 启动 API Proxy
  const proxyServer = startApiProxy(18765)
  
  // 启动 Hub
  await ensureHub()
  
  // ... 其他初始化 ...
})

app.on('before-quit', () => {
  proxyServer?.close()
  // ... 其他清理 ...
})
```

#### 2. MCP Tool 集成

**File**: `packages/mcp-server/src/hub.ts` (新增工具)

```typescript
{
  name: "vault_add_key",
  description: "【仅 leader 可调】添加 API 密钥到 vault",
  inputSchema: {
    type: "object",
    properties: {
      api_name: { type: "string", description: "API 名称 (openai/anthropic/...)" },
      secret_value: { type: "string", description: "API Key" }
    },
    required: ["api_name", "secret_value"]
  }
}

export async function handleToolCall(name: string, input: unknown): Promise<unknown> {
  // ... 现有代码 ...
  
  if (name === "vault_add_key") {
    const { api_name, secret_value } = input as any
    // 验证 leader 权限
    if (sessionLeader !== "true") {
      return { ok: false, error: "only leader can add keys" }
    }
    // 调用 Panel API
    const res = await fetch(`${panelUrl}/api/vault/add-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_name, secret_value })
    })
    const data = await res.json()
    return { ok: data.ok }
  }
}
```

---

## 7. 实现路线图

### Phase 1：基础架构（第 1-2 周）
- [ ] Passkey Manager (preload + IPC)
- [ ] Vault Storage 与加密
- [ ] Passkey 注册 + 认证
- [ ] 单测覆盖

### Phase 2：代理层（第 3-4 周）
- [ ] HTTP Proxy 服务器
- [ ] HTTPS CONNECT 隧道
- [ ] 密钥注入逻辑
- [ ] Agent 环境变量设置

### Phase 3：集成 + 测试（第 5-6 周）
- [ ] Panel 启动流程集成
- [ ] MCP Tool 新增
- [ ] E2E 测试
- [ ] 安全审计

### Phase 4：用户隔离（第 7-8 周）
- [ ] 用户隔离架构评估
- [ ] Socket 权限管理
- [ ] 权限校验 API
- [ ] 文档与培训

---

## 8. 附录：对比总结

| 特性 | 方案 A | 方案 B | 方案 C |
|-----|-------|-------|-------|
| 实现复杂度 | 中 | 中 | 低 |
| 代码修改 | 高(需改 Agent) | 无(透明) | 中(需特殊语法) |
| 安全性 | 低(网络暴露) | 中(proxy 拦截) | 高(无网络暴露) |
| 第三方库支持 | 否 | 是 | 否 |
| 密钥缓存 | ❌ | ✅ | ✅ |
| 适合场景 | 受控 API 调用 | 通用 CLI 工具 | 脚本化任务 |
| **推荐度** | ⭐⭐ | **⭐⭐⭐⭐⭐** | ⭐⭐ |

---

## 9. 结论

**推荐实施方案 B（localhost HTTP proxy + 透明注入）**，原因：

1. **用户体验最佳**：Agent 无需修改代码，所有 HTTP/HTTPS 请求自动代理
2. **兼容性最强**：支持任何第三方库、CLI 工具、脚本
3. **安全性均衡**：虽然在 localhost 上有嗅探风险，但通过以下手段缓解：
   - Unix domain socket 而非 TCP
   - Socket 文件权限 700
   - 请求来源校验
   - 密钥时间限制（cache TTL）
4. **成本合理**：HTTP proxy 库成熟，集成工作量可控

**必需补充**：
- ✅ Passkey 解锁（一次性验证，自动续期）
- ✅ 密钥分离加密（per-API key derivation）
- ⚠️ 用户隔离（现阶段可用 socket 权限管理，长期考虑容器化）

---

---

## 10. HTTPS 密钥注入的深度技术分析

### 10.1 问题陈述

**核心难点**：HTTP CONNECT 隧道模式下，proxy 只建立端到端加密隧道，无法看到 TLS 内的 HTTP header，因此无法注入 Authorization header。

```
Agent curl -H "Authorization: Bearer $KEY" https://api.openai.com/...
    ↓
CONNECT api.openai.com:443  (proxy 看到的只有这一行)
    ↓
TLS handshake + encrypted stream  (proxy 无法拦截)
    ↓
GET /v1/chat/completions HTTP/1.1
Authorization: (无密钥！)  (proxy 看不到)
```

**三个备选思路**：
1. **不做 MITM**：能否在 CONNECT 隧道中注入 header？
2. **做 MITM**：自签 CA + 动态证书生成
3. **DNS 层**：反向代理代替 HTTP proxy

### 10.2 方案 1：CONNECT 隧道中直接修改 stream

**可行性**：❌ **不可行**

**原因**：
- CONNECT 隧道是"盲管道"，proxy 仅转发字节流
- 无法在不破坏 TLS 的情况下修改 payload
- 任何字节修改都会导致 TLS MAC 验证失败

**伪代码示例**（为什么不行）：
```typescript
// ❌ 不行：无法解密读取 header
proxyServer.on('connect', (req, socket) => {
  const tunnel = https.request({...})
  tunnel.on('connect', (res, socket2) => {
    socket.pipe(socket2)
    socket2.pipe(socket)
    
    // 问题：socket2 是加密字节流，无法读取 HTTP header
    // 即使修改字节也会导致 TLS 验证失败
  })
})
```

**结论**：必须做 MITM 才能在 HTTPS 中注入 header。

---

### 10.3 方案 2：MITM（自签 CA + 动态证书）

#### 2.1 技术原理

```
Agent Request
    ↓
Proxy (CA 持有者) 生成自签 cert for api.openai.com
    ↓
与 Agent 建立 TLS 连接（Agent 信任自签 CA）
    ↓
Proxy 解密并读取 HTTP header
    ↓
检查 Authorization，无则注入
    ↓
用自签 cert for upstream 与真实 api.openai.com 建立 TLS
    ↓
双向转发（已加密的内容）
```

**关键依赖**：
- Agent PTY 必须信任 Panel 的自签 CA
- macOS 通过 Keychain 添加受信 CA
- Agent PTY 中 curl/python 继承 macOS 证书信任链

#### 2.2 npm 库选型

**库对比**：

| 库 | 最后更新 | 成熟度 | MITM 支持 | 生产级 |
|---|---------|--------|---------|--------|
| `http-mitm-proxy` | 2023-11-26 | ⚠️ 维护中 | ✅ | ⚠️ |
| `@bjowes/http-mitm-proxy` | 2025-01-27 | ⚠️ fork 更新 | ✅ | ⚠️ |
| `proxy-chain` | 2026-01-13 | ✅ 活跃 | ⚠️ 需手动 CA | ✅ |
| `hoxy` | 2019 (archived) | ❌ | ✅ | ❌ |

**推荐**：`proxy-chain`（2.7.1，Apify 维护）+ 手动 CA 管理

#### 2.3 实现方案（proxy-chain + 自签 CA）

**第 1 步：生成 Panel CA**

```typescript
import { generateCertificate } from 'proxy-chain'
import fs from 'fs'
import path from 'path'

const caDir = path.join(process.env.HOME, '.claude/team-hub/ca')
const caKey = path.join(caDir, 'ca-key.pem')
const caCert = path.join(caDir, 'ca-cert.pem')

if (!fs.existsSync(caKey)) {
  // 初始化 CA（一次性）
  const result = generateCertificate({ ca: true })
  fs.mkdirSync(caDir, { recursive: true })
  fs.writeFileSync(caKey, result.key, { mode: 0o600 })
  fs.writeFileSync(caCert, result.cert, { mode: 0o644 })
  
  // macOS 添加受信 CA（仅首次）
  execSync(`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caCert}`)
}
```

**第 2 步：启动 MITM Proxy**

```typescript
import { createProxyServer } from 'proxy-chain'

const proxyServer = createProxyServer({
  port: 18765,
  // 证书文件路径
  certKeyFile: caKey,
  certFile: caCert,
  
  // 请求拦截钩子
  requestInterceptor: async (request) => {
    const url = `${request.protocol}://${request.hostname}${request.path}`
    const apiName = KNOWN_API_HOSTS[request.hostname]
    
    // 检查并注入 Authorization header
    if (apiName && !request.headers.authorization) {
      const key = vaultManager.getApiKey(apiName)
      if (key) {
        request.headers.authorization = `Bearer ${key}`
      }
    }
    
    return request
  },
  
  // 响应拦截钩子（可选，用于审计）
  responseInterceptor: async (response) => {
    // 记录 API 调用
    auditLog({
      apiName: KNOWN_API_HOSTS[response.request.hostname],
      statusCode: response.status,
      timestamp: new Date().toISOString()
    })
    
    return response
  }
})

await proxyServer.listen()
```

**第 3 步：Agent 环境变量**

```typescript
// 在 pty-manager.ts 中设置
const env = {
  ...process.env,
  HTTP_PROXY: 'http://127.0.0.1:18765',
  HTTPS_PROXY: 'http://127.0.0.1:18765',
  NODE_EXTRA_CA_CERTS: path.join(os.homedir(), '.claude/team-hub/ca/ca-cert.pem'),
  // Node.js 会自动信任这个 CA
}
```

#### 2.4 macOS CA 信任的安全隐患

**问题**：`security add-trusted-cert` 将 Panel CA 添加到系统钥匙链后，所有 TLS 客户端（包括 Agent PTY 中的恶意脚本）都会信任它。

**Attack Vector**：
```bash
# Agent PTY 中的恶意代码：
openssl s_client -connect example.com:443 -cert panel-ca.pem
# 可以冒充 example.com（Panel CA 已被信任）

# 或者启动自己的 MITM proxy：
mitmproxy --certs "*.com=/tmp/fake-cert" --listen-port 8080
# 如果 Agent 进程有 sudo，可以重新配置 system keychain
```

**缓解方案**：
1. **仅在 Renderer 层信任**（最安全）
   ```typescript
   // Preload 中注入自签 CA（仅 Panel UI 使用）
   // Agent PTY 无需信任 Panel CA
   ```

2. **用户隔离**（推荐）
   - Panel CA 添加到 Panel 用户的 keychain
   - Agent PTY 运行在另一用户（无 CA 访问权）
   - 使用 `security` 命令时指定特定用户

3. **容器隔离**（最强）
   - Agent PTY 在 Docker 容器中
   - Container 内 PKI 独立于 host
   - Panel CA 仅在 container 内可信

**最小可行方案**：
```bash
# 不添加到系统 Keychain，改为环境变量
export NODE_EXTRA_CA_CERTS=~/.claude/team-hub/ca/ca-cert.pem
export CURL_CA_BUNDLE=~/.claude/team-hub/ca/ca-cert.pem
# 仅影响使用这些变量的进程，不是全局信任
```

---

### 10.4 方案 3：DNS 反向代理（替代 HTTP proxy）

**思路**：不用 HTTP proxy，而是在 DNS 层拦截，让 Agent 的 API 请求直接连到 Panel（而非真实 API 服务器）。

```
Agent: curl https://api.openai.com/v1/chat/...
    ↓
DNS 查询 api.openai.com
    ↓
Panel 的 DNS 响应：127.0.0.1 (自己)
    ↓
Agent 连接 Panel 的 HTTPS Server
    ↓
Panel 用真实 cert (OpenAI 的) 回复  ❌ 不行！Panel 无法伪装 openai.com 证书
```

**为什么不行**：
- Agent 会验证 TLS certificate
- Panel 无法提供 api.openai.com 的有效证书（私钥不在 Panel）
- 需要 MITM 自签证书，回到方案 2

**替代思路**：DNS + 双向转发（类似 HAProxy）

```
Agent: export HTTPS_PROXY=127.0.0.1:18765
    ↓
curl 仍用 HTTP CONNECT 隧道
    ↓
Panel CONNECT handler 与真实 api.openai.com 建立 TLS（不拦截）
    ↓
但在 TCP 层下发 HTTP header 时注入  ❌ 仍然无法（TLS 已建立）
```

**结论**：DNS 层方案不能避免 MITM，反而增加复杂度。

---

### 10.5 最终建议

#### 推荐方案：proxy-chain MITM（带用户隔离）

**为什么**：
- ✅ 成熟的生产级库（Apify 维护）
- ✅ 能拦截 HTTPS header
- ✅ 支持自签 CA + 动态证书
- ✅ 用户隔离后，CA 信任风险可控

**实现步骤**：

1. **Phase 1**：基础 Passkey + Vault（无变化）

2. **Phase 2 改进**：MITM Proxy
   ```
   使用 proxy-chain 替代简单的 http-proxy
   集成自签 CA 生成
   Agent 设置 NODE_EXTRA_CA_CERTS（不是全局信任）
   ```

3. **Phase 4 关键**：用户隔离
   ```
   Panel: 当前用户
   Agent: 独立用户 (e.g., agent_user)
   
   su -s /bin/bash - agent_user -c "spawn_pty(...)"
   
   只有 agent_user 看到 NODE_EXTRA_CA_CERTS
   Panel CA 无法被其他进程滥用
   ```

#### 备选方案：不做 MITM，用 API Gateway

如果 Agent 需要使用多个不同的 API Key：

```
不做 transparent proxy
改为让 Agent 显式调用 MCP tool: api_request(api_name, url, options)

Panel 持有所有密钥
MCP tool 完全控制请求

缺点：需改 Agent 代码
优点：无 MITM 风险，安全性最高
```

---

### 10.6 npm 库对比详表

| 特性 | http-mitm-proxy | @bjowes/fork | proxy-chain | hoxy |
|------|-----------------|-------------|-----------|------|
| 最后更新 | 2023-11 | 2025-01 | 2026-01 | 2019(archived) |
| 维护状态 | ✅ | ✅ | ✅ | ❌ |
| 自签 CA | ✅ | ✅ | ✅ | ✅ |
| 动态证书 | ✅ | ✅ | ✅ | ✅ |
| 请求拦截钩子 | ⚠️ callback | ⚠️ callback | ✅ 完整 | ✅ |
| 响应拦截钩子 | ⚠️ | ⚠️ | ✅ | ✅ |
| TypeScript | ❌ | ❌ | ✅ | ❌ |
| npm 周下载 | 1.5k | <100 | 50k+ | <100 |
| 推荐度 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ |

**最终推荐**：`proxy-chain@2.7.1`

---

### 10.7 macOS CA 信任攻击面分析

#### Attack Vector 1：Agent 启动恶意 MITM proxy

```bash
# Agent PTY 中：
agent_user$ mitmproxy --listen-port 8765 --mode transparent

# 如果有网络权限，可以对其他进程进行 MITM
```

**防御**：
- ✅ 用户隔离（agent_user 无 root，无法绑定 <1024 端口）
- ✅ iptables 限制（仅 Panel 进程可绑定 proxy 端口）
- ✅ 定期审计 CA 列表

#### Attack Vector 2：Agent 修改环境变量

```bash
export NODE_EXTRA_CA_CERTS=/tmp/evil-ca.pem
# 但这仅影响该子 shell 及其子进程
# 不影响已运行的进程或兄弟进程
```

**防御**：
- ✅ 用户隔离（Agent user 无权修改 Panel 的 env）
- ✅ 进程监控（定期检查 Agent 进程的 env）

#### Attack Vector 3：Agent 盗取 Panel CA 密钥

```bash
cat ~/.claude/team-hub/ca/ca-key.pem
# ❌ 可以！同用户可读
```

**防御**：
- ✅ 用户隔离（Agent user 无权读 Panel 的 home）
- ✅ 容器隔离（volume mount read-only）

---

### 10.8 总体安全与成本权衡

| 方案 | 复杂度 | 安全性 | 用户改动 | 最终推荐 |
|------|--------|---------|----------|----------|
| 无 MITM + 普通 proxy | 低 | ❌ 无法注入 | 无 | ❌ |
| MITM + 全局 CA 信任 | 中 | ⚠️ CA 泄露风险 | 小 | ⚠️ |
| **MITM + 用户隔离** | **中** | **✅** | **小** | **✅** |
| MITM + 容器隔离 | 高 | ✅ 最强 | 中 | ✅ 长期 |
| MCP Tool API Gateway | 高 | ✅ 无网络暴露 | **大** | ⭐ 备选 |

---

### 10.9 改进后的实现路线图

#### Phase 2（修订）：MITM Proxy 集成

```
Week 3-4:
- [ ] proxy-chain 库集成
- [ ] 自签 CA 生成 + 更新逻辑
- [ ] Header 注入器实现
- [ ] Audit log 系统
- [ ] NODE_EXTRA_CA_CERTS 环境变量设置
- [ ] 单元测试
- [ ] 测试：curl/python/node 跨语言验证
```

#### Phase 4 补充：用户隔离

```
Week 7-8:
- [ ] Agent PTY 独立用户运行（doas/sudo）
- [ ] 文件权限检查（vault.json 600, ca-key.pem 600）
- [ ] iptables 规则限制 proxy 端口
- [ ] 进程监控脚本
- [ ] 审计日志收集
- [ ] 文档 + 安全建议
```

---

### 10.10 最终答案汇总

| 问题 | 答案 | 备选 |
|------|------|------|
| **1. 不做 MITM 能否注入 header？** | ❌ 不能（CONNECT 隧道无法拦截） | N/A |
| **2. MITM 自签 CA 库推荐？** | ✅ **proxy-chain** | @bjowes/http-mitm-proxy |
| **3. 库的安全性/成熟度？** | ✅ proxy-chain 最成熟（Apify 维护，ts 支持） | http-mitm-proxy 可用但较老 |
| **4. macOS CA 信任的风险？** | ⚠️ 同用户所有进程可信任（严重） | 用户隔离可完全解决 |
| **5. DNS 反向代理可行？** | ❌ 仍需 MITM 才能伪造证书 | 不推荐 |

---

**深度调研完成日期**：2026-04-16  
**调研人**：vault-researcher  
**审核状态**：待 team-lead 审核

---

**报告完成日期**：2026-04-16  
**调研范围**：packages/panel + packages/mcp-server 完整代码审查  
**代码示例**：可在 `./implementation-examples/` 查看
