import { buildPushPayload } from '@block65/webcrypto-web-push';
import { Env, Message } from './types.js';
import { SESSION_VERSION_SQL, tokenHash } from './access.js';
import { InputError } from './http.js';

export function validPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint), host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (
      host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') ||
      host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com'));
  } catch { return false; }
}
export function validatePush(input: any) {
  if (!input || !validPushEndpoint(input.endpoint) || !input.keys || !/^[A-Za-z0-9_-]{87}$/.test(input.keys.p256dh || '') || !/^[A-Za-z0-9_-]{22}$/.test(input.keys.auth || '')) throw new InputError('اشتراک اعلان معتبر نیست یا سرویس این مرورگر هنوز پشتیبانی نمی‌شود.');
  const decode=(key:string)=>atob(key.replace(/-/g,'+').replace(/_/g,'/'));
  if(decode(input.keys.p256dh).length!==65||decode(input.keys.p256dh).charCodeAt(0)!==4||decode(input.keys.auth).length!==16) throw new InputError('کلید اشتراک اعلان معتبر نیست.');
}
// Small pages keep a large group's fan-out below the per-invocation fetch budget.
// The room persists the returned cursor and resumes via its alarm.
export async function sendPush(env: Env, message: Message, fetcher: typeof fetch = fetch, after = ''): Promise<string | null> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const { results } = await env.DB.prepare(`SELECT ps.*,COALESCE(p.notification_preview,0) AS preview,c.title,c.type
    FROM push_subscriptions ps JOIN user_sessions s ON s.id = ps.session_id AND s.user_id = ps.user_id
    JOIN chat_members cm ON cm.user_id = ps.user_id AND cm.chat_id = ? JOIN chats c ON c.id = cm.chat_id
    JOIN user_profiles p ON p.user_id = ps.user_id AND p.notifications = 1
    LEFT JOIN chat_preferences cp ON cp.chat_id = cm.chat_id AND cp.user_id = ps.user_id
    WHERE ps.user_id != ? AND s.revoked_at IS NULL AND s.expires_at > ? AND ${SESSION_VERSION_SQL}
    AND COALESCE(cp.muted,0) = 0 AND (c.type != 'dm' OR NOT EXISTS (SELECT 1 FROM blocked_users b WHERE
    (b.blocker_id = ps.user_id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = ps.user_id)))
    AND ps.id > ? ORDER BY ps.id LIMIT 24`)
    .bind(message.chatId,message.senderId,Date.now(),message.senderId,message.senderId,after).all<any>();
  for (let offset = 0; offset < results.length; offset += 8) {
    await Promise.allSettled(results.slice(offset,offset+8).map(async row => {
      if (!validPushEndpoint(row.endpoint)) return;
      const data = {
        title: row.preview ? (row.type === 'group' ? row.title : message.senderName).slice(0,100) : 'پیام تازه در ابرانه',
        body: row.preview ? message.text.slice(0,160) : 'برای دیدن پیام، ابرانه را باز کنید.',
        chatId: message.chatId, messageId: message.id,
      };
      const payload = await buildPushPayload({ data, options: { ttl: 3600, topic: (await tokenHash(message.chatId)).slice(0,32) } },
        { endpoint: row.endpoint, expirationTime: null, keys: { p256dh: row.p256dh, auth: row.auth } },
        { subject: 'https://github.com/DarkPoesidon/WIHM-Cloudflare', publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! });
      const response = await fetcher(row.endpoint,{ ...payload, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if ([404,410].includes(response.status)) await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run();
      await response.body?.cancel();
    }));
  }
  return results.length===24?String(results.at(-1).id):null;
}
