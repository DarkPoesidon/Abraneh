import { Env, JwtPayload } from './types.js';
import { InputError,inputJson,jsonResponse } from './http.js';
import { serviceAdmin } from './management.js';
import { verifyPassword } from './auth.js';
import { enforceSecondFactor } from './security.js';
import { tokenHash } from './access.js';
import { allowRequest } from './limits.js';
import { APP_VERSION } from './version.js';
import { ROOM_BACKUP_TABLES } from './room-backup.js';

const EXCLUDED=new Set(['service_control','service_operations','service_restore','user_sessions','session_security','security_challenges','rate_limits','schema_migrations','push_subscriptions','password_resets']);
const PAUSE=15*60_000,DRAIN=20_000;
// shortcut: work still running DRAIN after the pause can miss the snapshot; count running work outside D1 if that ever happens.
const drained=(pausedUntil:number)=>Date.now()>=pausedUntil-PAUSE+DRAIN;
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_]*$/.test(value);
async function tables(env:Env){const {results}=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1)!='_' ORDER BY name").all<{name:string}>();return results.map(row=>row.name).filter(name=>valid(name)&&!EXCLUDED.has(name)&&name!=='wihm_installation');}
async function snapshot(env:Env,id:string){
  const state=await env.DB.prepare('SELECT paused_until FROM service_control WHERE id=1 AND snapshot_id=? AND paused_until>?').bind(id,Date.now()).first<any>();
  if(!state)throw new InputError('زمان پشتیبان تمام شده است؛ فایل ناقص را استفاده نکنید و دوباره شروع کنید.',409);
  if(!drained(state.paused_until))throw new InputError('عملیات قبلی هنوز پایان نیافته است؛ کمی صبر کنید.',409);
}
export async function handleBackup(request:Request,env:Env,auth:JwtPayload) {
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/service/backup/'))return null;
  await serviceAdmin(env,auth.userId);
  if(path.endsWith('/start')&&request.method==='POST'){
    if(!await allowRequest(env,'backup-start',auth.userId,5,3600_000))throw new InputError('تلاش‌های پشتیبان زیاد است؛ بعداً تلاش کنید.',429);
    const body=await inputJson(request),user=await env.DB.prepare('SELECT salt,password_hash FROM users WHERE id=?').bind(auth.userId).first<any>();
    if(typeof body.password!=='string'||!await verifyPassword(body.password,user.salt,user.password_hash))throw new InputError('رمز فعلی حساب درست نیست.',403);
    await enforceSecondFactor(env,auth.userId,body,403);
    const id=crypto.randomUUID(),expires=Date.now()+PAUSE;
    const changed=await env.DB.prepare('INSERT INTO service_control VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,paused_until=excluded.paused_until WHERE service_control.paused_until<=?').bind(id,expires,Date.now()).run();
    if(!changed.meta.changes)throw new InputError('پشتیبان دیگری در جریان است.',409);
    return jsonResponse({id,expires});
  }
  const id=url.searchParams.get('id')||'';
  if(path.endsWith('/end')&&request.method==='POST'){
    await snapshot(env,id);await env.DB.prepare('DELETE FROM service_control WHERE snapshot_id=?').bind(id).run();return jsonResponse({ok:true});
  }
  if(path.endsWith('/cancel')&&request.method==='POST'){await env.DB.prepare('DELETE FROM service_control WHERE snapshot_id=?').bind(id).run();return jsonResponse({ok:true});}
  if(path.endsWith('/status')){
    const state=await env.DB.prepare('SELECT paused_until FROM service_control WHERE snapshot_id=? AND paused_until>?').bind(id,Date.now()).first<any>();
    return jsonResponse({active:!!state,ready:!!state&&drained(state.paused_until),expires:state?.paused_until||0});
  }
  await snapshot(env,id);
  if(path.endsWith('/manifest')){
    const {results:rooms}=await env.DB.prepare('SELECT id FROM chats ORDER BY id LIMIT 201').all<{id:string}>();
    // shortcut: 200 rooms and 32 MiB per backup; use streamed manifests before increasing these limits.
    if(rooms.length>200)throw new InputError('این نسخه پشتیبان خودکار تا ۲۰۰ گفتگو را پشتیبانی می‌کند؛ داده‌ای حذف نشده است.',413);
    const secrets:Record<string,string>={};for(const key of ['JWT_SECRET','TELEGRAM_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY'] as const)if(env[key])secrets[key]=env[key]!;
    return jsonResponse({format:1,appVersion:APP_VERSION,createdAt:Date.now(),origin:url.origin,tables:await tables(env),rooms:rooms.map(row=>row.id),roomTables:ROOM_BACKUP_TABLES,secrets});
  }
  if(path.endsWith('/page')){
    const table=url.searchParams.get('table'),offset=Number(url.searchParams.get('offset')||0),room=url.searchParams.get('room');
    if(!valid(table)||!Number.isSafeInteger(offset)||offset<0)throw new InputError('صفحهٔ پشتیبان معتبر نیست.');
    if(room){
      if(room.length>100||!ROOM_BACKUP_TABLES.includes(table)||!await env.DB.prepare('SELECT 1 FROM chats WHERE id=?').bind(room).first())throw new InputError('گفتگو پیدا نشد.',404);
      const response=await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room)).fetch('https://internal/backup-page',{method:'POST',body:JSON.stringify({table,offset})});if(!response.ok)throw new InputError('دریافت اطلاعات گفتگو کامل نشد.',502);return jsonResponse(await response.json());
    }
    if(!(await tables(env)).includes(table))throw new InputError('جدول پشتیبان معتبر نیست.');
    const {results:info}=await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{name:string}>(),names=info.map(row=>row.name);
    const [{results},count]=await Promise.all([env.DB.prepare(`SELECT * FROM "${table}" ORDER BY rowid LIMIT 32 OFFSET ?`).bind(offset).all<any>(),env.DB.prepare(`SELECT count(*) AS n FROM "${table}"`).first<{n:number}>()]);
    return jsonResponse({columns:names,rows:results.map(row=>names.map(name=>row[name])),scanned:results.length,total:count!.n});
  }
  return jsonResponse({error:'یافت نشد.'},404);
}
export async function publicRestore(request:Request,env:Env) {
  const path=new URL(request.url).pathname;if(!path.startsWith('/api/_restore/'))return null;
  if(request.method!=='POST'||!env.RESTORE_TOKEN||await tokenHash(request.headers.get('Authorization')||'')!==await tokenHash('Bearer '+env.RESTORE_TOKEN))throw new InputError('دسترسی بازیابی مجاز نیست.',403);
  const body=await inputJson(request,524288),marker=await env.DB.prepare("SELECT digest FROM service_restore WHERE id=1 AND state='importing'").first<{digest:string}>();
  if(!marker||body.digest!==marker.digest)throw new InputError('نشانگر بازیابی معتبر نیست.',409);
  if(path.endsWith('/room')){
    if(typeof body.chatId!=='string'||!await env.DB.prepare('SELECT 1 FROM chats WHERE id=?').bind(body.chatId).first())throw new InputError('گفتگوی بازیابی پیدا نشد.',404);
    const response=await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(body.chatId)).fetch('https://internal/restore-table',{method:'POST',body:JSON.stringify(body)});return jsonResponse(await response.json(),response.status);
  }
  if(path.endsWith('/finish')){
    const allowed=await tables(env);if(!body.tables||JSON.stringify(Object.keys(body.tables).sort())!==JSON.stringify(allowed.sort()))throw new InputError('فهرست جدول‌های بازیابی کامل نیست.');
    const results:{name:string;n:number}[]=[];
    for(let start=0;start<allowed.length;start+=10){const page=await env.DB.batch<{name:string;n:number}>(allowed.slice(start,start+10).map(table=>env.DB.prepare(`SELECT ? AS name,count(*) AS n FROM "${table}"`).bind(table)));for(const table of page)results.push(...table.results);}
    if(results.some(row=>body.tables[row.name]!==row.n))throw new InputError('تعداد داده‌های بازیابی یکسان نیست.',409);
    const {results:rooms}=await env.DB.prepare('SELECT id FROM chats ORDER BY id').all<{id:string}>();
    if(!Array.isArray(body.rooms)||rooms.length>200||JSON.stringify(body.rooms.map((r:any)=>r.chatId).sort())!==JSON.stringify(rooms.map(r=>r.id).sort()))throw new InputError('گفتگوهای بازیابی کامل نیستند.');
    for(const room of body.rooms){const response=await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.chatId)).fetch('https://internal/restore-check',{method:'POST',body:JSON.stringify(room.counts)});if(!response.ok)throw new InputError('بررسی تاریخچهٔ بازیابی کامل نشد.',409);}
    await env.DB.batch([
      env.DB.prepare('DELETE FROM user_sessions'),env.DB.prepare('DELETE FROM session_security'),env.DB.prepare('DELETE FROM security_challenges'),env.DB.prepare('DELETE FROM push_subscriptions'),
      env.DB.prepare('INSERT INTO session_policy SELECT id,1 FROM users WHERE true ON CONFLICT(user_id) DO UPDATE SET legacy_disabled=1'),
      env.DB.prepare("DELETE FROM site_settings WHERE key LIKE 'discovery_%' OR key LIKE 'federation_%' OR key LIKE 'secure_%' OR key IN ('update_push','server_origin','call_turn')"),
      env.DB.prepare("INSERT INTO site_settings(key,value) VALUES ('discovery_enabled','0'),('secure_enabled','0')"),
      env.DB.prepare('UPDATE secure_devices SET revoked_at=COALESCE(revoked_at,?)').bind(Date.now()),
      env.DB.prepare('DELETE FROM secure_device_lists'),
      env.DB.prepare('DELETE FROM channel_outbox'),env.DB.prepare('DELETE FROM channel_webhooks'),env.DB.prepare('DELETE FROM channel_tokens'),env.DB.prepare('DELETE FROM security_recovery'),
      env.DB.prepare("UPDATE telegram_bots SET state='disconnected'"),env.DB.prepare("UPDATE telegram_sources SET enabled=0 WHERE kind='bot'"),
      env.DB.prepare("UPDATE service_restore SET state='complete' WHERE id=1 AND digest=? AND state='importing'").bind(marker.digest),
    ]);
    return jsonResponse({ok:true});
  }
  throw new InputError('مسیر بازیابی پیدا نشد.',404);
}
