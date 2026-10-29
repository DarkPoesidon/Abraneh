import { Env } from './types.js';
import { validId } from './access.js';
import { InputError } from './http.js';

export interface CallIdentity { chatId: string; userId: string; sessionId: string }
export interface CallEvent {
  event: 'call_signal'; chatId: string; callId: string; kind: string; from: string;
  toUserId: string; toSessionId?: string; video?: boolean; expiresAt?: number; payload?: unknown;
}
type Delivery = (event: CallEvent) => Promise<void>;
interface CallState {
  id: string; caller: string; callerSession: string; callee: string; calleeSession?: string;
  stage: string; video: boolean; expiresAt: number; callerIce: number; calleeIce: number;
}
const key = 'call-v1';
const readCall = (sql: SqlStorage): CallState | null => {
  const row = sql.exec('SELECT value FROM room_meta WHERE key=?', key).toArray()[0];
  return row ? JSON.parse(String(row.value)) : null;
};
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
    if (call) throw new InputError('در این گفتگو تماسی در جریان است.', 409);
    if (typeof data.video !== 'boolean') throw new InputError('نوع تماس معتبر نیست.');
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
      if (data.kind === 'offer' ? !caller || call.stage !== 'accepted' : caller || call.stage !== 'offered') throw new InputError('ترتیب برقراری تماس معتبر نیست.', 409);
      if (typeof data.payload?.sdp !== 'string' || data.payload.sdp.length > 32_000 || !data.payload.sdp.startsWith('v=0') || data.payload.type !== data.kind) throw new InputError('تنظیمات تماس معتبر نیست.');
      payload = { type: data.kind, sdp: data.payload.sdp }; call.stage = data.kind === 'offer' ? 'offered' : 'active';
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
  sql.exec('DELETE FROM room_meta WHERE key=?', key);
  await deliver({ event: 'call_signal', chatId: sender.chatId, callId: call.id, kind: 'end', from: sender.userId, ...recipient(call, sender) });
}
