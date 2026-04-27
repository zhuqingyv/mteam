export type Address = `${string}:${string}`;

export interface ParsedAddress {
  scope: string;
  id: string;
}

export interface MessagePayload {
  [key: string]: unknown;
}

export interface Message {
  type: 'message';
  id: string;
  from: Address;
  to: Address;
  payload: MessagePayload;
  ts: string;
}

export interface RegisterMessage {
  type: 'register';
  address: Address;
}

export interface PingMessage {
  type: 'ping';
  ts: string;
}

export interface PongMessage {
  type: 'pong';
  ts: string;
}

export interface AckMessage {
  type: 'ack';
  ref: string;
}

export type AnyMessage =
  | Message
  | RegisterMessage
  | PingMessage
  | PongMessage
  | AckMessage;

/**
 * CommRouter/Registry 对连接的最小契约。
 * net.Socket 结构兼容；WS 侧可用 SocketShim 伪装成 Connection 接入。
 */
export interface Connection {
  write(data: string | Buffer): boolean;
  destroyed: boolean;
  destroy(): void;
}

export type SystemHandler = (msg: Message) => void;
