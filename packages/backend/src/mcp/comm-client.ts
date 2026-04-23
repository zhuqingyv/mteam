import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AnyMessage, Message } from '../comm/types.js';

const ACK_TIMEOUT_MS = 5000;

export interface SendOpts {
  to: string;
  payload: Record<string, unknown>;
}

export class CommClient {
  private sock: net.Socket | null = null;
  private registered = false;
  private buffer = '';
  private pendingAcks = new Map<string, (ok: boolean, err?: string) => void>();
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly selfAddress: string,
  ) {}

  private connect(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const s = net.createConnection(this.socketPath);
      s.setEncoding('utf8');
      s.once('error', (err) => {
        this.connectPromise = null;
        reject(err);
      });
      s.once('connect', () => {
        this.sock = s;
        s.on('data', (chunk: string) => this.onData(chunk));
        s.on('close', () => {
          this.sock = null;
          this.registered = false;
          for (const cb of this.pendingAcks.values()) cb(false, 'connection closed');
          this.pendingAcks.clear();
        });
        s.on('error', () => {
          // 'close' will follow
        });
        resolve();
      });
    });
    return this.connectPromise;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: AnyMessage;
      try {
        msg = JSON.parse(line) as AnyMessage;
      } catch {
        continue;
      }
      if (msg.type === 'ack') {
        const cb = this.pendingAcks.get(msg.ref);
        if (cb) {
          this.pendingAcks.delete(msg.ref);
          cb(true);
        }
      }
    }
  }

  private write(msg: AnyMessage): void {
    if (!this.sock || this.sock.destroyed) throw new Error('comm socket not connected');
    this.sock.write(JSON.stringify(msg) + '\n');
  }

  private async ensureRegistered(): Promise<void> {
    await this.connect();
    if (this.registered) return;
    const ref = this.selfAddress;
    const ack = this.waitAck(ref);
    this.write({ type: 'register', address: this.selfAddress as `${string}:${string}` });
    await ack;
    this.registered = true;
  }

  private waitAck(ref: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(ref);
        reject(new Error(`ack timeout for ${ref}`));
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(ref, (ok, err) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error(err ?? 'ack failed'));
      });
    });
  }

  async send(opts: SendOpts): Promise<void> {
    await this.ensureRegistered();
    const id = randomUUID();
    const msg: Message = {
      type: 'message',
      id,
      from: this.selfAddress as `${string}:${string}`,
      to: opts.to as `${string}:${string}`,
      payload: opts.payload,
      ts: new Date().toISOString(),
    };
    const ack = this.waitAck(id);
    this.write(msg);
    await ack;
  }

  close(): void {
    if (this.sock && !this.sock.destroyed) this.sock.destroy();
    this.sock = null;
    this.registered = false;
  }
}
