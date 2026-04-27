// HTTP messages 路由与 comm 运行时的注入点。
// startServer 在 CommServer 就绪后调 setMessagesContext({ router }) 打进来；
// 路由 handler 通过 getMessagesContext() 取 store（lazy 建）+ router（可选）。
// router 不在的场合（createServer 单测直接起 http.Server，不启 comm）：
//   POST /api/messages/send 降级 503 —— 前端需要 comm 跑起来才有意义。
import type { CommRouter } from '../comm/router.js';
import { createMessageStore, type MessageStore } from '../comm/message-store.js';

interface Ctx {
  router: CommRouter | null;
  storeOverride: MessageStore | null;
}

const state: Ctx = { router: null, storeOverride: null };
let cachedStore: MessageStore | null = null;

export function setMessagesContext(ctx: { router?: CommRouter | null; store?: MessageStore | null }): void {
  if (ctx.router !== undefined) state.router = ctx.router;
  if (ctx.store !== undefined) {
    state.storeOverride = ctx.store;
    cachedStore = null;
  }
}

export function resetMessagesContext(): void {
  state.router = null;
  state.storeOverride = null;
  cachedStore = null;
}

export function getMessagesContext(): { router: CommRouter | null; store: MessageStore } {
  if (state.storeOverride) return { router: state.router, store: state.storeOverride };
  if (!cachedStore) cachedStore = createMessageStore();
  return { router: state.router, store: cachedStore };
}
