import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { CommRegistry } from './registry.js';
import { CommRouter } from './router.js';
import { deserialize, serialize } from './protocol.js';
import type { AnyMessage, SystemHandler } from './types.js';

interface ConnectionState {
  address: string | null;
  buffer: string;
}

export class CommServer {
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  readonly registry: CommRegistry;
  readonly router: CommRouter;
  private states = new WeakMap<net.Socket, ConnectionState>();

  constructor() {
    this.registry = new CommRegistry();
    this.router = new CommRouter({ registry: this.registry });
  }

  setSystemHandler(handler: SystemHandler | null): void {
    this.router.setSystemHandler(handler);
  }

  start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.onConnection(sock));
      server.on('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const s = this.server;
      this.server = null;
      if (!s) {
        this.cleanupSocketFile();
        resolve();
        return;
      }
      for (const addr of this.registry.listOnline()) {
        const c = this.registry.getConnection(addr);
        if (c) c.destroy();
      }
      this.registry.clear();
      s.close(() => {
        this.cleanupSocketFile();
        resolve();
      });
    });
  }

  private cleanupSocketFile(): void {
    if (this.socketPath && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }

  private onConnection(sock: net.Socket): void {
    this.states.set(sock, { address: null, buffer: '' });
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => this.onData(sock, chunk));
    sock.on('close', () => this.onClose(sock));
    sock.on('error', () => {
      // swallow; 'close' will follow
    });
  }

  private onData(sock: net.Socket, chunk: string): void {
    const st = this.states.get(sock);
    if (!st) return;
    st.buffer += chunk;
    let idx: number;
    while ((idx = st.buffer.indexOf('\n')) >= 0) {
      const line = st.buffer.slice(0, idx).trim();
      st.buffer = st.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(sock, st, line);
    }
  }

  private handleLine(
    sock: net.Socket,
    st: ConnectionState,
    line: string,
  ): void {
    let msg: AnyMessage;
    try {
      msg = deserialize(line);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[comm] bad frame: ${(e as Error).message}`);
      return;
    }
    if (msg.type === 'register') {
      if (st.address) {
        this.registry.unregister(st.address);
      }
      st.address = msg.address;
      this.registry.register(msg.address, sock);
      this.write(sock, { type: 'ack', ref: msg.address });
      this.router.replay(msg.address);
      return;
    }
    if (msg.type === 'ping') {
      this.write(sock, { type: 'pong', ts: new Date().toISOString() });
      return;
    }
    if (msg.type === 'message') {
      this.router.dispatch(msg);
      this.write(sock, { type: 'ack', ref: msg.id });
      return;
    }
    // pong / ack from client: no-op
  }

  private write(sock: net.Socket, msg: AnyMessage): void {
    if (sock.destroyed) return;
    sock.write(serialize(msg) + '\n');
  }

  private onClose(sock: net.Socket): void {
    const st = this.states.get(sock);
    if (st?.address) {
      const current = this.registry.getConnection(st.address);
      if (current === sock) {
        this.registry.unregister(st.address);
      }
    }
    this.states.delete(sock);
  }
}
