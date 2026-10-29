import { Env, JwtPayload } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { validId, tokenHash } from './access.js';
import { allowRequest } from './limits.js';
import { serverHost } from './discovery.js';

type Channel = { id:string; owner_id:string; title:string; visibility:string; role?:string };
type Actor = { userId:string; tokenId?:string };
type Post = { id:string; channel_id:string; author_id:string; text:string; created_at:number; updated_at:number; deleted_at:number };
const check = (condition:unknown,message:string,status=400) => { if(!condition) throw new InputError(message,status); };
const encoder = new TextEncoder();
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
const b64 = (bytes:Uint8Array) => btoa(String.fromCharCode(...bytes));
const bytes = (value:string) => Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const view = (post:Post) => ({id:post.id,channelId:post.channel_id,authorId:post.author_id,text:post.deleted_at?'':post.text,createdAt:post.created_at,updatedAt:post.updated_at,deletedAt:post.deleted_at});
async function channel(env:Env,id:string,userId:string):Promise<Channel> {
  const row=await env.DB.prepare(`SELECT c.*,CASE WHEN c.owner_id=? THEN 'owner' ELSE m.role END AS role FROM channels c LEFT JOIN channel_members m ON m.channel_id=c.id AND m.user_id=? WHERE c.id=?`).bind(userId,userId,id).first<Channel>();
  check(row&&(row.visibility==='public'||row.role),'کانال پیدا نشد یا عضو آن نیستید.',404);return row!;
}
function owner(row:Channel,userId:string) { check(row.owner_id===userId,'این بخش فقط برای مالک کانال است.',403); }
function proof(actor:Actor) {
  return actor.tokenId ? {sql:`EXISTS(SELECT 1 FROM channel_tokens t WHERE t.id=? AND t.channel_id=channels.id AND t.owner_id=channels.owner_id AND t.expires_at>? AND t.scope IN ('write','read-write') AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=t.owner_id AND s.disabled_at IS NOT NULL))`,params:[actor.tokenId,Date.now()]}
    : {sql:`(owner_id=? OR EXISTS(SELECT 1 FROM channel_members m WHERE m.channel_id=channels.id AND m.user_id=? AND m.role='admin'))`,params:[actor.userId,actor.userId]};
}
const roomForQueue = `NOT EXISTS(SELECT 1 FROM channel_webhooks w WHERE w.channel_id=channels.id) OR ((SELECT count(*) FROM channel_outbox q JOIN channel_webhooks w ON w.id=q.webhook_id WHERE w.channel_id=channels.id)<100 AND (SELECT count(*) FROM channel_outbox)<2000)`;
async function posts(env:Env,id:string,url:URL) {
  const cursor=url.searchParams.get('before')||'';let before:number|null=null,last='';
  if(cursor){const match=cursor.match(/^(\d{1,16}):([a-zA-Z0-9_-]{1,100})$/);check(match,'نشانگر پست معتبر نیست.');before=Number(match![1]);last=match![2];check(Number.isSafeInteger(before),'نشانگر پست معتبر نیست.');}
  const {results}=await env.DB.prepare(`SELECT * FROM channel_posts WHERE channel_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 31`).bind(id,before,before,before,last).all<Post>();
  return {posts:results.slice(0,30).map(view),next:results.length>30?results[29].created_at+':'+results[29].id:null};
}
async function writePost(request:Request,env:Env,id:string,actor:Actor,postId?:string) {
  check(await allowRequest(env,'channel-write',actor.tokenId||actor.userId,30,60_000),'انتشار پست زیاد است؛ یک دقیقه صبر کنید.',429);
  const previous=postId?await env.DB.prepare('SELECT * FROM channel_posts WHERE id=? AND channel_id=?').bind(postId,id).first<Post>():null;
  if(postId)check(previous&&!previous.deleted_at,'پست پیدا نشد یا حذف شده است.',404);
  const body=request.method==='DELETE'?{}:await inputJson(request),deleted=request.method==='DELETE';
  check(deleted||typeof body.text==='string'&&body.text.trim().length>0&&body.text.trim().length<=8192,'متن پست بین ۱ تا ۸۱۹۲ نویسه است.');
  const now=Math.max(Date.now(),(previous?.updated_at||0)+1),post:Post={id:postId||crypto.randomUUID(),channel_id:id,author_id:previous?.author_id||actor.userId,text:deleted?'':body.text.trim(),created_at:previous?.created_at||now,updated_at:now,deleted_at:deleted?now:0};
  const eventId=crypto.randomUUID(),permission=proof(actor),authorized=`EXISTS(SELECT 1 FROM channels WHERE id=? AND ${permission.sql} AND (${roomForQueue}))`;
  const mutation=previous?env.DB.prepare(`UPDATE channel_posts SET text=?,updated_at=?,deleted_at=?,event_id=? WHERE id=? AND channel_id=? AND updated_at=? AND ${authorized}`).bind(post.text,now,post.deleted_at,eventId,post.id,id,previous.updated_at,id,...permission.params)
    :env.DB.prepare(`INSERT INTO channel_posts SELECT ?,?,?,?,?,?,0,? WHERE ${authorized} AND (SELECT count(*) FROM channel_posts WHERE channel_id=?)<1000`).bind(post.id,id,actor.userId,post.text,now,now,eventId,id,...permission.params,id);
  const payload=JSON.stringify({id:eventId,type:deleted?'post.deleted':previous?'post.edited':'post.created',createdAt:now,channelId:id,post:view(post)});
  const result=await env.DB.batch([mutation,env.DB.prepare(`INSERT INTO channel_outbox(id,webhook_id,payload,next_at) SELECT ?,w.id,?,? FROM channel_webhooks w WHERE w.channel_id=? AND EXISTS(SELECT 1 FROM channel_posts p WHERE p.id=? AND p.event_id=?)`).bind(eventId,payload,now,id,post.id,eventId)]);
  check(result[0].meta.changes,'انتشار کامل نشد: مجوز تغییر کرده، صف وب‌هوک پر است، پست همزمان تغییر کرده یا سقف ۱۰۰۰ پست رسیده است.',409);
  return jsonResponse(view(post),previous?200:201);
}
export async function webhookUrl(env:Env,value:unknown) {
  check(typeof value==='string'&&value.length<=512,'نشانی وب‌هوک معتبر نیست.');
  let url:URL;try{url=new URL(String(value));}catch{throw new InputError('نشانی وب‌هوک باید HTTPS باشد.');}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash,'وب‌هوک فقط HTTPS و بدون رمز، پورت، پرس‌وجو یا fragment است.');
  const host=serverHost(url.hostname),row=await env.DB.prepare("SELECT value FROM site_settings WHERE key='discovery_peers'").first<{value:string}>();
  let peers:unknown=[];try{peers=JSON.parse(row?.value||'[]');}catch{}
  check(/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(host)||Array.isArray(peers)&&peers.includes(host),'وب‌هوک باید روی workers.dev یا دامنه‌ای باشد که مدیر سرویس در فهرست سرورهای مجاز ثبت کرده است.',403);
  return url.href;
}
async function webhookKey(env:Env) {
  check(typeof env.JWT_SECRET==='string'&&env.JWT_SECRET.length>=32,'کلید امن سرور تنظیم نشده است.',503);
  const material=await crypto.subtle.importKey('raw',encoder.encode(env.JWT_SECRET),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('WIHM channels v1'),info:encoder.encode('webhook secrets')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function seal(env:Env,id:string,secret:string) {
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(id)},await webhookKey(env),encoder.encode(secret));
  return b64(iv)+'.'+b64(new Uint8Array(cipher));
}
async function unseal(env:Env,id:string,cipher:string) {
  const [iv,data]=cipher.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(id)},await webhookKey(env),bytes(data)));
}

