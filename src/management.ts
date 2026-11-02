import { Env, JwtPayload } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { deleteChat, refreshRoom, validId } from './access.js';
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
  if(!['/api/service/overview','/api/service/users','/api/service/audit','/api/service/chats','/api/service/messages'].includes(path))return null;
  await serviceAdmin(env,auth.userId);
  if(path==='/api/service/overview'&&request.method==='GET'){
    const row=await env.DB.prepare(`SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM service_user_state WHERE disabled_at IS NOT NULL) AS disabledUsers,
      (SELECT count(*) FROM chats) AS chats,
      (SELECT count(*) FROM chats c WHERE c.type='group' AND NOT EXISTS(SELECT 1 FROM broadcast_channels b WHERE b.chat_id=c.id)) AS groups,
      (SELECT count(*) FROM broadcast_channels) AS channels,
      (SELECT count(*) FROM chat_moderation) AS suspendedChats,
      (SELECT count(*) FROM messages) AS indexedMessages,
      (SELECT count(*) FROM user_sessions s WHERE revoked_at IS NULL AND expires_at>? AND NOT EXISTS(SELECT 1 FROM service_user_state us WHERE us.user_id=s.user_id AND us.disabled_at IS NOT NULL)) AS sessions,
      (SELECT count(*) FROM abuse_reports WHERE status='open') AS openReports,
      (SELECT count(*) FROM telegram_posts) AS telegramPosts,
      (SELECT COALESCE(sum(length(CAST(text AS BLOB))),0) FROM messages) AS indexedTextBytes`).bind(Date.now()).all();
    const databaseBytes=Number.isSafeInteger(row.meta.size_after)&&row.meta.size_after>0?row.meta.size_after:null;
    return jsonResponse({version:APP_VERSION,database:true,counts:row.results[0],storage:{databaseBytes,warning:databaseBytes!==null&&databaseBytes>=400*1024*1024,accountQuotaKnown:false},limits:{groupMembers:100,telegramChannelsPerUser:20,cachedTelegramPostsPerChannel:500,uploadSupported:true,fileBytes:32*1024*1024,channelMembers:10000,backupBytes:32*1024*1024,backupRooms:200},encryption:'legacy-transport;experimental-mls',federation:'automatic-signed',backupAvailable:true});
  }
  if(path==='/api/service/audit'&&request.method==='GET'){
    const {results}=await env.DB.prepare('SELECT a.action,a.created_at AS createdAt,u.username AS actor,t.username AS target FROM service_audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users t ON t.id=a.target_id ORDER BY a.created_at DESC,a.id DESC LIMIT 100').all();return jsonResponse(results);
  }
  // Direct messages are never listed: moderation acts on them only through a report.
  if(path==='/api/service/chats'&&request.method==='GET'){
    const after=url.searchParams.get('after')||'',query=(url.searchParams.get('q')||'').trim().toLowerCase(),kind=url.searchParams.get('kind')==='channel'?'channel':'group';
    if(after.length>100||query.length>100)throw new InputError('عبارت جستجو طولانی است.');
    const {results}=await env.DB.prepare(`SELECT c.id,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,bc.visibility,bc.handle,(SELECT count(*) FROM chat_members m WHERE m.chat_id=c.id) AS members,(SELECT count(*) FROM messages m WHERE m.chat_id=c.id) AS messages,o.username AS owner,mod.suspended_at AS suspendedAt,COALESCE(mod.reason,'') AS reason,(SELECT count(*) FROM abuse_reports r WHERE r.chat_id=c.id AND r.status='open') AS openReports FROM chats c LEFT JOIN broadcast_channels bc ON bc.chat_id=c.id LEFT JOIN group_roles g ON g.chat_id=c.id AND g.role='owner' LEFT JOIN users o ON o.id=g.user_id LEFT JOIN chat_moderation mod ON mod.chat_id=c.id WHERE c.type='group' AND (bc.chat_id IS NOT NULL)=? AND c.id>? AND (?='' OR instr(lower(c.title),?)>0 OR instr(lower(COALESCE(bc.handle,'')),?)>0) ORDER BY c.id LIMIT 31`).bind(kind==='channel'?1:0,after,query,query,query).all<any>();
    return jsonResponse({chats:results.slice(0,30),next:results.length>30?results[29].id:null});
  }
  if(path==='/api/service/chats'&&request.method==='PATCH'){
    if(!await allowRequest(env,'admin-user-action',auth.userId,60,3600_000))throw new InputError('تغییرات زیاد است؛ بعداً دوباره تلاش کنید.',429);
    const body=await inputJson(request);
    if(!validId(body.chatId)||!['suspend','restore','delete'].includes(body.action)||typeof body.reason!=='string'||body.reason.length>200)throw new InputError('گفتگو، اقدام یا توضیح معتبر نیست.');
    if(!await env.DB.prepare("SELECT 1 FROM chats WHERE id=? AND type='group'").bind(body.chatId).first())throw new InputError('گروه یا کانال پیدا نشد.',404);
    if(body.action==='delete')await deleteChat(env,body.chatId);
    else if(body.action==='suspend'){await env.DB.prepare('INSERT INTO chat_moderation VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET suspended_at=excluded.suspended_at,reason=excluded.reason').bind(body.chatId,Date.now(),body.reason.trim()).run();await refreshRoom(env,body.chatId);}
    else await env.DB.prepare('DELETE FROM chat_moderation WHERE chat_id=?').bind(body.chatId).run();
    await audit(env,auth.userId,body.action+'-chat');
    return jsonResponse({ok:true});
  }
  if(path==='/api/service/messages'&&request.method==='POST'){
    const body=await inputJson(request);
    if(!validId(body.chatId)||!validId(body.messageId))throw new InputError('پیام معتبر نیست.');
    const response=await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(body.chatId)).fetch('https://internal/moderation-delete',{method:'POST',body:JSON.stringify({chatId:body.chatId,messageId:body.messageId})});
    if(!response.ok)throw new InputError((await response.json<{error?:string}>()).error||'حذف پیام انجام نشد.',response.status);
    await audit(env,auth.userId,'delete-message');
    return jsonResponse({ok:true});
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
