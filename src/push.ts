import { encryptNotification, vapidHeaders } from '@block65/webcrypto-web-push';
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
async function deliver(env:Env,row:any,data:any,ttl:number,topic:string,fetcher:typeof fetch) {
  if(!validPushEndpoint(row.endpoint))throw new InputError('اشتراک اعلان معتبر نیست؛ دوباره اعلان این دستگاه را فعال کنید.',409);
  const subscription={endpoint:row.endpoint,expirationTime:null,keys:{p256dh:row.p256dh,auth:row.auth}};
  const {headers}=await vapidHeaders(subscription,{subject:'https://github.com/DarkPoesidon/WIHM-Cloudflare',publicKey:env.VAPID_PUBLIC_KEY!,privateKey:env.VAPID_PRIVATE_KEY!});
  // Padding every short notification to 4096 bytes causes HTTP 413 on affected push services.
  const body=await encryptNotification(subscription,new TextEncoder().encode(JSON.stringify(data)),{pad:false});
  if(body.byteLength>4096)throw new InputError('حجم اعلان بیش از حد مجاز است.',413);
  const payload={method:'POST',headers:{...headers,ttl:String(ttl),topic,'content-encoding':'aes128gcm','content-type':'application/octet-stream'},body};
  let response:Response;
  try{response=await fetcher(row.endpoint,{...payload,redirect:'manual',signal:AbortSignal.timeout(10_000)});}catch{throw new InputError('ارتباط سرور با سرویس اعلان مرورگر برقرار نشد؛ دوباره تلاش کنید.',502);}
  await response.body?.cancel();
  if([404,410].includes(response.status)){await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(row.id).run();return false;}
  if(!response.ok)throw new InputError(`سرویس اعلان درخواست را نپذیرفت (HTTP ${response.status}). اعلان را دوباره فعال کنید؛ اگر ادامه داشت دسترسی شبکه و تنظیمات سرور را بررسی کنید.`,502);
  return true;
}
function checkDeliveries(results:PromiseSettledResult<unknown>[]) {const rejected=results.find(row=>row.status==='rejected') as PromiseRejectedResult|undefined;if(rejected)throw rejected.reason;}
export async function sendTestPush(env:Env,userId:string,sid:string) {
  if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY)throw new InputError('کلید اعلان سرور تنظیم نیست.',503);
  const row=await env.DB.prepare(`SELECT ps.* FROM push_subscriptions ps JOIN user_sessions s ON s.id=ps.session_id AND s.user_id=ps.user_id JOIN user_profiles p ON p.user_id=ps.user_id AND p.notifications=1 WHERE ps.user_id=? AND ps.session_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND ${SESSION_VERSION_SQL}`).bind(userId,sid,Date.now()).first<any>();
  if(!row)throw new InputError('اشتراک فعال این دستگاه پیدا نشد؛ ابتدا فعال‌کردن اعلان را بزنید.',409);
  if(!await deliver(env,row,{title:'آزمایش اعلان ابرانه',body:'مسیر اعلان سرور تا این دستگاه کار می‌کند.'},60,'wihm-test',fetch))throw new InputError('اشتراک این دستگاه منقضی شده است؛ دوباره اعلان را فعال کنید.',409);
  return {accepted:true,message:'سرویس مرورگر اعلان را پذیرفت؛ اگر نمایش داده نشد، اعلان سیستم‌عامل، حالت مزاحم نشوید و دسترسی شبکه به سرویس اعلان را بررسی کنید.'};
}
export async function sendUpdatePush(env:Env,version:string,after='',fetcher:typeof fetch=fetch):Promise<string|null> {
  if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY)return null;
  const {results}=await env.DB.prepare(`SELECT ps.* FROM push_subscriptions ps JOIN service_admins a ON a.slot=1 AND a.user_id=ps.user_id
    JOIN user_sessions s ON s.id=ps.session_id AND s.user_id=ps.user_id JOIN user_profiles p ON p.user_id=ps.user_id AND p.notifications=1
    WHERE s.revoked_at IS NULL AND s.expires_at>? AND ${SESSION_VERSION_SQL} AND ps.id>? ORDER BY ps.id LIMIT 24`).bind(Date.now(),after).all<any>();
  checkDeliveries(await Promise.allSettled(results.map(row=>deliver(env,row,{title:'نسخهٔ جدید ابرانه آماده است',body:`نسخهٔ ${version} منتشر شد؛ برای بررسی و تأیید، به‌روزرسانی را از تنظیمات باز کنید.`,kind:'update'},86400,'wihm-update',fetcher))));
  return results.length===24?String(results.at(-1).id):null;
}
export async function sendSecurePush(env:Env,userId:string,thread:string,after='',fetcher:typeof fetch=fetch):Promise<string|null>{
  if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY)return null;
  const {results}=await env.DB.prepare(`SELECT ps.* FROM push_subscriptions ps JOIN user_sessions s ON s.id=ps.session_id AND s.user_id=ps.user_id JOIN user_profiles p ON p.user_id=ps.user_id AND p.notifications=1 WHERE ps.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND ${SESSION_VERSION_SQL} AND NOT EXISTS(SELECT 1 FROM service_user_state us WHERE us.user_id=ps.user_id AND us.disabled_at IS NOT NULL) AND ps.id>? ORDER BY ps.id LIMIT 24`).bind(userId,Date.now(),after).all<any>();
  const topic=(await tokenHash(thread)).slice(0,32);
  checkDeliveries(await Promise.allSettled(results.map(row=>deliver(env,row,{title:'پیام امن تازه در ابرانه',body:'برای مشاهده و تأیید دستگاه مخاطب، برنامه را باز کنید.',kind:'secure',chatId:thread},3600,topic,fetcher))));
  return results.length===24?String(results.at(-1).id):null;
}
// Small pages keep a large group's fan-out below the per-invocation fetch budget.
// The room persists the returned cursor and resumes via its alarm.
export async function sendPush(env: Env, message: Message, fetcher: typeof fetch = fetch, after = '', call?: { callId: string; expiresAt: number; video?: boolean }): Promise<string | null> {
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
    checkDeliveries(await Promise.allSettled(results.slice(offset,offset+8).map(async row=>deliver(env,row,{
      title:call?'تماس ورودی در ابرانه':row.preview?(row.type==='group'?row.title:message.senderName).slice(0,100):'پیام تازه در ابرانه',
      body:call?`برای پاسخ به تماس ${call.video?'تصویری':'صوتی'}، برنامه را باز کنید.`:row.preview?message.text.slice(0,160):'برای دیدن پیام، ابرانه را باز کنید.',chatId:message.chatId,...(call?{kind:'call',callId:call.callId,expiresAt:call.expiresAt}:{messageId:message.id}),
    },call?Math.max(0,Math.ceil((call.expiresAt-Date.now())/1000)):3600,(await tokenHash(call?call.callId:message.chatId)).slice(0,32),fetcher))));
  }
  return results.length===24?String(results.at(-1).id):null;
}
