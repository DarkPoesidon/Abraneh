import { enforceSecondFactor } from './security.js';
import { Env, JwtPayload, Message } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { chatAccess, deleteChat, isBlocked, manager, validId, tokenHash, inviteToken, normalizePersian, refreshRoom } from './access.js';
import { allowRequest } from './limits.js';
import { hashPassword, verifyPassword, generateSalt } from './auth.js';
import { revokeSessions } from './sessions.js';
import { validatePush, sendTestPush } from './push.js';

type Identity = JwtPayload & { sid: string };
function check(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw new InputError(message,status); }
export async function registrationMode(env: Env): Promise<string> { return (await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'registration'").first<{ value: string }>())?.value || 'open'; }
export async function registrationGate(env: Env, token: unknown): Promise<string> {
  const mode = await registrationMode(env);
  if (mode === 'closed') throw new InputError('ثبت‌نام فعلاً بسته است.',403);
  if (mode !== 'invite') return '';
  check(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token),'برای ثبت‌نام به دعوت‌نامهٔ سرویس نیاز دارید.',403);
  const hash = await tokenHash(token);
  check(await env.DB.prepare('SELECT 1 FROM registration_invites WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < use_limit').bind(hash,Date.now()).first(),'دعوت ثبت‌نام منقضی، لغو یا مصرف شده است.',403);
  return hash;
}
async function requireAdmin(env: Env, userId: string) { check(await env.DB.prepare('SELECT 1 FROM service_admins WHERE slot = 1 AND user_id = ?').bind(userId).first(),'این بخش فقط برای مدیر سرویس است.',403); }
async function requireChat(env: Env, chatId: string, userId: string) { const access = await chatAccess(env,chatId,userId); check(access,'شما عضو این گفتگو نیستید.',403); return access; }
const inviteOptions = (body: any) => ({ hours: [1,24,168].includes(Number(body.hours)) ? Number(body.hours) : 168, uses: Math.max(1,Math.min(1000,Math.floor(Number(body.uses) || 100))) });

export async function enrichChats(env: Env, userId: string, chats: any[]) {
  const { results: prefs } = await env.DB.prepare('SELECT * FROM chat_preferences WHERE user_id = ?').bind(userId).all<any>();
  const { results: roles } = await env.DB.prepare('SELECT chat_id,role FROM group_roles WHERE user_id = ?').bind(userId).all<any>();
  const { results: blocks } = await env.DB.prepare('SELECT blocker_id,blocked_id FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?').bind(userId,userId).all<any>();
  const {results:avatars}=await env.DB.prepare("SELECT p.user_id,p.avatar FROM user_profiles p WHERE EXISTS(SELECT 1 FROM chats c JOIN chat_members mine ON mine.chat_id=c.id AND mine.user_id=? JOIN chat_members other ON other.chat_id=c.id AND other.user_id=p.user_id AND other.user_id!=mine.user_id WHERE c.type='dm')").bind(userId).all<any>();
  const {results:revisions}=await env.DB.prepare('SELECT message_id,revision FROM message_details WHERE message_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(chats.map(chat=>chat.lastMessage?.id).filter(Boolean))).all<any>();
  for (const chat of chats) {
    const pref = prefs.find(row=>row.chat_id===chat.id);
    chat.archived = !!pref?.archived; chat.muted = !!pref?.muted; chat.pinned = !!pref?.pinned;
    chat.role = roles.find(row=>row.chat_id===chat.id)?.role || 'member';
    chat.blocked = chat.type === 'dm' && blocks.some(row=>row.blocker_id===chat.partnerId || row.blocked_id===chat.partnerId);
    if (chat.partnerId) chat.avatar = avatars.find(row=>row.user_id===chat.partnerId)?.avatar || '';
    if(chat.lastMessage) chat.lastMessage.revision=Number(revisions.find(row=>row.message_id===chat.lastMessage.id)?.revision||0);
  }
  return chats.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt);
}

export async function enrichMessages(env: Env, chatId: string, userId: string, messages: any[]): Promise<Message[]> {
  if (!messages.length) return [];
  // D1 is a repairable index. Search, bookmarks and reconnect snapshots must
  // prefer a durable edit/delete even while indexing is temporarily unavailable.
  const idsToCheck=messages.filter(row=>row.revision===undefined).map(row=>row.id);
  if(idsToCheck.length) try {
    const response=await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId)).fetch('https://internal/message-snapshot',{method:'POST',body:JSON.stringify({ids:idsToCheck,chatId})});
    if(response.ok) {const canonical=await response.json<any[]>();messages=messages.map(row=>({...row,...canonical.find(item=>item.id===row.id)}));}
  } catch {/* Fall back to the last confirmed D1 copy when a room is unavailable. */}
  const { results: hidden } = await env.DB.prepare('SELECT message_id FROM message_hidden WHERE chat_id = ? AND user_id = ?').bind(chatId,userId).all<{ message_id: string }>();
  const excluded = new Set(hidden.map(row=>row.message_id));
  const ids = messages.map(message=>message.id), placeholders = ids.map(()=>'?').join(',');
    const { results: details } = await env.DB.prepare(`SELECT d.*,m.text FROM message_details d JOIN messages m ON m.id=d.message_id WHERE d.message_id IN (${placeholders})`).bind(...ids).all<any>();
  const { results: reactions } = await env.DB.prepare(`SELECT * FROM message_reactions WHERE message_id IN (${placeholders})`).bind(...ids).all<any>();
  const replyIds=[...new Set([...messages.map(row=>row.replyToId),...details.map(row=>row.reply_to)].filter(Boolean))];
  const replies=replyIds.length ? (await env.DB.prepare(`SELECT m.id,m.text,u.display_name AS senderName,d.deleted_at FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN message_details d ON d.message_id=m.id WHERE m.chat_id=? AND m.id IN (SELECT value FROM json_each(?))`).bind(chatId,JSON.stringify(replyIds)).all<any>()).results:[];
  const result = [];
  for (const raw of messages) {
    if (excluded.has(raw.id)) continue;
    const global = details.find(row=>row.message_id===raw.id);
    const local = raw.revision !== undefined && Number(raw.revision)>=Number(global?.revision || 0);
    const msg = { ...raw, replyToId: local ? raw.replyToId : global?.reply_to, editedAt: local ? raw.editedAt : Number(global?.edited_at || 0), deletedAt: local ? raw.deletedAt : Number(global?.deleted_at || 0), revision: Math.max(Number(raw.revision || 0),Number(global?.revision || 0)) };
    if(!local&&global) msg.text=global.text;
    if (msg.deletedAt) { msg.text = ''; msg.replyTo = null; msg.reactions = []; }
    else {
      if (!local) {
        const grouped = new Map<string,string[]>();
        for (const row of reactions.filter(row=>row.message_id===msg.id)) grouped.set(row.emoji,[...(grouped.get(row.emoji)||[]),row.user_id]);
        msg.reactions = [...grouped].map(([emoji,users])=>({emoji,users}));
      }
      if (msg.replyToId && !msg.replyTo) {
        const reply = replies.find(row=>row.id===msg.replyToId);
        msg.replyTo = reply ? { id: reply.id, text: reply.deleted_at ? '' : reply.text, senderName: reply.senderName, deleted: !!reply.deleted_at } : null;
      }
      if(msg.replyToId&&excluded.has(msg.replyToId)&&msg.replyTo) msg.replyTo={...msg.replyTo,text:'',deleted:true};
    }
    result.push(msg);
  }
  return result;
}

