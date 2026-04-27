// Phase WS · W2-3 附产物：WS → Connection 的伪装层。
// Why 放 comm/ 目录：shim 是 Connection 接口的实现细节，业务上仍属 comm 层。
// ws/user-session.ts 构造 shim 并注册到 commRegistry，router 不关心连接底层是 TCP 还是 WS。

import type { Connection } from './types.js';

/**
 * 最小 ws 形状：匹配 ws npm 包的 WebSocket 实例，也兼容测试的 EventEmitter 假 ws。
 * - readyState === 1 表示 OPEN（ws.OPEN / WebSocket.OPEN 的值）
 * - addEventListener 对应 DOM 风格；ws npm 包支持它。
 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

const WS_OPEN = 1;

/**
 * 把 WS 连接伪装成 Connection，让 commRegistry/commRouter 照 TCP 路径写入。
 *
 * 生命周期：
 *   - 构造时挂 ws 的 close / error → 置位 _dead。router 在 `conn && !conn.destroyed`
 *     判断失败后走 offline 分支（envelope 已落库，下次上线 replay）。
 *   - destroy() 是 router 主动断开时调用；置位 _dead 再 ws.close()，幂等。
 *   - shim 自身不碰 registry — 注销由 ws-upgrade 的 close handler 统一做，
 *     避免"shim 写失败 + ws close 两路竞态注销"。
 *
 * 错误传播：ws.send 抛 → 吞掉 + _dead=true（等同已断）+ 返回 false。
 * router 回 offline 分支；对业务而言与"连接没了"等价。
 */
export class SocketShim implements Connection {
  private _dead = false;

  constructor(private readonly ws: WsLike) {
    const markDead = (): void => {
      this._dead = true;
    };
    ws.addEventListener('close', markDead);
    ws.addEventListener('error', markDead);
  }

  get destroyed(): boolean {
    return this._dead || this.ws.readyState !== WS_OPEN;
  }

  write(data: string | Buffer): boolean {
    if (this.destroyed) return false;
    const payload = typeof data === 'string' ? data : data.toString('utf8');
    try {
      this.ws.send(payload);
      return true;
    } catch {
      this._dead = true;
      return false;
    }
  }

  destroy(): void {
    if (this._dead) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      return;
    }
    this._dead = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
