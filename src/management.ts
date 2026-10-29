import { Env, JwtPayload } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { APP_VERSION } from './version.js';

export async function serviceAdmin(env:Env,id:string) {
  if(!await env.DB.prepare('SELECT 1 FROM service_admins WHERE slot=1 AND user_id=?').bind(id).first())throw new InputError('این بخش فقط برای مدیر سرویس است.',403);
}
export async function audit(env:Env,actor:string,action:string,target:string|null=null) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO service_audit VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,target,Date.now()),
    env.DB.prepare('DELETE FROM service_audit WHERE id IN (SELECT id FROM service_audit ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 1000)'),
  ]);
}
export async function handleManagement(request:Request,env:Env,auth:JwtPayload) {
  const url=new URL(request.url),path=url.pathname;
  if(!['/api/service/overview','/api/service/users','/api/service/audit'].includes(path))return null;
  await serviceAdmin(env,auth.userId);
  if(path==='/api/service/overview'&&request.method==='GET'){
    const row=await env.DB.prepare(`SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM service_user_state WHERE disabled_at IS NOT NULL) AS disabledUsers,
      (SELECT count(*) FROM chats) AS chats,
      (SELECT count(*) FROM messages) AS indexedMessages,
      (SELECT count(*) FROM user_sessions s WHERE revoked_at IS NULL AND expires_at>? AND NOT EXISTS(SELECT 1 FROM service_user_state us WHERE us.user_id=s.user_id AND us.disabled_at IS NOT NULL)) AS sessions,
      (SELECT count(*) FROM abuse_reports WHERE status='open') AS openReports,
      (SELECT count(*) FROM telegram_posts) AS telegramPosts,
      (SELECT COALESCE(sum(length(CAST(text AS BLOB))),0) FROM messages) AS indexedTextBytes`).bind(Date.now()).first();
    return jsonResponse({version:APP_VERSION,database:true,counts:row,limits:{groupMembers:100,telegramChannelsPerUser:20,cachedTelegramPostsPerChannel:500,uploadSupported:false},encryption:'transport-only',federation:'discovery-only',backupAvailable:false});
  }
  if(path==='/api/service/audit'&&request.method==='GET'){
    const {results}=await env.DB.prepare('SELECT a.action,a.created_at AS createdAt,u.username AS actor,t.username AS target FROM service_audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users t ON t.id=a.target_id ORDER BY a.created_at DESC,a.id DESC LIMIT 100').all();return jsonResponse(results);
  }
  if(path==='/api/service/users'&&request.method==='GET'){
    const after=url.searchParams.get('after')||'',query=(url.searchParams.get('q')||'').trim().toLowerCase();
    if(after.length>100||query.length>100)throw new InputError('عبارت جستجو طولانی است.');
    const {results}=await env.DB.prepare(`SELECT u.id,u.username,u.display_name AS displayName,u.created_at AS createdAt,st.disabled_at AS disabledAt,COALESCE(st.reason,'') AS reason,EXISTS(SELECT 1 FROM service_admins a WHERE a.user_id=u.id) AS isAdmin FROM users u LEFT JOIN service_user_state st ON st.user_id=u.id WHERE u.id>? AND (?='' OR instr(u.username,?)>0 OR instr(u.display_name,?)>0) ORDER BY u.id LIMIT 31`).bind(after,query,query,query).all<any>();
    return jsonResponse({users:results.slice(0,30),next:results.length>30?results[29].id:null});
  }
  if(path==='/api/service/users'&&request.method==='PATCH'){
    if(!await allowRequest(env,'admin-user-action',auth.userId,60,3600_000))throw new InputError('تغییرات زیاد است؛ بعداً دوباره تلاش کنید.',429);
    const body=await inputJson(request);
    if(typeof body.userId!=='string'||body.userId.length>100||!['disable','enable'].includes(body.action)||typeof body.reason!=='string'||body.reason.length>200)throw new InputError('کاربر، اقدام یا توضیح معتبر نیست.');
    if(body.userId===auth.userId||await env.DB.prepare('SELECT 1 FROM service_admins WHERE user_id=?').bind(body.userId).first())throw new InputError('حساب مدیر سرویس را نمی‌توان غیرفعال کرد.',409);
    if(!await env.DB.prepare('SELECT 1 FROM users WHERE id=?').bind(body.userId).first())throw new InputError('کاربر پیدا نشد.',404);
    const disabled=body.action==='disable',now=Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO service_user_state VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET disabled_at=excluded.disabled_at,reason=excluded.reason').bind(body.userId,disabled?now:null,body.reason.trim()),
      ...(disabled?[
        env.DB.prepare('INSERT INTO session_policy VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET legacy_disabled=1').bind(body.userId),
        env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now,body.userId),
      ]:[]),
      env.DB.prepare('INSERT INTO service_audit VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),auth.userId,disabled?'disable-user':'enable-user',body.userId,now),
      env.DB.prepare('DELETE FROM service_audit WHERE id IN (SELECT id FROM service_audit ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 1000)'),
    ]);
    // Revocation above is atomic and is checked on every frame and broadcast.
    // Bounded socket-close notifications are a courtesy, not the access boundary.
    if(disabled){const {results}=await env.DB.prepare('SELECT chat_id FROM chat_members WHERE user_id=? ORDER BY chat_id LIMIT 100').bind(body.userId).all<{chat_id:string}>();for(let start=0;start<results.length;start+=20)await Promise.allSettled(results.slice(start,start+20).map(row=>env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(row.chat_id)).fetch('https://internal/revoke-user',{method:'POST',body:JSON.stringify({userId:body.userId})})));}
    return jsonResponse({ok:true});
  }
  return jsonResponse({error:'یافت نشد.'},404);
}
