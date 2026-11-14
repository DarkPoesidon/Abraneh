/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
export interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  JWT_SECRET?: string;
  ADMIN_SETUP_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  UPDATER?: Fetcher;
  UPDATER_AUTH?: string;
  TELEGRAM_KEY?: string;
  RESTORE_TOKEN?: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  display_name: string;
  created_at: number;
}

export interface Chat {
  id: string;
  type: 'dm' | 'group';
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessage?: {
    text: string;
    senderName: string;
    createdAt: number;
  } | null;
  unreadCount?: number;
}

export interface Message {
  forwardedFrom?: string;
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  clientMsgId?: string;
  replyToId?: string | null;
  replyTo?: { id: string; text: string; senderName: string; deleted?: boolean } | null;
  editedAt?: number;
  deletedAt?: number;
  revision?: number;
  reactions?: { emoji: string; users: string[] }[];
  media?: { kind: string; mime: string; size: number; durationMs: number } | null;
}

export interface JwtPayload {
  userId: string;
  username: string;
  displayName: string;
  exp: number;
  sid?: string;
}

// WebSocket Message Types
export type ClientWsAction =
  | { action:'call_signal';chatId:string;callId:string;kind:string;video?:boolean;payload?:unknown }
  | { action: 'auth'; token: string }
  | { action: 'send_message'; chatId: string; text: string; clientMsgId?: string; replyToId?: string }
  | { action: 'typing'; chatId: string; isTyping: boolean }
  | { action: 'ping' };

export type ServerWsEvent =
  | import('./calls.js').CallEvent
  | {event:'call_error';callId:string;message:string}
  | { event: 'auth_ok'; user: User }
  | { event: 'session_revoked' }
  | { event: 'new_message'; message: Message }
  | { event: 'message_changed'; message: Message }
  | { event: 'chat_access_revoked'; chatId: string }
  | { event: 'typing'; chatId: string; userId: string; username: string; isTyping: boolean }
  | { event: 'presence'; userId: string; status: 'online' | 'offline' }
  | { event: 'pong'; timestamp: number }
  | { event: 'receipt'; chatId: string; userId: string; deliveredAt: number; deliveredId: string; readAt: number; readId: string }
  | { event: 'error'; message: string; clientMsgId?: string; retryable?: boolean };