export async function publicChannels(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url),match=url.pathname.match(/^\/api\/channel-api\/([a-zA-Z0-9_-]{1,100})\/posts(?:\/([a-zA-Z0-9_-]{1,100}))?$/);
  if(!url.pathname.startsWith('/api/channel-api/'))return null;
  try {
    check(match,'مسیر API کانال پیدا نشد.',404);
    const token=request.headers.get('Authorization')?.match(/^Bearer (wihm_bot_[a-f0-9]{64})$/)?.[1];check(token,'توکن ربات معتبر نیست.',401);
    const row=await env.DB.prepare(`SELECT t.* FROM channel_tokens t JOIN channels c ON c.id=t.channel_id AND c.owner_id=t.owner_id WHERE t.token_hash=? AND t.channel_id=? AND t.expires_at>? AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=t.owner_id AND s.disabled_at IS NOT NULL)`).bind(await tokenHash(token!),match![1],Date.now()).first<any>();
    check(row,'توکن ربات معتبر، فعال یا مجاز به این کانال نیست.',401);
    check(await allowRequest(env,'channel-api',row.id,60,60_000),'درخواست زیاد است.',429);
    if(request.method==='GET'&&!match![2]){check(['read','read-write'].includes(row.scope),'توکن اجازهٔ خواندن ندارد.',403);return jsonResponse(await posts(env,match![1],url));}
    check(['write','read-write'].includes(row.scope),'توکن اجازهٔ نوشتن ندارد.',403);
    check(request.method==='POST'&&!match![2]||['PATCH','DELETE'].includes(request.method)&&match![2],'روش API معتبر نیست.',405);
    return await writePost(request,env,match![1],{userId:row.owner_id,tokenId:row.id},match![2]);
  } catch(error){if(error instanceof InputError)return jsonResponse({error:error.message},error.status);return jsonResponse({error:'API کانال کامل نشد.'},503);}
}

