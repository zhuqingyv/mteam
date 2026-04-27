# read_message MCP tool

Agent-facing MCP tool: fetch the full `MessageEnvelope` for a given message ID.

## 接口

```ts
export const readMessageSchema = {
  name: 'read_message',
  description: '...',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: { type: 'string' },
      markRead: { type: 'boolean', default: true },
    },
    required: ['messageId'],
    additionalProperties: false,
  },
};

export async function runReadMessage(
  env: MteamEnv,
  args: { messageId?: unknown; markRead?: unknown },
): Promise<{ envelope: MessageEnvelope } | { error: string }>;
```

入参：
- `messageId` (必填)：envelope ID，例如 `msg_xxx`。
- `markRead` (默认 `true`)：为 `false` 时不触发服务端 read 标记。

返回成功：`{ envelope: MessageEnvelope }`；失败：`{ error: string }`（**不抛异常**）。

## HTTP 调用

`GET ${env.hubUrl}/api/messages/:id?markRead=<bool>`

后端契约见 W2-I（`http/routes/messages.routes.ts`）。

## 错误码映射

| HTTP | 返回 | 备注 |
|------|------|------|
| 200  | `{ envelope }` | body 必须形如 `{envelope: MessageEnvelope}`；否则按 malformed 报错 |
| 403  | `{ error: 'forbidden: <id>' }` | 跨收件人或无权限 |
| 404  | `{ error: 'message not found: <id>' }` | 不存在 |
| 其它 | `{ error: 'read_message failed (HTTP <status>)' }` 或上游 error 文本 | 网络错 / 500 均落此分支，**不抛** |

入参校验：`messageId` 缺失 → `{ error: 'messageId is required' }`，不发请求。

## 设计原则

- 只走 HTTP，不直连 DB 或 message-store（与 `check_inbox.ts` 同风格，保持 tool 层瘦）。
- `import type { MessageEnvelope }` 仅在类型层依赖 W1-A，运行时零耦合。
- 单文件 ≤ 60 行，单测 mock `fetch` 覆盖 200 / 404 / 403 / 500 + 入参校验 + `markRead` 默认与透传。
