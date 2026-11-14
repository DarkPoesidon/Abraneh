/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env } from './types.js';
import { validId, chatAccess, isBlocked } from './access.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { serviceAdmin } from './management.js';

export interface CallIdentity { chatId: string; userId: string; sessionId: string }
export interface CallEvent {
  event: 'call_signal'; chatId: string; callId: string; kind: string; from: string;
  toUserId: string; toSessionId?: string; video?: boolean; expiresAt?: number; payload?: unknown;
}
type Delivery = (event: CallEvent) => Promise<void>;
const directIce = [{ urls: 'stun:stun.l.google.com:19302' }];
type TurnConfig = { keyId: string; token: string };
async function turnCipher(env: Env) {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', bytes.encode(env.JWT_SECRET!), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes.encode('WIHM calls v1'), info: bytes.encode('TURN configuration') }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function turnConfiguration(env: Env): Promise<TurnConfig | null> {
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key='call_turn'").first<{ value: string }>();
  if (!row) return null;
  const { iv, cipher } = JSON.parse(row.value);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv), additionalData: new TextEncoder().encode('call_turn') }, await turnCipher(env), Uint8Array.from(cipher))));
}
async function turnCredentials(config: TurnConfig) {
  let response;
  try { response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${config.keyId}/credentials/generate-ice-servers`, { method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 1200 }), signal: AbortSignal.timeout(8000), redirect: 'manual' }); }
  catch (error) { console.error('TURN credential request failed:', error instanceof Error ? error.message : 'unknown'); throw new InputError('سرویس واسط تماس پاسخ نداد؛ دوباره تلاش کنید.', 502); }
  if (!response.ok) throw new InputError('کلید یا مجوز سرویس TURN کلادفلر پذیرفته نشد.', 502);
  const body: any = await response.json();
  if (!Array.isArray(body.iceServers) || body.iceServers.length > 8) throw new InputError('پاسخ سرویس تماس معتبر نیست.', 502);
  const iceServers = body.iceServers.map((server: any) => ({ urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url: unknown) => typeof url === 'string' && /^(stun|turn|turns):[a-z0-9.-]+:\d{1,5}(\?transport=(tcp|udp))?$/.test(url) && !/:53(\?|$)/.test(url)), ...(typeof server.username === 'string' && typeof server.credential === 'string' ? { username: server.username, credential: server.credential } : {}) })).filter((server: any) => server.urls.length);
  if (!iceServers.some((server: any) => server.urls.some((url: string) => /^turns?:/.test(url)) && server.username && server.credential)) throw new InputError('مسیر واسط تماس در پاسخ وجود ندارد.', 502);
  return iceServers;
}
interface CallState {
  id: string; caller: string; callerSession: string; callee: string; calleeSession?: string;
  stage: string; video: boolean; expiresAt: number; callerIce: number; calleeIce: number;
}
const key = 'call-v1';
export const userInbox = (env: Env, userId: string) => env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('call-inbox:' + userId));
export function callInbox(env: Env, userId: string, method = 'GET', event?: CallEvent) {
  return userInbox(env, userId).fetch('https://room/call-inbox', { method, ...(event ? { body: JSON.stringify(event) } : {}) });
}

export async function handleCallRequests(request: Request, env: Env, auth: { userId: string; sid: string }) {
  const path = new URL(request.url).pathname;
  if (path === '/api/service/calls') {
    await serviceAdmin(env, auth.userId);
    if (request.method === 'GET') { const config = await turnConfiguration(env); return jsonResponse({ configured: !!config, keyId: config?.keyId || '' }); }
    if (!['POST', 'DELETE'].includes(request.method)) throw new InputError('روش درخواست معتبر نیست.', 405);
    if (!await allowRequest(env, 'turn-settings', auth.userId, 10, 3600_000)) throw new InputError('تلاش‌های تنظیم تماس زیاد است؛ یک ساعت دیگر تلاش کنید.', 429);
    if (request.method === 'DELETE') { await env.DB.prepare("DELETE FROM site_settings WHERE key='call_turn'").run(); return jsonResponse({ configured: false }); }
    const body = await inputJson(request, 2048);
    if (typeof body.keyId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.keyId) || typeof body.token !== 'string' || !/^[a-zA-Z0-9_.=-]{20,1024}$/.test(body.token)) throw new InputError('شناسهٔ TURN و توکن همان کلید را کامل وارد کنید.');
    const config = { keyId: body.keyId, token: body.token }; await turnCredentials(config);
    const iv = crypto.getRandomValues(new Uint8Array(12)), cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('call_turn') }, await turnCipher(env), new TextEncoder().encode(JSON.stringify(config)));
    await env.DB.prepare("INSERT INTO site_settings VALUES ('call_turn',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ iv: [...iv], cipher: [...new Uint8Array(cipher)] })).run();
    return jsonResponse({ configured: true });
  }
  if (path === '/api/calls/ice' && request.method === 'POST') {
    const body = await inputJson(request, 2048);
    if (!validId(body.chatId) || !validId(body.callId) || !await chatAccess(env, body.chatId, auth.userId) || await isBlocked(env, body.chatId, auth.userId)) throw new InputError('دسترسی تماس بسته است.', 403);
    const active = await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(body.chatId)).fetch('https://room/call-active', { method: 'POST', body: JSON.stringify({ ...auth, callId: body.callId }) });
    if (!active.ok) throw new InputError('تماس فعال نیست یا متعلق به این دستگاه نیست.', 403);
    const config = await turnConfiguration(env);
    if (!config) return jsonResponse({ iceServers: directIce, relay: false });
    if (!await allowRequest(env, 'turn-credentials', auth.userId, 20, 3600_000)) throw new InputError('تعداد تماس‌ها زیاد است؛ یک ساعت دیگر تلاش کنید.', 429);
    return jsonResponse({ iceServers: await turnCredentials(config), relay: true });
  }
  if (path === '/api/calls/incoming' && request.method === 'GET') {
    const response = await callInbox(env, auth.userId);
    if (!response.ok) throw new InputError('بررسی تماس بیش از حد تکرار شده است؛ کمی صبر کنید.', 429);
    const events = await response.json<CallEvent[]>(), permitted = [];
    for (const event of events) if (event.toUserId === auth.userId && event.expiresAt! > Date.now()
        && await chatAccess(env, event.chatId, auth.userId) && !await isBlocked(env, event.chatId, auth.userId)) permitted.push(event);
    return jsonResponse(permitted);
  }
  if ((path === '/api/calls/decline' || path === '/api/calls/end') && request.method === 'POST') {
    const body = await inputJson(request, 2048);
    if (!validId(body.chatId) || !validId(body.callId)) throw new InputError('شناسهٔ تماس معتبر نیست.');
    if (!await chatAccess(env, body.chatId, auth.userId) || await isBlocked(env, body.chatId, auth.userId)) throw new InputError('دسترسی تماس بسته است.', 403);
    return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(body.chatId)).fetch(path.endsWith('/end') ? 'https://room/call-end' : 'https://room/call-decline', { method: 'POST', body: JSON.stringify({ chatId: body.chatId, userId: auth.userId, sessionId: auth.sid, callId: body.callId }) });
  }
  return null;
}
const readCall = (sql: SqlStorage): CallState | null => {
  const row = sql.exec('SELECT value FROM room_meta WHERE key=?', key).toArray()[0];
  return row ? JSON.parse(String(row.value)) : null;
};
export function activeCall(sql: SqlStorage, userId: string, sessionId: string, callId: string) {
  const call = readCall(sql);
  return !!call && call.id === callId && call.expiresAt > Date.now() && (call.caller === userId && call.callerSession === sessionId || call.callee === userId && (!call.calleeSession || call.calleeSession === sessionId));
}
function recipient(call: CallState, sender: CallIdentity) {
  return sender.userId === call.caller ? { toUserId: call.callee, toSessionId: call.calleeSession }
    : { toUserId: call.caller, toSessionId: call.callerSession };
}

// Called only after ChatRoom's per-frame session, membership and block checks.
export async function handleCall(env: Env, sql: SqlStorage, sender: CallIdentity, data: any, deliver: Delivery, now = Date.now()): Promise<boolean> {
  if (data.action !== 'call_signal') return false;
  if (data.chatId !== sender.chatId || !validId(data.callId)
      || !['invite','accept','decline','end','offer','answer','ice'].includes(data.kind)) throw new InputError('درخواست تماس معتبر نیست.');
  const { results: members } = await env.DB.prepare('SELECT cm.user_id,c.type FROM chat_members cm JOIN chats c ON c.id=cm.chat_id WHERE cm.chat_id=?')
    .bind(sender.chatId).all<{ user_id: string; type: string }>();
  if (members.length !== 2 || members.some(member => member.type !== 'dm') || !members.some(member => member.user_id === sender.userId)) {
    throw new InputError('تماس فقط در گفتگوی خصوصی دونفره فعال است.', 403);
  }
  const count = (prefix: string, limit: number) => {
    const row = sql.exec(`INSERT INTO send_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count`, prefix + sender.userId, Math.floor(now / 60_000) * 60_000).toArray()[0];
    if (Number(row.count) > limit) throw new InputError('تعداد درخواست‌های تماس زیاد است؛ یک دقیقه صبر کنید.', 429);
  };
  count('call:', 180);
  let call = readCall(sql);
  if (call && call.expiresAt <= now) { sql.exec('DELETE FROM room_meta WHERE key=?', key); call = null; }
  let payload: unknown;
  if (data.kind === 'invite') {
    count('ring:', 4);
    if (typeof data.video !== 'boolean') throw new InputError('نوع تماس معتبر نیست.');
    if (call) {
      // A client only invites when it has no call, so a call still held by this same session is dead.
      const own = call.caller === sender.userId ? call.callerSession === sender.sessionId : call.callee === sender.userId && call.calleeSession === sender.sessionId;
      if (!own || call.id === data.callId) throw new InputError('در این گفتگو تماسی در جریان است.', 409);
      await deliver({ event: 'call_signal', chatId: sender.chatId, callId: call.id, kind: 'end', from: sender.userId, ...recipient(call, sender) });
    }
    call = { id: data.callId, caller: sender.userId, callerSession: sender.sessionId,
      callee: members.find(member => member.user_id !== sender.userId)!.user_id,
      stage: 'ringing', video: data.video, expiresAt: now + 45_000, callerIce: 0, calleeIce: 0 };
  } else {
    if (!call || call.id !== data.callId) throw new InputError('تماس پایان یافته یا منقضی شده است.', 409);
    const caller = sender.userId === call.caller;
    if (caller ? sender.sessionId !== call.callerSession : sender.userId !== call.callee || (call.calleeSession && sender.sessionId !== call.calleeSession)) {
      throw new InputError('این تماس به نشست دیگری تعلق دارد.', 403);
    }
    if (data.kind === 'accept' || data.kind === 'decline') {
      if (caller || call.stage !== 'ringing') throw new InputError('پاسخ تماس معتبر نیست.', 409);
      if (data.kind === 'accept') { call.calleeSession = sender.sessionId; call.stage = 'accepted'; call.expiresAt = now + 15 * 60_000; }
    } else if (data.kind === 'offer' || data.kind === 'answer') {
      // A caller re-offers on a live call to restart ICE after the network changes.
      if (data.kind === 'offer' ? !caller || call.stage === 'ringing' : caller || call.stage !== 'offered') throw new InputError('ترتیب برقراری تماس معتبر نیست.', 409);
      if (typeof data.payload?.sdp !== 'string' || data.payload.sdp.length > 32_000 || !data.payload.sdp.startsWith('v=0') || data.payload.type !== data.kind) throw new InputError('تنظیمات تماس معتبر نیست.');
      payload = { type: data.kind, sdp: data.payload.sdp }; call.stage = data.kind === 'offer' ? 'offered' : 'active';
      if (data.kind === 'offer') call.callerIce = call.calleeIce = 0;
    } else if (data.kind === 'ice') {
      if (!['offered','active'].includes(call.stage)) throw new InputError('ابتدا تماس باید پذیرفته شود.', 409);
      const ice = data.payload;
      if (!ice || typeof ice.candidate !== 'string' || ice.candidate.length > 2048
          || (ice.sdpMid != null && (typeof ice.sdpMid !== 'string' || ice.sdpMid.length > 128))
          || (ice.sdpMLineIndex != null && (!Number.isInteger(ice.sdpMLineIndex) || ice.sdpMLineIndex < 0 || ice.sdpMLineIndex > 64))
          || (ice.usernameFragment != null && (typeof ice.usernameFragment !== 'string' || ice.usernameFragment.length > 256))) throw new InputError('مسیر ارتباط تماس معتبر نیست.');
      if (++call[caller ? 'callerIce' : 'calleeIce'] > 100) throw new InputError('تعداد مسیرهای تماس بیش از حد مجاز است.', 429);
      payload = { candidate: ice.candidate, sdpMid: ice.sdpMid ?? null, sdpMLineIndex: ice.sdpMLineIndex ?? null, ...(ice.usernameFragment ? { usernameFragment: ice.usernameFragment } : {}) };
    }
  }
  if (data.kind === 'end' || data.kind === 'decline') sql.exec('DELETE FROM room_meta WHERE key=?', key);
  else sql.exec('INSERT INTO room_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(call));
  await deliver({ event: 'call_signal', chatId: sender.chatId, callId: call.id, kind: data.kind, from: sender.userId,
    ...recipient(call, sender), video: call.video, expiresAt: call.expiresAt, ...(payload ? { payload } : {}) });
  if (data.kind === 'accept') await deliver({ event: 'call_signal', chatId: sender.chatId, callId: call.id, kind: 'claimed', from: sender.userId, toUserId: sender.userId, toSessionId: undefined });
  return true;
}

export async function closeCall(sql: SqlStorage, sender: CallIdentity, deliver: Delivery) {
  const call = readCall(sql);
  if (!call || !(call.caller === sender.userId && call.callerSession === sender.sessionId)
      && !(call.callee === sender.userId && call.calleeSession === sender.sessionId)) return;
  // Accepted media flows peer to peer, so a brief socket loss must not hang up. expiresAt still bounds it.
  if (call.stage !== 'ringing') return;
  sql.exec('DELETE FROM room_meta WHERE key=?', key);
  await deliver({ event: 'call_signal', chatId: sender.chatId, callId: call.id, kind: 'end', from: sender.userId, ...recipient(call, sender) });
}
