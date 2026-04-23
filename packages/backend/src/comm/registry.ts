import type { Connection } from './types.js';

export class CommRegistry {
  private connections = new Map<string, Connection>();

  register(address: string, connection: Connection): void {
    const prev = this.connections.get(address);
    if (prev && prev !== connection) {
      try {
        prev.destroy();
      } catch {
        // ignore
      }
    }
    this.connections.set(address, connection);
  }

  unregister(address: string): void {
    this.connections.delete(address);
  }

  unregisterBySocket(connection: Connection): string | null {
    for (const [addr, conn] of this.connections) {
      if (conn === connection) {
        this.connections.delete(addr);
        return addr;
      }
    }
    return null;
  }

  getConnection(address: string): Connection | null {
    return this.connections.get(address) ?? null;
  }

  has(address: string): boolean {
    return this.connections.has(address);
  }

  listOnline(): string[] {
    return Array.from(this.connections.keys());
  }

  clear(): void {
    this.connections.clear();
  }

  get size(): number {
    return this.connections.size;
  }
}
