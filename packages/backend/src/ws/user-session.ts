// Phase WS · W2-3：把 WS 连接当作 `user:<userId>` 注册到 commRegistry。
// Why 存在：agent 侧 send_msg(to='user:u1') 走 commRouter.dispatch → registry.getConnection('user:u1')；
//   没有 shim，user 分支就永远走 offline。shim 让 WS 和 TCP 走同一套路径，router 零修改。
//
// 边界：越权校验（userId 对不对）由上游 ws-upgrade 提取并信任；本模块只管注册/注销。
// 同 userId 多 tab 时后注册覆盖 — 复用 CommRegistry.register 已有的"前者 destroy"语义，
//   旧 shim 会 destroy → _dead=true → 下一次 dispatch 走 offline → 上线时 gap-replay（R4-5）。

import type { CommRegistry } from '../comm/registry.js';
import { SocketShim, type WsLike } from '../comm/socket-shims.js';

export interface UserSessionDeps {
  commRegistry: CommRegistry;
}

interface Entry {
  userId: string;
  address: string;
  shim: SocketShim;
}

export class UserSessionTracker {
  private readonly registry: CommRegistry;
  /** connectionId → entry；一个 WS 连接对应一条记录。 */
  private readonly byConn = new Map<string, Entry>();

  constructor(deps: UserSessionDeps) {
    this.registry = deps.commRegistry;
  }

  /**
   * WS 连接建立完成后调用。必须保证 userId 已经过越权校验（本模块信任调用方）。
   * 幂等：同 connectionId 重复调用会先 unregister 再重注册，避免泄漏 shim。
   */
  register(connectionId: string, userId: string, ws: WsLike): void {
    if (this.byConn.has(connectionId)) {
      this.unregister(connectionId);
    }
    const address = `user:${userId}`;
    const shim = new SocketShim(ws);
    // CommRegistry.register 内部会 destroy 同 address 的旧连接（多 tab 覆盖语义）。
    this.registry.register(address, shim);
    this.byConn.set(connectionId, { userId, address, shim });
  }

  /**
   * WS 断开时调用。只在 registry 当前还挂着"本连接的 shim"时才注销，
   * 避免多 tab 场景下误删新连接：A 注册 → B 注册（A 被 registry.destroy）→ A close →
   *   这里看到 registry 上是 B 的 shim，不碰。
   */
  unregister(connectionId: string): void {
    const entry = this.byConn.get(connectionId);
    if (!entry) return;
    this.byConn.delete(connectionId);
    const current = this.registry.getConnection(entry.address);
    if (current === entry.shim) {
      this.registry.unregister(entry.address);
    }
    // 本连接的 shim 无论是否还在 registry，都主动 destroy 一次（幂等）。
    entry.shim.destroy();
  }

  /** 调试用：列出当前所有 WS 连接的 (connectionId, userId)。 */
  listActive(): Array<{ connectionId: string; userId: string }> {
    return Array.from(this.byConn.entries(), ([connectionId, e]) => ({
      connectionId,
      userId: e.userId,
    }));
  }
}
