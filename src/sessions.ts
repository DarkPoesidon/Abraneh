import { Env, JwtPayload, User } from './types.js';
import { signJwt, verifyJwt } from './auth.js';
import { InputError } from './http.js';
import { SESSION_VERSION_SQL } from './access.js';

export async function issueSession(request: Request, env: Env, user: User, passwordVersion = 1): Promise<string> {
  const sid = crypto.randomUUID();
  const now = Date.now();
  const created=await env.DB.batch([
    env.DB.prepare('INSERT INTO user_sessions (id,user_id,label,created_at,expires_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM service_user_state WHERE user_id=? AND disabled_at IS NOT NULL)')
      .bind(sid, user.id, (request.headers.get('User-Agent') || 'مرورگر').slice(0, 200), now, now + 7 * 86400_000,user.id),
    env.DB.prepare('INSERT INTO session_security SELECT ?,? WHERE EXISTS(SELECT 1 FROM user_sessions WHERE id=?)').bind(sid,passwordVersion,sid),
  ]);
  if(!created[0].meta.changes)throw new InputError('این حساب توسط مدیر سرویس غیرفعال شده است.',403);
  return signJwt({ userId: user.id, username: user.username, displayName: user.displayName, sid }, env.JWT_SECRET);
}

export async function requestIdentity(request: Request, env: Env): Promise<(JwtPayload & { sid: string }) | null> {
  const header = request.headers.get('Authorization');
  // Browsers can't set headers on a WebSocket, so the token travels as a subprotocol to stay out of URLs and logs.
  const socketToken = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim()).find(value => value.startsWith('wihm.token.'))?.slice(11);
  // shortcut: the query form remains for clients still running a cached older shell, remove it a few releases on.
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : socketToken || new URL(request.url).searchParams.get('token') || '';
  const claims = token && await verifyJwt(token, env.JWT_SECRET);
  if (!claims) return null;
  let sid = claims.sid;
  if (!sid) {
    // Upgrade pre-1.1 tokens without asking every existing user to log in again.
    // A revoked legacy ID remains a tombstone until the original JWT expires.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    sid = 'legacy-' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(`INSERT OR IGNORE INTO user_sessions (id,user_id,label,created_at,expires_at)
      SELECT ?,id,?,?,? FROM users WHERE id = ? AND NOT EXISTS (SELECT 1 FROM session_policy WHERE user_id = ? AND legacy_disabled = 1)`)
      .bind(sid, 'نشست نسخهٔ قبلی', Date.now(), claims.exp * 1000, claims.userId, claims.userId).run();
  }
  const row = await env.DB.prepare(`SELECT s.id,u.display_name AS displayName,u.username FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND ${SESSION_VERSION_SQL}`)
    .bind(sid, claims.userId, Date.now()).first<{ displayName: string; username: string }>();
  return row ? { ...claims, displayName: row.displayName, username: row.username, sid } : null;
}

export async function revokeSessions(env: Env, userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  // No tombstone deletion: otherwise an old signed token could be re-imported.
  for (const id of ids) await env.DB.prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND id = ?').bind(Date.now(), userId, id).run();
  const { results } = await env.DB.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').bind(userId).all<{ chat_id: string }>();
  // Every broadcast also filters revoked sessions. Closing is a courtesy, not the access boundary.
  for (let i = 0; i < results.length; i += 20) {
    const outcomes = await Promise.allSettled(results.slice(i, i + 20).map(row => env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(row.chat_id)).fetch('https://internal/revoke-sessions', {
      method: 'POST', body: JSON.stringify({ userId, ids }),
    })));
    if (outcomes.some(result => result.status === 'rejected' || !result.value.ok)) console.warn('Some session-close notifications were deferred; revoked sessions remain blocked.');
  }
}