export async function handleChannels(request:Request,env:Env,auth:JwtPayload):Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname;
  if(path!=='/api/channels'&&!path.startsWith('/api/channels/'))return null;
  if(path==='/api/channels') {
    if(request.method==='GET') {
      const after=url.searchParams.get('after')||'';check(!after||validId(after),'نشانگر معتبر نیست.');
      const discover=url.searchParams.get('discover')==='1';
      const {results}=await env.DB.prepare(`SELECT c.id,c.title,c.visibility,c.owner_id AS ownerId,CASE WHEN c.owner_id=? THEN 'owner' ELSE m.role END AS role FROM channels c LEFT JOIN channel_members m ON m.channel_id=c.id AND m.user_id=? WHERE c.id>? AND ${discover?"c.visibility='public'":"(c.owner_id=? OR m.user_id IS NOT NULL)"} ORDER BY c.id LIMIT 31`).bind(auth.userId,auth.userId,after,...(discover?[]:[auth.userId])).all<any>();
      return jsonResponse({channels:results.slice(0,30),next:results.length>30?results[29].id:null});
    }
    check(request.method==='POST','روش معتبر نیست.',405);
    const body=await inputJson(request);check(typeof body.title==='string'&&body.title.trim().length>0&&body.title.trim().length<=100&&['public','private'].includes(body.visibility),'نام یا نوع کانال معتبر نیست.');
    const id=crypto.randomUUID(),invite=random(),result=await env.DB.prepare('INSERT INTO channels SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM channels WHERE owner_id=?)<5').bind(id,auth.userId,body.title.trim(),body.visibility,await tokenHash(invite),Date.now(),auth.userId).run();
    check(result.meta.changes,'هر حساب می‌تواند حداکثر پنج کانال بسازد.',409);return jsonResponse({id,title:body.title.trim(),visibility:body.visibility,invite},201);
  }
  const match=path.match(/^\/api\/channels\/([a-zA-Z0-9_-]{1,100})(?:\/(posts|subscribe|members|invite|tokens|webhook)(?:\/([a-zA-Z0-9_-]{1,100}))?)?$/);
  check(match,'مسیر کانال پیدا نشد.',404);const [,id,action,item]=match!;
  // Private invitation verification precedes metadata access and reveals no private title.
  if(action==='subscribe'&&request.method==='POST') {
    const body=await inputJson(request),row=await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(id).first<any>();
    check(await allowRequest(env,'channel-join',auth.userId,30,3600_000),'تلاش عضویت زیاد است.',429);
    check(row&&(row.visibility==='public'||typeof body.invite==='string'&&/^[a-f0-9]{64}$/.test(body.invite)&&await tokenHash(body.invite)===row.invite_hash),'کانال یا دعوت‌نامه معتبر نیست.',404);
    const inviteHash=typeof body.invite==='string'?await tokenHash(body.invite):'';
    const result=await env.DB.prepare(`INSERT OR IGNORE INTO channel_members SELECT ?,?,'subscriber' WHERE (SELECT count(*) FROM channel_members WHERE channel_id=?)<10000 AND EXISTS(SELECT 1 FROM channels WHERE id=? AND (visibility='public' OR invite_hash=?))`).bind(id,auth.userId,id,id,inviteHash).run();
    check(result.meta.changes||await env.DB.prepare('SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?').bind(id,auth.userId).first(),'ظرفیت کانال پر است.',409);return jsonResponse({ok:true});
  }
  const row=await channel(env,id,auth.userId);
  if(!action&&request.method==='GET')return jsonResponse({id:row.id,title:row.title,visibility:row.visibility,ownerId:row.owner_id,role:row.role||null});
  if(!action&&request.method==='DELETE'){owner(row,auth.userId);await env.DB.prepare('DELETE FROM channels WHERE id=? AND owner_id=?').bind(id,auth.userId).run();return jsonResponse({ok:true});}
  if(action==='subscribe'&&request.method==='DELETE'){await env.DB.prepare('DELETE FROM channel_members WHERE channel_id=? AND user_id=?').bind(id,auth.userId).run();return jsonResponse({ok:true});}
  if(action==='posts') {
    if(request.method==='GET'&&!item)return jsonResponse(await posts(env,id,url));
    check(row.role==='owner'||row.role==='admin','مشترکان اجازهٔ انتشار ندارند.',403);
    check(request.method==='POST'&&!item||['PATCH','DELETE'].includes(request.method)&&item,'روش انتشار معتبر نیست.',405);
    return writePost(request,env,id,{userId:auth.userId},item);
  }
  owner(row,auth.userId);
  if(action==='members'&&request.method==='GET'){const {results}=await env.DB.prepare(`SELECT m.user_id AS userId,u.username,m.role FROM channel_members m JOIN users u ON u.id=m.user_id WHERE m.channel_id=? AND m.role='admin' ORDER BY u.username LIMIT 20`).bind(id).all();return jsonResponse(results);}
  if(action==='members'&&request.method==='POST'){
    const body=await inputJson(request);check(validId(body.userId)&&['admin','subscriber'].includes(body.role)&&body.userId!==auth.userId,'کاربر یا نقش معتبر نیست.');
    const result=await env.DB.prepare(`INSERT INTO channel_members SELECT ?,u.id,? FROM users u WHERE u.id=? AND (?='subscriber' OR (SELECT count(*) FROM channel_members WHERE channel_id=? AND role='admin')<20 OR EXISTS(SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=u.id AND role='admin')) ON CONFLICT(channel_id,user_id) DO UPDATE SET role=excluded.role`).bind(id,body.role,body.userId,body.role,id,id).run();check(result.meta.changes,'کاربر پیدا نشد یا سقف مدیران رسیده است.',409);return jsonResponse({ok:true});
  }
  if(action==='invite'&&request.method==='POST'){const invite=random();await env.DB.prepare('UPDATE channels SET invite_hash=? WHERE id=? AND owner_id=?').bind(await tokenHash(invite),id,auth.userId).run();return jsonResponse({invite});}
  if(action==='tokens') {
    await env.DB.prepare('DELETE FROM channel_tokens WHERE channel_id=? AND expires_at<=?').bind(id,Date.now()).run();
    if(request.method==='GET'){const {results}=await env.DB.prepare('SELECT id,label,scope,expires_at AS expiresAt FROM channel_tokens WHERE channel_id=? ORDER BY expires_at').bind(id).all();return jsonResponse(results);}
    if(request.method==='DELETE'&&item){await env.DB.prepare('DELETE FROM channel_tokens WHERE id=? AND channel_id=? AND owner_id=?').bind(item,id,auth.userId).run();return jsonResponse({ok:true});}
    check(request.method==='POST'&&!item,'روش توکن معتبر نیست.',405);const body=await inputJson(request);
    check(typeof body.label==='string'&&body.label.trim().length>0&&body.label.length<=60&&['read','write','read-write'].includes(body.scope)&&Number.isInteger(body.days)&&body.days>=1&&body.days<=90,'نام، مجوز و انقضای توکن (۱ تا ۹۰ روز) معتبر نیست.');
    const token='wihm_bot_'+random(),tokenId=crypto.randomUUID(),expiresAt=Date.now()+body.days*86400_000;
    const result=await env.DB.prepare('INSERT INTO channel_tokens SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM channel_tokens WHERE channel_id=?)<10').bind(tokenId,id,auth.userId,await tokenHash(token),body.label.trim(),body.scope,expiresAt,id).run();check(result.meta.changes,'حداکثر ده توکن فعال برای هر کانال مجاز است.',409);return jsonResponse({id:tokenId,token,scope:body.scope,expiresAt},201);
  }
  if(action==='webhook') {
    if(request.method==='GET'){const hook=await env.DB.prepare('SELECT id,url,created_at AS createdAt FROM channel_webhooks WHERE channel_id=?').bind(id).first();const {results}=await env.DB.prepare('SELECT q.id,q.attempts,q.next_at AS nextAt,q.error FROM channel_outbox q JOIN channel_webhooks w ON w.id=q.webhook_id WHERE w.channel_id=? ORDER BY q.next_at LIMIT 100').bind(id).all();return jsonResponse({hook,outbox:results});}
    if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM channel_webhooks WHERE channel_id=?').bind(id).run();return jsonResponse({ok:true});}
    check(request.method==='POST','روش وب‌هوک معتبر نیست.',405);const body=await inputJson(request),target=await webhookUrl(env,body.url),hookId=crypto.randomUUID(),secret=random(),cipher=await seal(env,hookId,secret);
    await env.DB.batch([env.DB.prepare('DELETE FROM channel_webhooks WHERE channel_id=?').bind(id),env.DB.prepare('INSERT INTO channel_webhooks VALUES (?,?,?,?,?)').bind(hookId,id,target,cipher,Date.now())]);
    return jsonResponse({id:hookId,url:target,secret},201);
  }
  throw new InputError('مسیر کانال پیدا نشد.',404);
}

