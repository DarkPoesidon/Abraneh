/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env, JwtPayload } from './types.js';
import { inputJson, InputError, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { decode64, encode64, limitedBytes, sha256 } from './update-bundle.js';

type Source={id:string;source_key:string;kind:'public'|'bot';owner_id:string|null;bot_id:string|null;chat_number:string|null;username:string|null;title:string;last_checked:number;error:string|null;enabled:number;paused:number};
type Bot={id:string;owner_id:string;bot_number:string;username:string;token_cipher:string;secret_hash:string;webhook_url:string;state:string;config_until:number};
type Post={id:number;text:string;media:boolean;createdAt:number;updatedAt:number;updateId:number};
const check=(condition:any,message:string,status=400)=>{if(!condition)throw new InputError(message,status);};
const safeId=(value:string)=>/^[a-f0-9-]{36}$/.test(value);
const randomSecret=()=>encode64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function previewText(value:string) {
  const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0',lrm:'\u200e',rlm:'\u200f',zwnj:'\u200c',zwj:'\u200d',ndash:'–',mdash:'—',hellip:'…'};
  return value.replace(/&(#(?:x[0-9a-fA-F]{1,6}|[0-9]{1,7})|amp|lt|gt|quot|apos|nbsp|lrm|rlm|zwnj|zwj|ndash|mdash|hellip);/g,(match,key)=>{
    if(key[0]!=='#')return named[key];const code=key[1]==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'\ufffd';
  });
}
export function publicChannel(input:unknown) {
  check(typeof input==='string','نام یا لینک کانال عمومی را بنویسید.');let value=String(input).trim();
  if(value.startsWith('https://')||value.startsWith('http://')){let url:URL;try{url=new URL(value);}catch{throw new InputError('لینک کانال معتبر نیست.');}check(url.protocol==='https:'&&url.hostname==='t.me'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash,'فقط لینک عمومی https://t.me پذیرفته می‌شود.');value=url.pathname.replace(/^\/s\//,'/').replace(/^\//,'').replace(/\/$/,'');}
  value=value.replace(/^@/,'');check(/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value),'نام کانال عمومی معتبر نیست؛ برای کانال خصوصی از اتصال ربات استفاده کنید.');return value.toLowerCase();
}
export async function parsePreview(html:string,username:string) {
  const posts:Post[]=[];let current:Post|null=null,title='';
  const handler=new HTMLRewriter()
    .on('.tgme_channel_info_header_title span',{text(t){if(title.length<150)title+=t.text;}})
    .on('.tgme_widget_message[data-post]',{element(element){const parts=(element.getAttribute('data-post')||'').split('/');if(parts[0].toLowerCase()!==username||!/^\d{1,12}$/.test(parts[1])){current=null;return;}const id=Number(parts[1]);if(!Number.isSafeInteger(id)||!id||posts.length>=25){current=null;return;}const now=Date.now();current={id,text:'',media:false,createdAt:now,updatedAt:now,updateId:0};posts.push(current);element.onEndTag(()=>{current=null;});}})
    .on('.tgme_widget_message_text',{text(t){if(current&&current.text.length<8192)current.text+=t.text;}})
    .on('.tgme_widget_message_text br',{element(){if(current)current.text+='\n';}})
    .on('.tgme_widget_message_date time',{element(e){if(current){const date=Date.parse(e.getAttribute('datetime')||'');if(Number.isFinite(date))current.createdAt=date;}}})
    .on('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_player, .tgme_widget_message_document_wrap, .tgme_widget_message_voice_player, .tgme_widget_message_sticker_wrap',{element(){if(current)current.media=true;}});
  await handler.transform(new Response(html)).text();
  return {title:previewText(title).trim().slice(0,120)||'@'+username,posts:posts.filter(p=>p.text.trim()||p.media).map(p=>({...p,text:previewText(p.text).trim().slice(0,8192)}))};
}
async function storePosts(env:Env,sourceId:string,posts:Post[]) {
  if(posts.length)await env.DB.batch(posts.map(p=>env.DB.prepare(`INSERT INTO telegram_posts(source_id,message_id,text,media,created_at,updated_at,update_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source_id,message_id) DO UPDATE SET text=excluded.text,media=excluded.media,updated_at=excluded.updated_at,update_id=excluded.update_id
    WHERE excluded.updated_at>telegram_posts.updated_at OR (excluded.updated_at=telegram_posts.updated_at AND excluded.update_id>=telegram_posts.update_id)`)
    .bind(sourceId,p.id,p.text,p.media?1:0,p.createdAt,p.updatedAt,p.updateId)));
  await env.DB.prepare('DELETE FROM telegram_posts WHERE source_id=? AND message_id NOT IN (SELECT message_id FROM telegram_posts WHERE source_id=? ORDER BY message_id DESC LIMIT 500)').bind(sourceId,sourceId).run();
}
async function refreshPublic(env:Env,source:Source,before?:number,fetcher:typeof fetch=fetch) {
  const started=Date.now();
  try {
    const response=await fetcher(`https://t.me/s/${source.username}${before?'?before='+before:''}`,{redirect:'manual',signal:AbortSignal.timeout(15_000),headers:{'User-Agent':'WIHM-Cloudflare-Channel-Reader'}});
    const bytes=await limitedBytes(response,1_000_000),parsed=await parsePreview(new TextDecoder().decode(bytes),source.username!);
    check(parsed.posts.length||before,'پیش‌نمایش این کانال در دسترس نیست؛ ممکن است خصوصی، محدود یا بدون پست قابل نمایش باشد.',422);
    await storePosts(env,source.id,parsed.posts.map(p=>({...p,updatedAt:started})));
    await env.DB.prepare('UPDATE telegram_sources SET title=?,last_checked=?,error=NULL WHERE id=? AND last_checked<=?').bind(parsed.title,started,source.id,started).run();
  } catch(error){await env.DB.prepare('UPDATE telegram_sources SET last_checked=?,error=? WHERE id=? AND last_checked<=?').bind(started,'دریافت تازهٔ کانال کامل نشد؛ پست‌های قبلی حفظ شده‌اند.',source.id,started).run();throw new InputError('کانال فعلاً از پیش‌نمایش عمومی تلگرام قابل دریافت نیست. بعداً تلاش کنید یا از ربات استفاده کنید.',422);}
}
export async function scheduledTelegram(env:Env) {
  const {results}=await env.DB.prepare("SELECT * FROM telegram_sources s WHERE kind='public' AND enabled=1 AND last_checked<? AND EXISTS(SELECT 1 FROM telegram_subscriptions t WHERE t.source_id=s.id) ORDER BY last_checked,id LIMIT 5").bind(Date.now()-15*60_000).all<Source>();
  // A failed or restricted channel must not suppress other refreshes or updates.
  for(const source of results)try{await refreshPublic(env,source);}catch{/* Status is recorded without provider text. */}
}
async function cipherKey(env:Env) {check(typeof env.TELEGRAM_KEY==='string'&&/^[a-f0-9]{64}$/.test(env.TELEGRAM_KEY),'اتصال ربات آماده نیست؛ صاحب سرویس باید نصب‌کنندهٔ جدید را یک بار اجرا کند.',503);return crypto.subtle.importKey('raw',Uint8Array.from(env.TELEGRAM_KEY!.match(/../g)!,h=>parseInt(h,16)),'AES-GCM',false,['encrypt','decrypt']);}
async function seal(env:Env,token:string,aad:string) {const iv=crypto.getRandomValues(new Uint8Array(12)),data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(aad)},await cipherKey(env),new TextEncoder().encode(token));return JSON.stringify({v:1,iv:encode64(iv),data:encode64(new Uint8Array(data))});}
async function unseal(env:Env,bot:Bot) {const value=JSON.parse(bot.token_cipher);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(value.iv),additionalData:new TextEncoder().encode(bot.owner_id+':'+bot.id)},await cipherKey(env),decode64(value.data)));}
async function botApi(token:string,method:string,body:any={},fetcher:typeof fetch=fetch) {
  let response:Response;try{response=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});}catch{throw new InputError('ارتباط با تلگرام کامل نشد؛ اینترنت یا دسترسی ربات را بررسی کنید.',502);}
  const result=await response.json<any>().catch(()=>null);
  // Never return provider descriptions: they can echo credentials or private URLs.
  if(!response.ok||!result?.ok)throw new InputError('تلگرام درخواست ربات را نپذیرفت؛ توکن و دسترسی ربات را بررسی کنید.',422);return result.result;
}
async function connectBot(request:Request,env:Env,userId:string,input:any) {
  check(typeof input.token==='string'&&/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(input.token),'توکن کامل ربات را از BotFather کپی کنید.');await cipherKey(env);
  const me=await botApi(input.token,'getMe');check(me?.is_bot&&Number.isSafeInteger(me.id)&&typeof me.username==='string','مشخصات ربات معتبر نیست.');
  const old=await env.DB.prepare('SELECT * FROM telegram_bots WHERE owner_id=?').bind(userId).first<Bot>();
  check(!old||old.bot_number===String(me.id),'برای تعویض ربات، ابتدا اتصال ربات فعلی را قطع کنید.',409);
  const id=old?.id||crypto.randomUUID(),secret=randomSecret(),url=new URL('/api/telegram/webhook/'+id,request.url);check(url.protocol==='https:','برای اتصال ربات باید پیام‌رسان با HTTPS باز شده باشد.');
  const now=Date.now(),cipher=await seal(env,input.token,userId+':'+id),hash=await sha256(secret);
  const locked=old?await env.DB.prepare("UPDATE telegram_bots SET config_until=?,state='pending' WHERE id=? AND config_until<?").bind(now+90_000,id,now).run():await env.DB.prepare("INSERT OR IGNORE INTO telegram_bots(id,owner_id,bot_number,username,token_cipher,secret_hash,webhook_url,config_until,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id,userId,String(me.id),me.username,cipher,hash,url.href,now+90_000,now).run();
  check(locked.meta.changes,'این ربات قبلاً متصل است یا تنظیم اتصال دیگری در حال انجام است.',409);
  try {
    const info=await botApi(input.token,'getWebhookInfo');check(!info?.url||info.url===url.href,'این ربات در برنامهٔ دیگری فعال است؛ از یک ربات جدا استفاده کنید.',409);
    await env.DB.prepare('UPDATE telegram_bots SET token_cipher=?,secret_hash=?,webhook_url=?,username=? WHERE id=?').bind(cipher,hash,url.href,me.username,id).run();
    await botApi(input.token,'setWebhook',{url:url.href,secret_token:secret,allowed_updates:['channel_post','edited_channel_post','my_chat_member'],drop_pending_updates:false,max_connections:2});
    await env.DB.prepare("UPDATE telegram_bots SET state='connected',config_until=0 WHERE id=?").bind(id).run();
    return jsonResponse({id,username:me.username,state:'connected'});
  } catch(error){await env.DB.prepare("UPDATE telegram_bots SET state='error',config_until=0 WHERE id=?").bind(id).run();throw error;}
}
export async function telegramWebhook(request:Request,env:Env):Promise<Response|null> {
  const match=new URL(request.url).pathname.match(/^\/api\/telegram\/webhook\/([a-f0-9-]{36})$/);if(!match)return null;
  if(request.method!=='POST')return jsonResponse({error:'یافت نشد.'},404);
  const secret=request.headers.get('X-Telegram-Bot-Api-Secret-Token')||'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(secret))return jsonResponse({error:'وب‌هوک معتبر نیست.'},403);
  const bot=await env.DB.prepare('SELECT * FROM telegram_bots WHERE id=?').bind(match[1]).first<Bot>();
  if(!bot||!secret||secret.length>256||await sha256(secret)!==bot.secret_hash)return jsonResponse({error:'وب‌هوک معتبر نیست.'},403);
  const update=await inputJson(request),message=update.channel_post||update.edited_channel_post;
  const member=update.my_chat_member;
  if(member?.chat?.type==='channel'&&String(member.new_chat_member?.user?.id)===bot.bot_number){const enabled=['administrator','creator'].includes(member.new_chat_member?.status);await env.DB.prepare('UPDATE telegram_sources SET enabled=?,error=? WHERE bot_id=? AND chat_number=? AND paused=0').bind(enabled?1:0,enabled?null:'ربات دیگر به این کانال دسترسی ندارد.',bot.id,String(member.chat.id)).run();}
  if(!message||message.chat?.type!=='channel'||!Number.isSafeInteger(message.chat.id)||!Number.isSafeInteger(message.message_id)||message.message_id<1||!Number.isSafeInteger(update.update_id))return jsonResponse({ok:true});
  const chat=String(message.chat.id),key='bot:'+bot.id+':'+chat;
  let source=await env.DB.prepare('SELECT * FROM telegram_sources WHERE source_key=?').bind(key).first<Source>();
  if(!source){
    const {n}=await env.DB.prepare("SELECT count(*) AS n FROM telegram_sources WHERE owner_id=? AND kind='bot'").bind(bot.owner_id).first<{n:number}>()||{n:0};
    if(n>=20)return jsonResponse({ok:true});
    const id=crypto.randomUUID();await env.DB.prepare("INSERT OR IGNORE INTO telegram_sources(id,source_key,kind,owner_id,bot_id,chat_number,username,title) SELECT ?,?,'bot',?,?,?,?,? WHERE (SELECT count(*) FROM telegram_sources WHERE owner_id=? AND kind='bot')<20").bind(id,key,bot.owner_id,bot.id,chat,typeof message.chat.username==='string'?message.chat.username.toLowerCase():null,String(message.chat.title||'کانال ربات').slice(0,120),bot.owner_id).run();
    source=await env.DB.prepare('SELECT * FROM telegram_sources WHERE source_key=?').bind(key).first<Source>();
    if(source){await env.DB.prepare('INSERT OR IGNORE INTO telegram_subscriptions(user_id,source_id) SELECT ?,? WHERE (SELECT count(*) FROM telegram_subscriptions WHERE user_id=?)<20').bind(bot.owner_id,source.id,bot.owner_id).run();if(!await env.DB.prepare('SELECT 1 FROM telegram_subscriptions WHERE user_id=? AND source_id=?').bind(bot.owner_id,source.id).first()){await env.DB.prepare('UPDATE telegram_sources SET paused=1 WHERE id=?').bind(source.id).run();return jsonResponse({ok:true});}}
  }
  if(!source||!source.enabled||source.paused)return jsonResponse({ok:true});
  const text=typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:'',media=!!(message.photo||message.video||message.document||message.audio||message.voice||message.animation||message.sticker||message.video_note);
  const date=Number(message.date)*1000,edited=Number(message.edit_date||message.date)*1000;
  if(!Number.isFinite(date)||!Number.isFinite(edited))return jsonResponse({ok:true});
  await storePosts(env,source.id,[{id:message.message_id,text:text.slice(0,8192),media,createdAt:date,updatedAt:edited,updateId:update.update_id}]);
  await env.DB.prepare('UPDATE telegram_sources SET last_checked=?,error=NULL,title=? WHERE id=?').bind(Date.now(),String(message.chat.title||source.title).slice(0,120),source.id).run();return jsonResponse({ok:true});
}
export async function handleTelegram(request:Request,env:Env,auth:JwtPayload):Promise<Response|null> {
  const path=new URL(request.url).pathname,userId=auth.userId;if(!path.startsWith('/api/telegram/'))return null;
  if(path==='/api/telegram/bot'){
    if(request.method==='GET'){const bot=await env.DB.prepare('SELECT id,username,state,created_at FROM telegram_bots WHERE owner_id=?').bind(userId).first();return jsonResponse({configured:!!env.TELEGRAM_KEY,bot});}
    check(await allowRequest(env,'telegram-bot',userId,10,3600_000),'تلاش‌های اتصال ربات زیاد است؛ بعداً تلاش کنید.',429);
    if(request.method==='POST')return connectBot(request,env,userId,await inputJson(request));
    if(request.method==='DELETE'){
      const bot=await env.DB.prepare('SELECT * FROM telegram_bots WHERE owner_id=?').bind(userId).first<Bot>();if(!bot)return jsonResponse({ok:true});
      check(bot.config_until<Date.now(),'تنظیم ربات در حال انجام است؛ کمی صبر کنید.',409);
      try{const token=await unseal(env,bot),info=await botApi(token,'getWebhookInfo');if(info?.url===bot.webhook_url)await botApi(token,'deleteWebhook',{drop_pending_updates:false});}catch{/* Revoking locally must still work when Telegram is unavailable. */}
      await env.DB.batch([env.DB.prepare('UPDATE telegram_sources SET enabled=0,error=? WHERE bot_id=?').bind('اتصال ربات قطع شده است؛ پست‌های ذخیره‌شده باقی مانده‌اند.',bot.id),env.DB.prepare('DELETE FROM telegram_bots WHERE id=? AND owner_id=?').bind(bot.id,userId)]);return jsonResponse({ok:true});
    }
  }
  if(path==='/api/telegram/sources'){
    if(request.method==='GET'){
      const {results:sources}=await env.DB.prepare(`SELECT s.*,t.last_read_id,(SELECT count(*) FROM telegram_posts p WHERE p.source_id=s.id AND p.message_id>t.last_read_id) AS unread_count FROM telegram_subscriptions t JOIN telegram_sources s ON s.id=t.source_id WHERE t.user_id=? AND (s.kind='public' OR s.owner_id=?) ORDER BY s.title,s.id`).bind(userId,userId).all<any>();
      const {results:available}=await env.DB.prepare("SELECT id,title,username FROM telegram_sources WHERE kind='bot' AND owner_id=? AND paused=1 AND bot_id IS NOT NULL").bind(userId).all();
      return jsonResponse({sources:sources.map(s=>({id:s.id,kind:s.kind,title:s.title,username:s.username,lastChecked:s.last_checked,error:s.error,unreadCount:s.unread_count,enabled:!!s.enabled})),available});
    }
    if(request.method==='POST'){
      check(await allowRequest(env,'telegram-add',userId,20,3600_000),'افزودن کانال زیاد است؛ بعداً تلاش کنید.',429);
      const body=await inputJson(request),count=await env.DB.prepare('SELECT count(*) AS n FROM telegram_subscriptions WHERE user_id=?').bind(userId).first<{n:number}>();check((count?.n||0)<20,'هر حساب می‌تواند حداکثر ۲۰ کانال دنبال کند.');
      let source:Source|null=null;
      if(typeof body.sourceId==='string'&&safeId(body.sourceId)){source=await env.DB.prepare("SELECT * FROM telegram_sources WHERE id=? AND kind='bot' AND owner_id=? AND bot_id IS NOT NULL").bind(body.sourceId,userId).first<Source>();check(source,'کانال ربات پیدا نشد.',404);const bot=await env.DB.prepare('SELECT * FROM telegram_bots WHERE id=? AND owner_id=?').bind(source!.bot_id,userId).first<Bot>();check(bot,'ربات دیگر متصل نیست.',409);const member=await botApi(await unseal(env,bot!),'getChatMember',{chat_id:source!.chat_number,user_id:Number(bot!.bot_number)});check(['administrator','creator'].includes(member?.status),'ابتدا ربات را دوباره به مدیران کانال اضافه کنید.',409);await env.DB.prepare('UPDATE telegram_sources SET paused=0,enabled=1,error=NULL WHERE id=?').bind(source!.id).run();}
      else {
        const username=publicChannel(body.channel);source=await env.DB.prepare('SELECT * FROM telegram_sources WHERE source_key=?').bind('public:'+username).first<Source>();
        if(!source){const global=await env.DB.prepare("SELECT count(*) AS n FROM telegram_sources WHERE kind='public'").first<{n:number}>();check((global?.n||0)<500,'ظرفیت کانال‌های عمومی این سرویس پر شده است.',409);const id=crypto.randomUUID();await env.DB.prepare("INSERT OR IGNORE INTO telegram_sources(id,source_key,kind,username,title) VALUES (?,?,'public',?,?)").bind(id,'public:'+username,username,'@'+username).run();source=await env.DB.prepare('SELECT * FROM telegram_sources WHERE source_key=?').bind('public:'+username).first<Source>();}
        if(source&&Date.now()-source.last_checked>5*60_000)try{await refreshPublic(env,source);}catch(error){await env.DB.prepare("DELETE FROM telegram_sources WHERE id=? AND NOT EXISTS(SELECT 1 FROM telegram_subscriptions WHERE source_id=?)").bind(source.id,source.id).run();throw error;}
      }
      check(source,'کانال پیدا نشد.',404);await env.DB.prepare('INSERT OR IGNORE INTO telegram_subscriptions(user_id,source_id) SELECT ?,? WHERE (SELECT count(*) FROM telegram_subscriptions WHERE user_id=?)<20').bind(userId,source!.id,userId).run();check(await env.DB.prepare('SELECT 1 FROM telegram_subscriptions WHERE user_id=? AND source_id=?').bind(userId,source!.id).first(),'ظرفیت ۲۰ کانال این حساب پر شده است.',409);return jsonResponse({id:source!.id},201);
    }
  }
  const route=path.match(/^\/api\/telegram\/sources\/([a-f0-9-]{36})(?:\/(posts|refresh|read))?$/);
  if(!route)return jsonResponse({error:'یافت نشد.'},404);
  const source=await env.DB.prepare("SELECT s.* FROM telegram_sources s JOIN telegram_subscriptions t ON t.source_id=s.id AND t.user_id=? WHERE s.id=? AND (s.kind='public' OR s.owner_id=?)").bind(userId,route[1],userId).first<Source>();check(source,'کانال پیدا نشد.',404);
  if(request.method==='DELETE'&&!route[2]){await env.DB.batch([env.DB.prepare('DELETE FROM telegram_subscriptions WHERE user_id=? AND source_id=?').bind(userId,source!.id),...(source!.kind==='bot'?[env.DB.prepare('UPDATE telegram_sources SET paused=1 WHERE id=? AND owner_id=?').bind(source!.id,userId)]:[])]);return jsonResponse({ok:true});}
  if(route[2]==='refresh'&&request.method==='POST'){check(source!.kind==='public','کانال ربات پست‌های تازه را خودکار دریافت می‌کند.');check(await allowRequest(env,'telegram-refresh',userId,12,3600_000),'درخواست‌های دریافت زیاد است؛ بعداً تلاش کنید.',429);if(Date.now()-source!.last_checked>60_000)await refreshPublic(env,source!);return jsonResponse({ok:true});}
  if(route[2]==='read'&&request.method==='POST'){const body=await inputJson(request);check(Number.isSafeInteger(body.messageId)&&body.messageId>0,'شمارهٔ پست معتبر نیست.');await env.DB.prepare('UPDATE telegram_subscriptions SET last_read_id=MAX(last_read_id,?) WHERE user_id=? AND source_id=?').bind(body.messageId,userId,source!.id).run();return jsonResponse({ok:true});}
  if(route[2]==='posts'&&request.method==='GET'){
    const parameter=new URL(request.url).searchParams.get('before'),before=parameter?Number(parameter):Number.MAX_SAFE_INTEGER;check(Number.isSafeInteger(before)&&before>0,'شمارهٔ صفحه معتبر نیست.');
    const {results}=await env.DB.prepare('SELECT message_id AS id,text,media,created_at AS createdAt,updated_at AS updatedAt FROM telegram_posts WHERE source_id=? AND message_id<? ORDER BY message_id DESC LIMIT 25').bind(source!.id,before).all<any>();
    const link=source!.username?'https://t.me/'+encodeURIComponent(source!.username):'https://t.me/c/'+String(source!.chat_number).replace(/^-100/,'');
    return jsonResponse({posts:results.map(p=>({...p,media:!!p.media,url:link+'/'+p.id})),hasMore:results.length===25});
  }
  return jsonResponse({error:'یافت نشد.'},404);
}
