import type { Socket } from 'node:net';

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

export type Connection = Socket;

export type SystemHandler = (msg: Message) => void;