export async function scheduledChannels(env:Env,fetcher:typeof fetch=fetch,now=Date.now()) {
  const {results}=await env.DB.prepare(`SELECT q.*,w.channel_id,w.url,w.secret_cipher FROM channel_outbox q JOIN channel_webhooks w ON w.id=q.webhook_id JOIN channels c ON c.id=w.channel_id WHERE q.next_at<=? AND q.locked_until<=? AND q.attempts<5 AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=c.owner_id AND s.disabled_at IS NOT NULL) ORDER BY q.next_at,q.id LIMIT 5`).bind(now,now).all<any>();
  for(const job of results) {
    const claimed=await env.DB.prepare('UPDATE channel_outbox SET locked_until=?,attempts=attempts+1 WHERE id=? AND locked_until<=? AND attempts=?').bind(now+60_000,job.id,now,job.attempts).run();if(!claimed.meta.changes)continue;
    try {
      const target=await webhookUrl(env,job.url),secret=await unseal(env,job.webhook_id,job.secret_cipher),timestamp=String(Math.floor(now/1000));
      const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(timestamp+'.'+job.payload))),byte=>byte.toString(16).padStart(2,'0')).join('');
      const response=await fetcher(target,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','X-WIHM-Event':job.id,'X-WIHM-Timestamp':timestamp,'X-WIHM-Signature':'sha256='+signature},body:job.payload});
      await response.body?.cancel();if(!response.ok)throw new Error('delivery');
      await env.DB.prepare('DELETE FROM channel_outbox WHERE id=? AND locked_until=?').bind(job.id,now+60_000).run();
    } catch {
      await env.DB.prepare('UPDATE channel_outbox SET locked_until=0,next_at=?,error=? WHERE id=? AND locked_until=?').bind(now+Math.min(3600_000,60_000*2**job.attempts),'ارسال تأیید نشد؛ پس از پنج تلاش متوقف می‌شود.',job.id,now+60_000).run();
    }
  }
}
