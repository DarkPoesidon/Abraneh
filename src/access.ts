/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env } from './types.js';

export const SESSION_VERSION_SQL = `NOT EXISTS (SELECT 1 FROM service_user_state disabled WHERE disabled.user_id=s.user_id AND disabled.disabled_at IS NOT NULL) AND COALESCE((SELECT password_version FROM session_security ss WHERE ss.session_id = s.id),1) = COALESCE((SELECT password_version FROM account_security ac WHERE ac.user_id = s.user_id),1)`;
export async function chatAccess(env: Env, chatId: string, userId: string) {
  return env.DB.prepare(`SELECT c.type,c.title,COALESCE(gr.role,'member') AS role,bc.visibility,bc.handle,bc.description,bc.chat_id IS NOT NULL AS isChannel FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? LEFT JOIN group_roles gr ON gr.chat_id = c.id AND gr.user_id = cm.user_id LEFT JOIN broadcast_channels bc ON bc.chat_id = c.id WHERE c.id = ? AND NOT EXISTS(SELECT 1 FROM chat_moderation cmod WHERE cmod.chat_id = c.id)`).bind(userId,chatId).first<{ type: string; title: string; role: string; isChannel: number; visibility: string | null; handle: string | null; description: string | null }>();
}
// A small PNG or WebP as a data URL, so no other content can be stored as an image.
export function validAvatar(avatar: unknown): avatar is string {
  if (typeof avatar !== 'string' || avatar.length > 48_000) return false;
  if (!avatar) return true;
  if (!/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar)) return false;
  try { const bytes = atob(avatar.split(',')[1]); return bytes.startsWith('\x89PNG\r\n\x1a\n') || (bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'); }
  catch { return false; }
}
export const MEMBER_LIMIT_SQL = `(CASE WHEN EXISTS(SELECT 1 FROM broadcast_channels WHERE chat_id = ?) THEN 10000 ELSE 100 END)`;
// The room's copy goes last, so a failed database delete can't leave a chat with no messages.
export async function deleteChat(env: Env, chatId: string) {
  await env.DB.prepare('DELETE FROM chats WHERE id = ?').bind(chatId).run();
  await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId)).fetch('https://internal/wipe-room', { method: 'POST' });
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
