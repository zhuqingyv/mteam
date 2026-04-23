import type { CommRegistry } from './registry.js';
import type { Message, SystemHandler } from './types.js';
import { parseAddress, serialize } from './protocol.js';
import * as offline from './offline.js';

export interface RouterDeps {
  registry: CommRegistry;
  offlineStore?: typeof offline;
}

export type DispatchOutcome =
  | { route: 'system' }
  | { route: 'local-online'; address: string }
  | { route: 'local-offline'; address: string; stored: boolean }
  | { route: 'remote-unsupported'; scope: string }
  | { route: 'dropped'; reason: string };

export class CommRouter {
  private readonly registry: CommRegistry;
  private readonly offlineStore: typeof offline;
  private systemHandler: SystemHandler | null = null;

  constructor(deps: RouterDeps) {
    this.registry = deps.registry;
    this.offlineStore = deps.offlineStore ?? offline;
  }

  setSystemHandler(handler: SystemHandler | null): void {
    this.systemHandler = handler;
  }

  dispatch(msg: Message): DispatchOutcome {
    let parsed;
    try {
      parsed = parseAddress(msg.to);
    } catch (e) {
      return { route: 'dropped', reason: (e as Error).message };
    }
    const { scope, id } = parsed;

    if (scope !== 'local') {
      // eslint-disable-next-line no-console
      console.warn(
        `[comm] remote not implemented: scope=${scope} to=${msg.to}`,
      );
      return { route: 'remote-unsupported', scope };
    }

    if (id === 'system') {
      if (this.systemHandler) {
        try {
          this.systemHandler(msg);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[comm] system handler error: ${(e as Error).message}`);
        }
      }
      return { route: 'system' };
    }

    const conn = this.registry.getConnection(msg.to);
    if (conn && !conn.destroyed) {
      conn.write(serialize(msg) + '\n');
      return { route: 'local-online', address: msg.to };
    }

    const storedId = this.offlineStore.store(msg);
    return {
      route: 'local-offline',
      address: msg.to,
      stored: storedId !== null,
    };
  }

  replay(address: string): number {
    const conn = this.registry.getConnection(address);
    if (!conn || conn.destroyed) return 0;
    const pending = this.offlineStore.replayFor(address);
    let delivered = 0;
    for (const msg of pending) {
      try {
        conn.write(serialize(msg) + '\n');
        this.offlineStore.markDelivered(msg.id);
        delivered++;
      } catch {
        break;
      }
    }
    return delivered;
  }
}