export async function handleFeatures(request: Request, env: Env, auth: Identity, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname, method = request.method, userId = auth.userId;
  if (path === '/api/profile' && method === 'GET') {
    const user = await env.DB.prepare('SELECT id,username,display_name AS displayName,created_at AS createdAt FROM users WHERE id = ?').bind(userId).first();
    const profile = await env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first();
    const admin = await env.DB.prepare('SELECT user_id FROM service_admins WHERE slot = 1').first<{ user_id: string }>();
    return jsonResponse({ ...user, ...profile, isServiceAdmin: admin?.user_id===userId, adminConfigured: !!admin, pushConfigured: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), vapidPublicKey: env.VAPID_PUBLIC_KEY || '' });
  }
  if (path === '/api/profile' && method === 'PATCH') {
    const body = await inputJson(request);
    check(typeof body.displayName==='string' && body.displayName.trim().length>0 && body.displayName.trim().length<=100,'نام نمایشی باید بین ۱ تا ۱۰۰ کاراکتر باشد.');
    check(typeof body.about==='string' && body.about.length<=300,'دربارهٔ من حداکثر ۳۰۰ کاراکتر است.');
    check(['dark','light','system'].includes(body.theme) && ['small','normal','large'].includes(body.fontSize),'تنظیم ظاهر معتبر نیست.');
    const avatar = body.avatar || '';
    check(typeof avatar==='string' && avatar.length<=48_000 && (!avatar || /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar)),'تصویر پروفایل معتبر نیست یا خیلی بزرگ است.');
    if (avatar) { let bytes='';try {bytes=atob(avatar.split(',')[1]);}catch {throw new InputError('تصویر پروفایل معتبر نیست.');} check(bytes.startsWith('\x89PNG\r\n\x1a\n') || (bytes.startsWith('RIFF') && bytes.slice(8,12)==='WEBP'),'فقط تصویر PNG یا WebP پذیرفته می‌شود.'); }
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(body.displayName.trim(),userId),
      env.DB.prepare(`INSERT INTO user_profiles(user_id,about,avatar,theme,font_size,notifications,notification_preview) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET about=excluded.about,avatar=excluded.avatar,theme=excluded.theme,font_size=excluded.font_size,notifications=excluded.notifications,notification_preview=excluded.notification_preview`)
        .bind(userId,body.about,avatar,body.theme,body.fontSize,body.notifications===true?1:0,body.notificationPreview===true?1:0),
    ]);
    return jsonResponse({ ok:true });
  }
  if (path === '/api/profile/username' && method === 'POST') {
    const body = await inputJson(request), username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    check(/^[a-z0-9_]{3,20}$/.test(username),'نام کاربری باید ۳ تا ۲۰ حرف انگلیسی، عدد یا _ باشد.');
    check(await allowRequest(env,'username-change',userId,5,3600_000),'تغییر نام کاربری زیاد است؛ یک ساعت دیگر تلاش کنید.',429);
    check(!await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').bind(username,userId).first(),'این نام کاربری قبلاً گرفته شده است.',409);
    try { await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username,userId).run(); }
    catch { throw new InputError('این نام کاربری قبلاً گرفته شده است.',409); }
    return jsonResponse({ username });
  }
  if (path === '/api/public-channels' && method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/,''); check(query.length <= 100,'عبارت جستجو طولانی است.');
    const { results } = await env.DB.prepare(`SELECT c.id,c.title,bc.handle,bc.description,(SELECT count(*) FROM chat_members m WHERE m.chat_id=c.id) AS members,EXISTS(SELECT 1 FROM chat_members m WHERE m.chat_id=c.id AND m.user_id=?) AS joined FROM broadcast_channels bc JOIN chats c ON c.id=bc.chat_id WHERE bc.visibility='public' AND NOT EXISTS(SELECT 1 FROM chat_moderation cmod WHERE cmod.chat_id=c.id) AND (?='' OR instr(lower(c.title),?)>0 OR instr(lower(bc.handle),?)>0) ORDER BY members DESC,c.id LIMIT 30`).bind(userId,query,query,query).all();
    return jsonResponse(results);
  }
  const publicJoin = path.match(/^\/api\/public-channels\/([a-zA-Z0-9_-]+)\/join$/);
  if (publicJoin && method === 'POST') {
    check(await allowRequest(env,'join',userId,30,3600_000),'تلاش‌های عضویت زیاد است؛ بعداً تلاش کنید.',429);
    await env.DB.prepare(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,joined_at) SELECT bc.chat_id,?,? FROM broadcast_channels bc WHERE bc.chat_id=? AND bc.visibility='public' AND NOT EXISTS(SELECT 1 FROM chat_moderation cmod WHERE cmod.chat_id=bc.chat_id) AND (SELECT count(*) FROM chat_members WHERE chat_id=bc.chat_id)<10000`).bind(userId,Date.now(),publicJoin[1]).run();
    check(await chatAccess(env,publicJoin[1],userId),'این کانال پیدا نشد یا ظرفیت آن پر است.',404);
    return jsonResponse({ chatId: publicJoin[1] });
  }
  if (path === '/api/profile/password' && method === 'POST') {
    const body = await inputJson(request);
    check(typeof body.currentPassword==='string' && typeof body.newPassword==='string' && body.newPassword.length>=8 && body.newPassword.length<=1024,'رمز تازه باید ۸ تا ۱۰۲۴ کاراکتر باشد.');
    check(await allowRequest(env,'password-change',userId,10,3600_000),'تلاش‌های تغییر رمز زیاد است؛ یک ساعت دیگر تلاش کنید.',429);
    const row = await env.DB.prepare('SELECT salt,password_hash FROM users WHERE id = ?').bind(userId).first<any>();
    check(await verifyPassword(body.currentPassword,row.salt,row.password_hash),'رمز فعلی درست نیست.',403);
    await enforceSecondFactor(env,userId,body,403);
    const salt = generateSalt(), hash = await hashPassword(body.newPassword,salt);
    const { results } = await env.DB.prepare('SELECT id FROM user_sessions WHERE user_id = ? AND id != ?').bind(userId,auth.sid).all<{ id:string }>();
    const changed = await env.DB.batch([
      env.DB.prepare('UPDATE users SET salt=?,password_hash=? WHERE id=? AND password_hash=?').bind(salt,hash,userId,row.password_hash),
      env.DB.prepare('INSERT INTO account_security SELECT ?,2 WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?) ON CONFLICT(user_id) DO UPDATE SET password_version=password_version+1').bind(userId,userId,hash),
      env.DB.prepare('INSERT INTO session_security SELECT ?,password_version FROM account_security WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?) ON CONFLICT(session_id) DO UPDATE SET password_version=excluded.password_version').bind(auth.sid,userId,userId,hash),
      env.DB.prepare('INSERT INTO session_policy VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET legacy_disabled=1').bind(userId),
    ]);
    check(changed[0].meta.changes,'رمز هم‌زمان تغییر کرده است؛ دوباره وارد شوید.',409);
    await revokeSessions(env,userId,results.map(row=>row.id));
    return jsonResponse({ ok:true });
  }
  if (path === '/api/service/claim' && method === 'POST') {
    const body = await inputJson(request);
    check(await allowRequest(env,'admin-claim',userId,10,3600_000),'تلاش‌های فعال‌سازی مدیریت زیاد است؛ بعداً تلاش کنید.',429);
    check(env.ADMIN_SETUP_TOKEN && typeof body.code==='string' && (await tokenHash(body.code))===(await tokenHash(env.ADMIN_SETUP_TOKEN)),'کد مدیریت درست نیست؛ کد ارائه‌شده توسط نصب‌کننده را وارد کنید.',403);
    await env.DB.prepare('INSERT OR IGNORE INTO service_admins VALUES (1,?)').bind(userId).run();
    await requireAdmin(env,userId); return jsonResponse({ ok:true });
  }
  if (path === '/api/service/settings') {
    await requireAdmin(env,userId);
    if (method==='GET') return jsonResponse({ registration:await registrationMode(env) });
    if (method==='PATCH') { const body=await inputJson(request); check(['open','invite','closed'].includes(body.registration),'حالت ثبت‌نام معتبر نیست.'); await env.DB.prepare("INSERT INTO site_settings VALUES ('registration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.registration).run(); return jsonResponse({ok:true}); }
  }
  if (path === '/api/service/invites') {
    await requireAdmin(env,userId);
    if (method==='GET') return jsonResponse((await env.DB.prepare('SELECT token_hash AS id,expires_at AS expiresAt,use_limit AS useLimit,uses,revoked_at AS revokedAt FROM registration_invites ORDER BY expires_at DESC LIMIT 100').all()).results);
    if (method==='POST') { const body=await inputJson(request),options=inviteOptions(body),token=inviteToken(); await env.DB.prepare('INSERT INTO registration_invites(token_hash,created_by,expires_at,use_limit) VALUES (?,?,?,?)').bind(await tokenHash(token),userId,Date.now()+options.hours*3600_000,options.uses).run(); return jsonResponse({token},201); }
    if (method==='DELETE') { const body=await inputJson(request); check(typeof body.id==='string','دعوت معتبر نیست.'); await env.DB.prepare('UPDATE registration_invites SET revoked_at=? WHERE token_hash=?').bind(Date.now(),body.id).run(); return jsonResponse({ok:true}); }
  }
  if (path === '/api/service/reports') {
    await requireAdmin(env,userId);
    if (method==='GET') return jsonResponse((await env.DB.prepare("SELECT r.*,u.username AS reporter,t.username AS target,c.title AS chatTitle,c.type AS chatType,bc.chat_id IS NOT NULL AS isChannel,st.disabled_at AS targetDisabledAt FROM abuse_reports r JOIN users u ON u.id=r.reporter_id JOIN users t ON t.id=r.target_user_id LEFT JOIN chats c ON c.id=r.chat_id LEFT JOIN broadcast_channels bc ON bc.chat_id=r.chat_id LEFT JOIN service_user_state st ON st.user_id=r.target_user_id ORDER BY r.status='open' DESC,r.created_at DESC LIMIT 100").all()).results);
    if (method==='PATCH') { const body=await inputJson(request); check(validId(body.id) && ['open','resolved'].includes(body.status),'وضعیت گزارش معتبر نیست.'); await env.DB.prepare('UPDATE abuse_reports SET status=? WHERE id=?').bind(body.status,body.id).run(); return jsonResponse({ok:true}); }
  }
  if (path === '/api/blocks') {
    if (method==='GET') return jsonResponse((await env.DB.prepare('SELECT u.id,u.username,u.display_name AS displayName FROM blocked_users b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=?').bind(userId).all()).results);
    if (method==='POST' || method==='DELETE') {
      const body=await inputJson(request); check(validId(body.userId) && body.userId!==userId,'مخاطب معتبر نیست.');
      check(await env.DB.prepare('SELECT 1 FROM users WHERE id=?').bind(body.userId).first(),'مخاطب پیدا نشد.',404);
      if (method==='POST') await env.DB.prepare('INSERT OR IGNORE INTO blocked_users VALUES (?,?,?)').bind(userId,body.userId,Date.now()).run();
      else await env.DB.prepare('DELETE FROM blocked_users WHERE blocker_id=? AND blocked_id=?').bind(userId,body.userId).run();
      const {results}=await env.DB.prepare("SELECT c.id FROM chats c JOIN chat_members a ON a.chat_id=c.id AND a.user_id=? JOIN chat_members b ON b.chat_id=c.id AND b.user_id=? WHERE c.type='dm'").bind(userId,body.userId).all<{id:string}>();
      await Promise.all(results.map(row=>refreshRoom(env,row.id))); return jsonResponse({ok:true});
    }
  }
  if (path === '/api/reports' && method==='POST') {
    const body=await inputJson(request); check(validId(body.userId) && body.userId!==userId && typeof body.reason==='string' && body.reason.trim().length>=3 && body.reason.length<=1000,'مخاطب و توضیح گزارش را کامل کنید.');
    check(await allowRequest(env,'reports',userId,10,3600_000),'تعداد گزارش‌ها زیاد است؛ بعداً تلاش کنید.',429);
    check(await env.DB.prepare('SELECT 1 FROM users WHERE id=?').bind(body.userId).first(),'مخاطب پیدا نشد.',404);
    let snapshot='';
    if (body.messageId) { check(validId(body.chatId)&&validId(body.messageId),'پیام گزارش معتبر نیست.'); await requireChat(env,body.chatId,userId); const row=await env.DB.prepare('SELECT text FROM messages WHERE chat_id=? AND id=? AND sender_id=?').bind(body.chatId,body.messageId,body.userId).first<{text:string}>(); check(row,'پیام پیدا نشد.',404); snapshot=row.text; }
    await env.DB.prepare('INSERT INTO abuse_reports(id,reporter_id,target_user_id,chat_id,message_id,reason,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),userId,body.userId,body.chatId||null,body.messageId||null,body.reason.trim(),snapshot,Date.now()).run();
    return jsonResponse({ok:true},201);
  }
  if(path==='/api/push/test'&&method==='POST'){check(await allowRequest(env,'push-test',userId,10,3600_000),'آزمایش‌های اعلان زیاد است؛ بعداً تلاش کنید.',429);return jsonResponse(await sendTestPush(env,userId,auth.sid));}
  if (path === '/api/push' && method==='POST') {
    check(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY,'اعلان سرور تنظیم نشده است؛ نصب‌کنندهٔ جدید را با همان نام اجرا کنید.',503);
    const body=await inputJson(request); validatePush(body);
    const id=await tokenHash(body.endpoint);
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND session_id=? AND id!=?').bind(userId,auth.sid,id).run();
    await env.DB.prepare(`INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,p256dh=excluded.p256dh,auth=excluded.auth,created_at=excluded.created_at`)
      .bind(id,userId,auth.sid,body.endpoint,body.keys.p256dh,body.keys.auth,Date.now()).run();
    return jsonResponse({ok:true});
  }
  if (path === '/api/push' && method==='DELETE') { await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND session_id=?').bind(userId,auth.sid).run(); return jsonResponse({ok:true}); }
  if (path === '/api/saved' && method==='GET') {
    const cursor=(url.searchParams.get('before')||'').split(':'),before=Number(cursor[0]||Number.MAX_SAFE_INTEGER),beforeId=cursor[1]||'~';
    check(Number.isSafeInteger(before)&&before>0&&(beforeId==='~'||validId(beforeId)),'نشانگر ذخیره‌ها معتبر نیست.');
    const {results}=await env.DB.prepare(`SELECT sm.created_at AS savedAt,m.id,m.chat_id AS chatId,m.sender_id AS senderId,u.display_name AS senderName,m.text,m.created_at AS createdAt,c.title,c.type FROM saved_messages sm JOIN messages m ON m.id=sm.message_id JOIN users u ON u.id=m.sender_id JOIN chats c ON c.id=m.chat_id JOIN chat_members cm ON cm.chat_id=c.id AND cm.user_id=sm.user_id WHERE sm.user_id=? AND (sm.created_at<? OR (sm.created_at=? AND m.id<?)) AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=sm.user_id) ORDER BY sm.created_at DESC,m.id DESC LIMIT 8`).bind(userId,before,before,beforeId).all<any>();
    const enriched=[];
    for (const row of results) enriched.push(...await enrichMessages(env,row.chatId,userId,[row]));
    return jsonResponse(enriched);
  }
  const changesMatch=path.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/changes$/);
  if(changesMatch&&method==='POST') {
    const chatId=changesMatch[1];await requireChat(env,chatId,userId);const body=await inputJson(request);
    check(Array.isArray(body.ids)&&body.ids.length>0&&body.ids.length<=100&&body.ids.every(validId),'شناسه‌های پیام معتبر نیستند.');
    const {results}=await env.DB.prepare(`SELECT m.id,m.chat_id AS chatId,m.sender_id AS senderId,u.display_name AS senderName,m.text,m.created_at AS createdAt FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.chat_id=? AND m.id IN (SELECT value FROM json_each(?))`).bind(chatId,JSON.stringify(body.ids)).all<any>();
    const combined=new Map(results.map(row=>[row.id,row]));
    try {const response=await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId)).fetch('https://internal/message-snapshot',{method:'POST',body:JSON.stringify({ids:body.ids,chatId})});if(response.ok)for(const row of await response.json<any[]>())combined.set(row.id,row);}catch{/* D1 fallback retains its last confirmed revisions. */}
    return jsonResponse(await enrichMessages(env,chatId,userId,[...combined.values()]));
  }
  const joinMatch=path.match(/^\/api\/invites\/([a-f0-9]{64})\/join$/);
  if (joinMatch && method==='POST') {
    check(await allowRequest(env,'join',userId,30,3600_000),'تلاش‌های عضویت زیاد است؛ بعداً تلاش کنید.',429);
    const hash=await tokenHash(joinMatch[1]),now=Date.now(),grantId=crypto.randomUUID();
    const invite=await env.DB.prepare('SELECT chat_id FROM group_invites WHERE token_hash=?').bind(hash).first<{chat_id:string}>();
    check(invite,'دعوت معتبر نیست.',404);
    if (!await chatAccess(env,invite.chat_id,userId)) {
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO group_redemptions SELECT token_hash,?,?,? FROM group_invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND uses<use_limit AND (SELECT count(*) FROM chat_members WHERE chat_id=group_invites.chat_id)<(CASE WHEN EXISTS(SELECT 1 FROM broadcast_channels WHERE chat_id=group_invites.chat_id) THEN 10000 ELSE 100 END)`).bind(userId,now,grantId,hash,now),
        env.DB.prepare('UPDATE group_invites SET uses=(SELECT count(*) FROM group_redemptions WHERE token_hash=?) WHERE token_hash=?').bind(hash,hash),
        env.DB.prepare('INSERT OR IGNORE INTO chat_members(chat_id,user_id,joined_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM group_redemptions r JOIN group_invites i ON i.token_hash=r.token_hash WHERE r.token_hash=? AND r.user_id=? AND r.grant_id=? AND i.revoked_at IS NULL AND i.expires_at>?)').bind(invite.chat_id,userId,now,hash,userId,grantId,now),
      ]);
    }
    check(await chatAccess(env,invite.chat_id,userId),'دعوت منقضی، لغو یا مصرف شده است یا ظرفیت پر شده است.',403);
    return jsonResponse({chatId:invite.chat_id});
  }
  const match=path.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/(details|preferences|group|invites|leave|search|messages\/([a-zA-Z0-9_-]+)\/(edit|delete|hide|reaction|save|pin))$/);
  if (!match) return null;
  const chatId=match[1],action=match[2],messageId=match[3],messageAction=match[4];
  const access=await requireChat(env,chatId,userId);
  if (action==='details' && method==='GET') {
    const {results:members}=await env.DB.prepare(`SELECT u.id,u.username,u.display_name AS displayName,p.avatar,p.about,COALESCE(g.role,'member') AS role FROM chat_members cm JOIN users u ON u.id=cm.user_id LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN group_roles g ON g.chat_id=cm.chat_id AND g.user_id=u.id WHERE cm.chat_id=? AND (? OR g.role IN ('owner','admin')) ORDER BY cm.rowid LIMIT 500`).bind(chatId,!access.isChannel||manager(access.role)?1:0).all();
    const memberCount=(await env.DB.prepare('SELECT count(*) AS n FROM chat_members WHERE chat_id=?').bind(chatId).first<{n:number}>())?.n||0;
    const {results:hidden}=await env.DB.prepare('SELECT message_id FROM message_hidden WHERE chat_id=? AND user_id=?').bind(chatId,userId).all<{message_id:string}>();
    const pin=await env.DB.prepare('SELECT message_id FROM chat_pins WHERE chat_id=?').bind(chatId).first<{message_id:string}>();
    return jsonResponse({...access,isChannel:!!access.isChannel,memberCount,members,hidden:hidden.map(row=>row.message_id),pinnedMessageId:pin?.message_id||null,blocked:await isBlocked(env,chatId,userId)});
  }
  if (action==='preferences' && method==='PATCH') {
    const body=await inputJson(request);
    check(['archived','muted','pinned'].some(key=>typeof body[key]==='boolean'),'تنظیم گفتگو معتبر نیست.');
    await env.DB.prepare('INSERT OR IGNORE INTO chat_preferences(chat_id,user_id) VALUES (?,?)').bind(chatId,userId).run();
    for (const key of ['archived','muted','pinned']) if (typeof body[key]==='boolean') await env.DB.prepare(`UPDATE chat_preferences SET ${key}=? WHERE chat_id=? AND user_id=?`).bind(body[key]?1:0,chatId,userId).run();
    return jsonResponse({ok:true});
  }
  if (action==='leave' && method==='POST') {
    check(access.type==='group','خروج برای گروه است.');
    const count=await env.DB.prepare('SELECT count(*) AS n FROM chat_members WHERE chat_id=?').bind(chatId).first<{n:number}>();
    check(access.role!=='owner'||count?.n===1,'پیش از خروج، مالکیت گروه را منتقل کنید.',409);
    const changed=await env.DB.batch([env.DB.prepare("DELETE FROM chat_members WHERE chat_id=? AND user_id=? AND (NOT EXISTS(SELECT 1 FROM group_roles WHERE chat_id=? AND user_id=? AND role='owner') OR (SELECT count(*) FROM chat_members WHERE chat_id=?)=1)").bind(chatId,userId,chatId,userId,chatId),env.DB.prepare('DELETE FROM group_roles WHERE chat_id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?)').bind(chatId,userId,chatId,userId),env.DB.prepare('UPDATE group_invites SET revoked_at=? WHERE chat_id=? AND NOT EXISTS(SELECT 1 FROM chat_members WHERE chat_id=?)').bind(Date.now(),chatId,chatId)]);
    check(changed[0].meta.changes,'نقش شما تغییر کرده است؛ پیش از خروج مالکیت را منتقل کنید.',409);
    await refreshRoom(env,chatId); return jsonResponse({ok:true});
  }
  if (action==='group' && method==='PATCH') {
    check(access.type==='group' && manager(access.role),'این تغییر فقط برای مالک یا مدیر گروه است.',403);
    const body=await inputJson(request);
    if (body.action==='channel') {
      check(access.isChannel,'این تغییر فقط برای کانال است.');
      const visibility=body.visibility==='public'?'public':'private',handle=visibility==='public'?String(body.handle||'').trim().toLowerCase():null,description=String(body.description||'').trim();
      check(visibility==='private'||/^[a-z][a-z0-9_]{4,31}$/.test(handle!),'نشانی کانال عمومی باید با حرف انگلیسی شروع شود و ۵ تا ۳۲ حرف، عدد یا _ باشد.');
      check(description.length<=255,'توضیح کانال حداکثر ۲۵۵ کاراکتر است.');
      check(!handle||!await env.DB.prepare('SELECT 1 FROM broadcast_channels WHERE handle=? AND chat_id!=?').bind(handle,chatId).first(),'این نشانی کانال قبلاً گرفته شده است.',409);
      await env.DB.prepare('UPDATE broadcast_channels SET visibility=?,handle=?,description=? WHERE chat_id=?').bind(visibility,handle,description,chatId).run();
    }
    else if (body.action==='delete') {
      check(access.role==='owner','فقط مالک می‌تواند آن را حذف کند.',403);
      await deleteChat(env,chatId); return jsonResponse({ok:true});
    }
    else if (body.action==='rename') { check(typeof body.title==='string'&&body.title.trim().length>0&&body.title.trim().length<=100,'نام باید بین ۱ تا ۱۰۰ کاراکتر باشد.'); const changed=await env.DB.prepare("UPDATE chats SET title=? WHERE id=? AND EXISTS(SELECT 1 FROM group_roles WHERE chat_id=? AND user_id=? AND role IN ('owner','admin'))").bind(body.title.trim(),chatId,chatId,userId).run(); check(changed.meta.changes,'مجوز مدیریت تغییر کرده است.',403); }
    else {
      check(validId(body.userId)&&body.userId!==userId,'عضو معتبر را انتخاب کنید.');
      const target=await requireChat(env,chatId,body.userId);
      if (body.action==='remove') { check(target.role!=='owner' && (access.role==='owner'||target.role==='member'),'اجازهٔ حذف این عضو را ندارید.',403); await env.DB.batch([env.DB.prepare("DELETE FROM chat_members WHERE chat_id=? AND user_id=? AND COALESCE((SELECT role FROM group_roles WHERE chat_id=chat_members.chat_id AND user_id=chat_members.user_id),'member') != 'owner' AND EXISTS(SELECT 1 FROM group_roles a WHERE a.chat_id=chat_members.chat_id AND a.user_id=? AND (a.role='owner' OR (a.role='admin' AND COALESCE((SELECT role FROM group_roles t WHERE t.chat_id=chat_members.chat_id AND t.user_id=chat_members.user_id),'member')='member')))").bind(chatId,body.userId,userId),env.DB.prepare('DELETE FROM group_roles WHERE chat_id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?)').bind(chatId,body.userId,chatId,body.userId)]); }
      else if (body.action==='role') { check(access.role==='owner'&&['admin','member'].includes(body.role),'فقط مالک می‌تواند نقش مدیر را تغییر دهد.',403); const changed=await env.DB.prepare("INSERT INTO group_roles SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM group_roles WHERE chat_id=? AND user_id=? AND role='owner') AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?) ON CONFLICT(chat_id,user_id) DO UPDATE SET role=excluded.role").bind(chatId,body.userId,body.role,chatId,userId,chatId,body.userId).run(); check(changed.meta.changes,'مالکیت گروه تغییر کرده است.',403); }
      else if (body.action==='transfer') {
        check(access.role==='owner','فقط مالک می‌تواند مالکیت را منتقل کند.',403);
        const changed=await env.DB.batch([
          env.DB.prepare("UPDATE group_roles SET role='admin' WHERE chat_id=? AND user_id=? AND role='owner' AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?)").bind(chatId,userId,chatId,body.userId),
          env.DB.prepare("INSERT INTO group_roles SELECT ?,?,'owner' WHERE changes()=1 ON CONFLICT(chat_id,user_id) DO UPDATE SET role='owner'").bind(chatId,body.userId),
        ]);
        check(changed[0].meta.changes,'مالکیت یا عضویت گروه هم‌زمان تغییر کرده است.',409);
      }
      else throw new InputError('تغییر گروه معتبر نیست.');
    }
    await refreshRoom(env,chatId); return jsonResponse({ok:true});
  }
  if (action==='invites') {
    check(access.type==='group' && manager(access.role),'دعوت گروه فقط برای مالک یا مدیر است.',403);
    if (method==='GET') return jsonResponse((await env.DB.prepare('SELECT token_hash AS id,expires_at AS expiresAt,use_limit AS useLimit,uses,revoked_at AS revokedAt FROM group_invites WHERE chat_id=? ORDER BY expires_at DESC LIMIT 100').bind(chatId).all()).results);
    const body=await inputJson(request);
    if (method==='POST') { const options=inviteOptions(body),token=inviteToken(); await env.DB.prepare('INSERT INTO group_invites(token_hash,chat_id,created_by,expires_at,use_limit) VALUES (?,?,?,?,?)').bind(await tokenHash(token),chatId,userId,Date.now()+options.hours*3600_000,options.uses).run(); return jsonResponse({token},201); }
    if (method==='DELETE') { check(typeof body.id==='string','دعوت معتبر نیست.'); await env.DB.prepare('UPDATE group_invites SET revoked_at=? WHERE token_hash=? AND chat_id=?').bind(Date.now(),body.id,chatId).run(); return jsonResponse({ok:true}); }
  }
  if (action==='search' && method==='GET') {
    const query=normalizePersian((url.searchParams.get('q')||'').trim()); check(query.length>=1&&query.length<=100,'عبارت جستجو بین ۱ تا ۱۰۰ کاراکتر است.');
    const cursor=(url.searchParams.get('before')||'').split(':');
    const before=Number(cursor[0]||Number.MAX_SAFE_INTEGER), beforeId=cursor[1]||'~'; check(Number.isSafeInteger(before)&&before>0&&(beforeId==='~'||validId(beforeId)),'نشانگر جستجو معتبر نیست.');
    const {results}=await env.DB.prepare(`SELECT m.id,m.chat_id AS chatId,m.sender_id AS senderId,u.display_name AS senderName,m.text,m.created_at AS createdAt FROM message_search s JOIN messages m ON m.id=s.message_id JOIN users u ON u.id=m.sender_id LEFT JOIN message_details d ON d.message_id=m.id WHERE s.chat_id=? AND instr(s.normalized,?)>0 AND COALESCE(d.deleted_at,0)=0 AND (m.created_at<? OR (m.created_at=? AND m.id<?)) AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) ORDER BY m.created_at DESC,m.id DESC LIMIT 50`).bind(chatId,query,before,before,beforeId,userId).all<any>();
    return jsonResponse((await enrichMessages(env,chatId,userId,results)).filter(message=>!message.deletedAt&&normalizePersian(message.text).includes(query)));
  }
  if (messageAction && method==='POST') {
    const body=await inputJson(request);
    if (['edit','delete','reaction'].includes(messageAction)) {
      const room=env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
      const response=await room.fetch('https://internal/message-action',{method:'POST',body:JSON.stringify({...body,actor:userId,sessionId:auth.sid,chatId,messageId,action:messageAction})});
      return jsonResponse(await response.json(),response.status);
    }
    const exists=await env.DB.prepare('SELECT 1 FROM messages WHERE chat_id=? AND id=?').bind(chatId,messageId).first(); check(exists,'پیام هنوز در حال همگام‌سازی است؛ دوباره تلاش کنید.',409);
    if (messageAction==='hide') { await env.DB.prepare('INSERT OR IGNORE INTO message_hidden VALUES (?,?,?)').bind(messageId,chatId,userId).run(); return jsonResponse({ok:true}); }
    if (messageAction==='save') { if(body.saved===false) await env.DB.prepare('DELETE FROM saved_messages WHERE user_id=? AND message_id=?').bind(userId,messageId).run(); else await env.DB.prepare('INSERT OR IGNORE INTO saved_messages VALUES (?,?,?,?)').bind(userId,messageId,chatId,Date.now()).run(); return jsonResponse({ok:true}); }
    if (messageAction==='pin') { check(access.type!=='group'||manager(access.role),'سنجاق پیام گروه فقط برای مالک یا مدیر است.',403); if(body.pinned===false) await env.DB.prepare('DELETE FROM chat_pins WHERE chat_id=? AND message_id=?').bind(chatId,messageId).run(); else await env.DB.prepare('INSERT INTO chat_pins VALUES (?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET message_id=excluded.message_id,pinned_by=excluded.pinned_by,created_at=excluded.created_at').bind(chatId,messageId,userId,Date.now()).run(); return jsonResponse({ok:true}); }
  }
  return null;
}
