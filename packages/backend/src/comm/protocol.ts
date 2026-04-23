import type {
  AnyMessage,
  Message,
  RegisterMessage,
  PingMessage,
  PongMessage,
  AckMessage,
  ParsedAddress,
} from './types.js';

export function parseAddress(addr: string): ParsedAddress {
  if (typeof addr !== 'string') {
    throw new Error(`invalid address: not a string`);
  }
  const colon = addr.indexOf(':');
  if (colon <= 0 || colon === addr.length - 1) {
    throw new Error(`invalid address format: ${addr}`);
  }
  const scope = addr.slice(0, colon);
  const id = addr.slice(colon + 1);
  if (!scope || !id) {
    throw new Error(`invalid address format: ${addr}`);
  }
  return { scope, id };
}

export function isLocal(addr: string): boolean {
  return parseAddress(addr).scope === 'local';
}

export function isSystem(addr: string): boolean {
  return parseAddress(addr).id === 'system';
}

export function serialize(msg: AnyMessage): string {
  return JSON.stringify(msg);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function deserialize(raw: string): AnyMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed) || typeof parsed.type !== 'string') {
    throw new Error('invalid message: missing type');
  }
  switch (parsed.type) {
    case 'register':
      if (typeof parsed.address !== 'string') {
        throw new Error('register: missing address');
      }
      parseAddress(parsed.address);
      return parsed as unknown as RegisterMessage;
    case 'message':
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.from !== 'string' ||
        typeof parsed.to !== 'string' ||
        typeof parsed.ts !== 'string' ||
        !isObject(parsed.payload)
      ) {
        throw new Error('message: malformed fields');
      }
      parseAddress(parsed.from);
      parseAddress(parsed.to);
      return parsed as unknown as Message;
    case 'ping':
      return parsed as unknown as PingMessage;
    case 'pong':
      return parsed as unknown as PongMessage;
    case 'ack':
      if (typeof parsed.ref !== 'string') {
        throw new Error('ack: missing ref');
      }
      return parsed as unknown as AckMessage;
    default:
      throw new Error(`unknown message type: ${String(parsed.type)}`);
  }
}

export function validateMessage(msg: unknown): boolean {
  try {
    if (!isObject(msg) || typeof msg.type !== 'string') return false;
    if (msg.type === 'message') {
      if (
        typeof msg.id !== 'string' ||
        typeof msg.from !== 'string' ||
        typeof msg.to !== 'string' ||
        typeof msg.ts !== 'string' ||
        !isObject(msg.payload)
      )
        return false;
      parseAddress(msg.from as string);
      parseAddress(msg.to as string);
    }
    return true;
  } catch {
    return false;
  }
}
