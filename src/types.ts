export interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  JWT_SECRET?: string;
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
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  clientMsgId?: string;
}

export interface JwtPayload {
  userId: string;
  username: string;
  displayName: string;
  exp: number;
}

// WebSocket Message Types
export type ClientWsAction =
  | { action: 'auth'; token: string }
  | { action: 'send_message'; chatId: string; text: string; clientMsgId?: string }
  | { action: 'typing'; chatId: string; isTyping: boolean }
  | { action: 'ping' };

export type ServerWsEvent =
  | { event: 'auth_ok'; user: User }
  | { event: 'new_message'; message: Message }
  | { event: 'typing'; chatId: string; userId: string; username: string; isTyping: boolean }
  | { event: 'presence'; userId: string; status: 'online' | 'offline' }
  | { event: 'pong'; timestamp: number }
  | { event: 'error'; message: string };
