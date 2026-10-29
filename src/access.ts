import { Env } from './types.js';

export const SESSION_VERSION_SQL = `COALESCE((SELECT password_version FROM session_security ss WHERE ss.session_id = s.id),1) = COALESCE((SELECT password_version FROM account_security ac WHERE ac.user_id = s.user_id),1)`;
export async function chatAccess(env: Env, chatId: string, userId: string) {
  return env.DB.prepare(`SELECT c.type,c.title,COALESCE(gr.role,'member') AS role FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? LEFT JOIN group_roles gr ON gr.chat_id = c.id AND gr.user_id = cm.user_id WHERE c.id = ?`).bind(userId,chatId).first<{ type: string; title: string; role: string }>();
}
export async function isBlocked(env: Env, chatId: string, userId: string): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT 1 FROM chats c JOIN chat_members other ON other.chat_id = c.id AND other.user_id != ? WHERE c.id = ? AND c.type = 'dm' AND EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = ? AND b.blocked_id = other.user_id) OR (b.blocker_id = other.user_id AND b.blocked_id = ?))`).bind(userId,chatId,userId,userId).first();
}
export async function refreshRoom(env: Env, chatId: string) {
  try { await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId)).fetch('https://internal/refresh-access', { method: 'POST' }); } catch { /* Every incoming frame and broadcast independently rechecks access. */ }
}
export async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export function inviteToken(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''); }
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const manager = (role: string) => role === 'owner' || role === 'admin';
export const normalizePersian = (text: string) => text.normalize('NFKC').replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\u064B-\u065F\u0670\u200c\u200d]/g,'').toLowerCase();
