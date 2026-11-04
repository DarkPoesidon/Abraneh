import { serverOrigin } from './server-identity.js';
import { Env, JwtPayload } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { address, serverHost } from './discovery.js';
import { serviceAdmin, audit } from './management.js';
import { allowRequest } from './limits.js';
import { sendSecurePush } from './push.js';
import { withOperation } from './maintenance.js';

const encode=new TextEncoder(),bad=(message='درخواست گفتگوی امن معتبر نیست.',status=400):never=>{throw new InputError(message,status);};
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
function bytes(value:unknown,length?:number):Uint8Array {
  if(typeof value!=='string'||value.length>48000||!value.length||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return bad();
  let result:Uint8Array;try{result=Uint8Array.from(atob(value),c=>c.charCodeAt(0));}catch{return bad();}
  if(b64(result)!==value||length!==undefined&&result.length!==length)return bad();return result;
}
const uuid=(value:unknown):string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)?value:bad();
const fullAddress=(value:unknown)=>{const parsed=address(value);const normalized=parsed.username+'@'+parsed.host;if(normalized!==value)return bad();return parsed;};
const digest=async(value:string)=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encode.encode(value))));
async function verify(key:string,signature:string,data:string) {
  try{return await crypto.subtle.verify('Ed25519',await crypto.subtle.importKey('raw',bytes(key,32),'Ed25519',false,['verify']),bytes(signature,64),encode.encode(data));}catch{return false;}
}
export interface SecureEnvelope {id:string;thread:string;from:string;fromDevice:string;to:string;toDevice:string;kind:'welcome'|'message'|'control';payload:string;senderKey:string;signature:string}
export const envelopeData=(e:SecureEnvelope)=>JSON.stringify(['wihm-mls/1',e.id,e.thread,e.from,e.fromDevice,e.to,e.toDevice,e.kind,e.payload,e.senderKey]);
export const deviceData=(who:string,device:string,keyPackage:string)=>JSON.stringify(['wihm-device/1',who,device,keyPackage]);
export const listData=(who:string,list:any)=>JSON.stringify(['wihm-device-list/1',who,list.version,list.devices.map((d:any)=>[d.device,d.key]),list.signer]);
async function storedList(env:Env,username:string) {
  const row=await env.DB.prepare('SELECT l.list FROM secure_device_lists l JOIN users u ON u.id=l.user_id WHERE u.username=?').bind(username).first<{list:string}>();
  return row?JSON.parse(row.list):null;
}
async function envelope(value:any):Promise<SecureEnvelope> {
  const fields=['id','thread','from','fromDevice','to','toDevice','kind','payload','senderKey','signature'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!(k in value)))return bad();
  uuid(value.id);uuid(value.thread);uuid(value.fromDevice);uuid(value.toDevice);fullAddress(value.from);fullAddress(value.to);
  const payload=bytes(value.payload);bytes(value.senderKey,32);bytes(value.signature,64);
  if(!['welcome','message','control'].includes(value.kind)||payload.length<8)return bad();
  if(payload[0]!==0||payload[1]!==1||payload[2]!==0||payload[3]!==({message:2,control:2,welcome:3} as Record<string,number>)[value.kind])return bad('فقط پیام خصوصی یا دعوت MLS پذیرفته می‌شود.');
  if(!await verify(value.senderKey,value.signature,envelopeData(value)))return bad('امضای دستگاه معتبر نیست.',403);
  return Object.fromEntries(fields.map(k=>[k,value[k]])) as unknown as SecureEnvelope;
}
interface Settings {enabled:boolean;origin:string;peers:Record<string,string>;publicKey:string;privateKey?:JsonWebKey}
async function config(env:Env):Promise<Settings> {
  const {results}=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'secure_%'").all<{key:string;value:string}>();
  const values=Object.fromEntries(results.map(r=>[r.key,r.value]));let peers={},keys:any={};
  try{peers=JSON.parse(values.secure_peers||'{}');keys=JSON.parse(values.secure_server_keys||'{}');}catch{}
  return {enabled:values.secure_enabled!=='0',origin:values.secure_origin||'',peers,publicKey:keys.publicKey||'',privateKey:keys.privateKey};
}
function origin(value:unknown):string {
  if(typeof value!=='string')return bad();let parsed:URL;try{parsed=new URL(value);}catch{return bad();}
  serverHost(parsed.hostname);if(parsed.protocol!=='https:'||parsed.origin!==value||parsed.port||parsed.username||parsed.password)return bad('نشانی سرور باید آدرس اصلی HTTPS بدون مسیر یا پورت باشد.');return parsed.origin;
}
async function saveSetting(env:Env,key:string,value:string) {return env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,value).run();}
async function serverKeys(env:Env,fallback?:string) {
  if(fallback){const canonical=await serverOrigin(env,fallback);await env.DB.prepare("INSERT OR IGNORE INTO site_settings(key,value) VALUES ('secure_origin',?)").bind(canonical).run();}
  const settings=await config(env);if(settings.privateKey&&settings.publicKey)return settings;
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
  const privateKey=await crypto.subtle.exportKey('jwk',pair.privateKey),publicKey=b64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey) as ArrayBuffer));
  // INSERT OR IGNORE prevents two first-time requests from creating mismatched keys.
  await env.DB.prepare("INSERT OR IGNORE INTO site_settings(key,value) VALUES ('secure_server_keys',?)").bind(JSON.stringify({privateKey,publicKey})).run();
  return config(env);
}
async function activeDevices(env:Env,username:string) {
  const {results}=await env.DB.prepare(`SELECT d.device_id AS device,d.identity_key AS identityKey,d.key_package AS keyPackage,d.signature,d.created_at AS createdAt,(SELECT count(*) FROM secure_prekeys p WHERE p.user_id=d.user_id AND p.device_id=d.device_id AND p.claimed_at IS NULL AND p.created_at>?) AS available FROM secure_devices d JOIN users u ON u.id=d.user_id WHERE u.username=? AND d.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=u.id AND s.disabled_at IS NOT NULL) ORDER BY d.created_at,d.device_id LIMIT 10`).bind(Date.now()-29*86400000,username).all();return results;
}
async function claimDevices(env:Env,username:string) {
  const devices:any[]=await activeDevices(env,username),results=[];
  for(const device of devices){
    const claimed=await env.DB.prepare(`UPDATE secure_prekeys SET claimed_at=? WHERE rowid=(SELECT p.rowid FROM secure_prekeys p JOIN users u ON u.id=p.user_id WHERE u.username=? AND p.device_id=? AND p.claimed_at IS NULL AND p.created_at>? ORDER BY p.rowid LIMIT 1) AND claimed_at IS NULL RETURNING key_package AS keyPackage,signature`).bind(Date.now(),username,device.device,Date.now()-29*86400000).first<{keyPackage:string;signature:string}>();
    if(claimed)results.push({...device,...claimed});
  }
  return results;
}
const requestData=(source:string,target:string,path:string,time:string,nonce:string,hash:string)=>JSON.stringify(['wihm-federation/1',source,target,'POST',path,time,nonce,hash]);
async function peerKey(env:Env,host:string,settings:Settings) {
  serverHost(host);if(settings.peers[host])return settings.peers[host];
  const known=await env.DB.prepare('SELECT public_key FROM secure_peer_keys WHERE host=?').bind(host).first<{public_key:string}>();if(known)return known.public_key;
  if(!await allowRequest(env,'federation-first-contact','all',60,60000))return bad('ارتباط با سرورهای تازه زیاد است؛ دوباره تلاش کنید.',429);
  if((await env.DB.prepare('SELECT count(*) AS n FROM secure_peer_keys').first<{n:number}>())!.n>=2000)return bad('ظرفیت سرورهای شناخته‌شده پر است.',503);
  const response=await fetch('https://'+host+'/api/federation/identity',{redirect:'manual',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
  if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return bad('مقصد باید نسخهٔ جدید پیام‌رسان را نصب کند؛ دریافت هویت سرور کامل نشد.',502);
  const data=await inputJson(new Request('https://identity.internal',{method:'POST',body:response.body}),6000);
  if(data.protocol!=='wihm-federation/1'||data.origin!=='https://'+host||data.enabled!==true)return bad('هویت یا امکان ارتباط سرور مقصد معتبر نیست.',502);bytes(data.publicKey,32);
  await env.DB.prepare('INSERT OR IGNORE INTO secure_peer_keys VALUES (?,?,?)').bind(host,data.publicKey,Date.now()).run();
  const pinned=await env.DB.prepare('SELECT public_key FROM secure_peer_keys WHERE host=?').bind(host).first<{public_key:string}>();if(pinned?.public_key!==data.publicKey)return bad('کلید سرور مقصد تغییر کرده است؛ تأیید دوباره لازم است.',409);return pinned!.public_key;
}
async function signedFetch(env:Env,settings:Settings,peer:string,path:string,body:unknown) {
  const target='https://'+serverHost(peer);if(!settings.enabled||!settings.privateKey)return bad('ارتباط سرور در دسترس نیست.',403);await peerKey(env,peer,settings);
  const text=JSON.stringify(body),time=String(Date.now()),nonce=crypto.randomUUID();
  const signature=b64(new Uint8Array(await crypto.subtle.sign('Ed25519',await crypto.subtle.importKey('jwk',settings.privateKey,'Ed25519',false,['sign']),encode.encode(requestData(settings.origin,target,path,time,nonce,await digest(text))))));
  const response=await fetch(target+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','X-WIHM-Origin':settings.origin,'X-WIHM-Time':time,'X-WIHM-Nonce':nonce,'X-WIHM-Signature':signature},body:text,signal:AbortSignal.timeout(8000)});
  if(!response.ok||response.status>=300||!response.headers.get('content-type')?.includes('application/json'))return bad('سرور مقصد درخواست را نپذیرفت.',502);
  const data=await inputJson(new Request('https://response.internal',{method:'POST',body:response.body}));return data;
}
async function deliver(env:Env,e:SecureEnvelope) {
  const target=fullAddress(e.to),sender=fullAddress(e.from),user=await env.DB.prepare(`SELECT u.id FROM users u WHERE u.username=? AND EXISTS(SELECT 1 FROM secure_devices d WHERE d.user_id=u.id AND d.device_id=? AND d.revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=u.id AND s.disabled_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM secure_blocks b WHERE b.user_id=u.id AND b.address=?) AND NOT EXISTS(SELECT 1 FROM blocked_users b JOIN users other ON other.id=b.blocked_id WHERE b.blocker_id=u.id AND other.username=? AND ?=?)`).bind(target.username,e.toDevice,e.from,sender.username,sender.host,target.host).first<{id:string}>();
  if(!user)return bad('مقصد در دسترس نیست یا پیام را نمی‌پذیرد.',404);
  const text=JSON.stringify(e),hash=await digest(text);
  const inserted=await env.DB.prepare('INSERT OR IGNORE INTO secure_events(id,owner_id,device_id,envelope,digest,created_at,notified_at) VALUES (?,?,?,?,?,?,?)').bind(e.id,user.id,e.toDevice,text,hash,Date.now(),e.kind==='control'?Date.now():null).run();
  const row=await env.DB.prepare('SELECT digest FROM secure_events WHERE id=?').bind(e.id).first<{digest:string}>();if(row?.digest!==hash)return bad('شناسهٔ پیام قبلاً استفاده شده است.',409);
  return {ownerId:user.id,fresh:!!inserted.meta.changes};
}
async function notifySecure(env:Env,ownerId='',thread=''){
  const pending=await env.DB.prepare("SELECT owner_id,json_extract(envelope,'$.thread') AS thread,max(sequence) AS sequence,max(push_cursor) AS push_cursor FROM secure_events WHERE notified_at IS NULL AND push_next_attempt<=? AND (?='' OR owner_id=?) AND (?='' OR json_extract(envelope,'$.thread')=?) GROUP BY owner_id,json_extract(envelope,'$.thread') ORDER BY min(sequence) LIMIT 1").bind(Date.now(),ownerId,ownerId,thread,thread).first<{owner_id:string;thread:string;sequence:number;push_cursor:string}>();
  if(!pending)return;
  try{const next=await sendSecurePush(env,pending.owner_id,pending.thread,pending.push_cursor);await env.DB.prepare("UPDATE secure_events SET push_cursor=?,notified_at=? WHERE owner_id=? AND json_extract(envelope,'$.thread')=? AND sequence<=? AND notified_at IS NULL").bind(next||'',next?null:Date.now(),pending.owner_id,pending.thread,pending.sequence).run();}
  catch{await env.DB.prepare("UPDATE secure_events SET push_next_attempt=? WHERE owner_id=? AND json_extract(envelope,'$.thread')=? AND sequence<=? AND notified_at IS NULL").bind(Date.now()+60000,pending.owner_id,pending.thread,pending.sequence).run();}
}
function backgroundNotification(env:Env,delivery:{ownerId:string;fresh:boolean},thread:string,ctx?:ExecutionContext){
  if(ctx&&delivery.fresh)ctx.waitUntil(withOperation(env,()=>notifySecure(env,delivery.ownerId,thread)).catch(()=>{}));
}
export async function publicSecure(request:Request,env:Env,ctx?:ExecutionContext):Promise<Response|null> {
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/federation/'))return null;
  try{
    if(url.pathname==='/api/federation/identity'&&request.method==='GET'){const identity=await serverKeys(env,url.origin);return jsonResponse({protocol:'wihm-federation/1',origin:identity.origin,publicKey:identity.publicKey,enabled:identity.enabled});}
    if(request.method!=='POST'||!['/api/federation/keys','/api/federation/inbox','/api/federation/device-list'].includes(url.pathname))return jsonResponse({error:'یافت نشد.'},404);
    const settings=await serverKeys(env,url.origin);if(!settings.enabled)return bad('فدراسیون غیرفعال است.',403);
    const source=origin(request.headers.get('X-WIHM-Origin')),host=new URL(source).hostname;
    const time=request.headers.get('X-WIHM-Time')||'',nonce=uuid(request.headers.get('X-WIHM-Nonce')),signature=request.headers.get('X-WIHM-Signature')||'';
    if(!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>300000)return bad('زمان درخواست معتبر نیست.',403);
    if(!await allowRequest(env,'federation',host,300,60000))return bad('درخواست زیاد است.',429);
    const key=await peerKey(env,host,settings);
    const body=await inputJson(request),hash=await digest(JSON.stringify(body));
    if(!await verify(key,signature,requestData(source,settings.origin,url.pathname,time,nonce,hash)))return bad('امضای سرور معتبر نیست.',403);
    const inserted=await env.DB.prepare('INSERT OR IGNORE INTO secure_nonces VALUES (?,?,?)').bind(host,nonce,Date.now()+600000).run();if(!inserted.meta.changes)return bad('درخواست تکراری است.',409);
    if(url.pathname==='/api/federation/keys'||url.pathname==='/api/federation/device-list'){
      const who=fullAddress(body.address);if(who.host!==new URL(settings.origin).hostname)return bad();
      const visible=await env.DB.prepare("SELECT 1 FROM users u JOIN discovery_profiles p ON p.user_id=u.id AND p.enabled=1 WHERE u.username=? AND NOT EXISTS(SELECT 1 FROM site_settings WHERE key='discovery_enabled' AND value='0')").bind(who.username).first();
      if(url.pathname==='/api/federation/device-list')return jsonResponse({address:body.address,list:visible?await storedList(env,who.username):null});
      return jsonResponse({address:body.address,devices:visible?await claimDevices(env,who.username):[]});
    }
    const e=await envelope(body);if(fullAddress(e.from).host!==host||fullAddress(e.to).host!==new URL(settings.origin).hostname)return bad('مبدأ یا مقصد معتبر نیست.',403);
    backgroundNotification(env,await deliver(env,e),e.thread,ctx);return jsonResponse({ok:true,id:e.id});
  }catch(error){return error instanceof InputError?jsonResponse({error:error.message},error.status):jsonResponse({error:'تحویل پیام امن کامل نشد.'},503);}
}
export async function scheduledSecure(env:Env) {
  const settings=await config(env);if(!settings.enabled)return;
  const {results}=await env.DB.prepare(`SELECT o.id,o.peer,o.envelope,o.attempts FROM secure_outbox o WHERE o.delivered_at IS NULL AND o.next_attempt<=? AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=o.owner_id AND s.disabled_at IS NOT NULL) AND EXISTS(SELECT 1 FROM secure_devices d WHERE d.user_id=o.owner_id AND d.device_id=json_extract(o.envelope,'$.fromDevice') AND d.revoked_at IS NULL) ORDER BY o.next_attempt LIMIT 20`).bind(Date.now()).all<{id:string;peer:string;envelope:string;attempts:number}>();
  await Promise.allSettled(results.map(async row=>{
    try{const response=await signedFetch(env,settings,row.peer,'/api/federation/inbox',JSON.parse(row.envelope));if(response.id!==row.id||response.ok!==true)throw new Error('receipt');await env.DB.prepare("UPDATE secure_outbox SET delivered_at=?,last_error='' WHERE id=?").bind(Date.now(),row.id).run();}
    catch{await env.DB.prepare("UPDATE secure_outbox SET attempts=attempts+1,next_attempt=?,last_error='delivery-unavailable' WHERE id=? AND delivered_at IS NULL").bind(Date.now()+Math.min(3600000,15000*2**Math.min(row.attempts,8)),row.id).run();}
  }));
  await env.DB.prepare('DELETE FROM secure_nonces WHERE expires_at<?').bind(Date.now()).run();
  await notifySecure(env);
}
export async function handleSecure(request:Request,env:Env,auth:JwtPayload,ctx?:ExecutionContext):Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname;if(!path.startsWith('/api/secure/')&&path!=='/api/service/federation')return null;
  if(path==='/api/service/federation'){
    await serviceAdmin(env,auth.userId);let settings=await serverKeys(env,url.origin);
    if(request.method==='PATCH'){
      const body=await inputJson(request);if(typeof body.enabled!=='boolean'||!body.peers||Array.isArray(body.peers)||typeof body.peers!=='object'||Object.keys(body.peers).length>20)return bad();
      const own=origin(body.origin);if(own!==settings.origin)return bad('نشانی هویت سرور ثابت است؛ آن را از این صفحه تغییر ندهید.');
      const peers:Record<string,string>={};for(const [host,key]of Object.entries(body.peers)){serverHost(host);bytes(key,32);if(host===url.hostname)return bad();peers[host]=key as string;}
      await Promise.all([saveSetting(env,'secure_enabled',body.enabled?'1':'0'),saveSetting(env,'secure_origin',own),saveSetting(env,'secure_peers',JSON.stringify(peers))]);await audit(env,auth.userId,'federation-'+(body.enabled?'enabled':'disabled'));settings=await config(env);
    }else if(request.method!=='GET')return jsonResponse({error:'یافت نشد.'},404);
    return jsonResponse({enabled:settings.enabled,origin:settings.origin,peers:settings.peers,publicKey:settings.publicKey});
  }
  if(path==='/api/secure/identity'&&request.method==='GET'){const settings=await serverKeys(env,url.origin);return jsonResponse({address:auth.username+'@'+new URL(settings.origin).hostname,origin:settings.origin});}
  if(!await allowRequest(env,'secure-api',auth.userId,300,60000))return bad('درخواست زیاد است.',429);
  if(path==='/api/secure/devices'){
    if(request.method==='POST'){
      const body=await inputJson(request),device=uuid(body.device),key=body.identityKey,keyPackage=body.keyPackage,packet=bytes(keyPackage);bytes(key,32);bytes(body.signature,64);
      if(packet.length>5000||packet[0]!==0||packet[1]!==1||packet[2]!==0||packet[3]!==5)return bad('بستهٔ کلید عمومی MLS معتبر نیست.');
      const who=auth.username+'@'+new URL(await serverOrigin(env,url.origin)).hostname;
      if(!await verify(key,body.signature,deviceData(who,device,keyPackage)))return bad('امضای دستگاه معتبر نیست.',403);
      await env.DB.prepare('INSERT OR IGNORE INTO secure_devices SELECT ?,?,?,?,?,?,NULL WHERE (SELECT count(*) FROM secure_devices WHERE user_id=? AND revoked_at IS NULL)<10').bind(auth.userId,device,key,keyPackage,body.signature,Date.now(),auth.userId).run();
      const existing=await env.DB.prepare('SELECT identity_key,key_package,revoked_at FROM secure_devices WHERE user_id=? AND device_id=?').bind(auth.userId,device).first<any>();if(!existing)return bad('حداکثر ده دستگاه امن مجاز است.',409);if(existing.identity_key!==key||existing.revoked_at)return bad('کلید هویت دستگاه قابل جایگزینی نیست.',409);
      await env.DB.prepare('INSERT OR IGNORE INTO secure_prekeys VALUES (?,?,?,?,?,NULL,?)').bind(auth.userId,device,await digest(keyPackage),keyPackage,body.signature,Date.now()).run();
      return jsonResponse({ok:true,device});
    }
    if(request.method==='GET')return jsonResponse({address:auth.username+'@'+new URL(await serverOrigin(env,url.origin)).hostname,devices:await activeDevices(env,auth.username)});
    if(request.method==='DELETE'){const body=await inputJson(request);await env.DB.prepare('UPDATE secure_devices SET revoked_at=? WHERE user_id=? AND device_id=?').bind(Date.now(),auth.userId,uuid(body.device)).run();return jsonResponse({ok:true});}
  }
  if(path==='/api/secure/device-list'){
    if(request.method==='GET')return jsonResponse({list:await storedList(env,auth.username)});
    if(request.method==='PUT'){
      const body=await inputJson(request),who=auth.username+'@'+new URL(await serverOrigin(env,url.origin)).hostname;
      if(!Number.isSafeInteger(body.version)||body.version<1||!Array.isArray(body.devices)||!body.devices.length||body.devices.length>10)return bad();
      bytes(body.signer,32);bytes(body.signature,64);
      const devices=body.devices.map((d:any)=>{uuid(d?.device);bytes(d?.key,32);return {device:d.device,key:d.key};});
      if(new Set(devices.map((d:any)=>d.device)).size!==devices.length)return bad();
      if(!await verify(body.signer,body.signature,listData(who,{...body,devices})))return bad('امضای فهرست دستگاه‌ها معتبر نیست.',403);
      const {results:active}=await env.DB.prepare('SELECT device_id AS device,identity_key AS key FROM secure_devices WHERE user_id=? AND revoked_at IS NULL').bind(auth.userId).all<{device:string;key:string}>();
      if(devices.some((d:any)=>!active.some(a=>a.device===d.device&&a.key===d.key)))return bad('فهرست فقط می‌تواند دستگاه‌های فعال همین حساب را داشته باشد.',409);
      if(!active.some(a=>a.key===body.signer))return bad('امضاکننده دستگاه فعال این حساب نیست.',403);
      const previous=await storedList(env,auth.username);
      if(previous){
        if(body.version<=previous.version)return bad('نسخهٔ فهرست دستگاه‌ها قدیمی است.',409);
        // Only a listed device may change the list, unless none of them is active any more.
        if(previous.devices.some((d:any)=>active.some(a=>a.device===d.device))&&!previous.devices.some((d:any)=>d.key===body.signer))return bad('فقط دستگاه تأییدشده می‌تواند فهرست را تغییر دهد.',403);
      }
      const list={version:body.version,devices,signer:body.signer,signature:body.signature};
      await env.DB.prepare('INSERT INTO secure_device_lists VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET list=excluded.list,version=excluded.version,updated_at=excluded.updated_at').bind(auth.userId,JSON.stringify(list),body.version,Date.now()).run();
      return jsonResponse({ok:true,version:body.version});
    }
  }
  if(path==='/api/secure/device-lists'&&request.method==='POST'){
    const body=await inputJson(request),who=fullAddress(body.address);if(!await allowRequest(env,'secure-device-list',auth.userId,120,3600000))return bad('درخواست زیاد است.',429);const settings=await serverKeys(env,url.origin);
    if(who.host===new URL(settings.origin).hostname)return jsonResponse({address:body.address,list:await storedList(env,who.username)});
    const result=await signedFetch(env,settings,who.host,'/api/federation/device-list',{address:body.address});if(result.address!==body.address)return bad('پاسخ سرور مقصد معتبر نیست.',502);return jsonResponse({address:body.address,list:result.list||null});
  }
  if(path==='/api/secure/keys'&&request.method==='POST'){
    const body=await inputJson(request),who=fullAddress(body.address);if(!await allowRequest(env,'secure-key-claim',auth.userId+':'+body.address,20,3600000))return bad('دریافت کلید این مخاطب زیاد است.',429);const settings=await serverKeys(env,url.origin);if(who.host===new URL(settings.origin).hostname)return jsonResponse({address:body.address,devices:await claimDevices(env,who.username)});
    const result=await signedFetch(env,settings,who.host,'/api/federation/keys',{address:body.address});if(result.address!==body.address||!Array.isArray(result.devices)||result.devices.length>10)return bad('پاسخ سرور مقصد معتبر نیست.',502);return jsonResponse(result);
  }
  if(path==='/api/secure/blocks'){
    if(request.method==='POST'||request.method==='DELETE'){const body=await inputJson(request);fullAddress(body.address);await env.DB.prepare(request.method==='POST'?'INSERT OR IGNORE INTO secure_blocks VALUES (?,?)':'DELETE FROM secure_blocks WHERE user_id=? AND address=?').bind(auth.userId,body.address).run();return jsonResponse({ok:true});}
    if(request.method==='GET'){const {results}=await env.DB.prepare('SELECT address FROM secure_blocks WHERE user_id=? LIMIT 1000').bind(auth.userId).all();return jsonResponse(results);}
  }
  if(path==='/api/secure/inbox'&&request.method==='GET'){
    const device=uuid(url.searchParams.get('device')),after=url.searchParams.get('after')||'0';if(!/^\d{1,15}$/.test(after))return bad();
    if(!await env.DB.prepare('SELECT 1 FROM secure_devices WHERE user_id=? AND device_id=? AND revoked_at IS NULL').bind(auth.userId,device).first())return bad('دستگاه امن فعال نیست.',403);
    const {results}=await env.DB.prepare('SELECT sequence,envelope FROM secure_events WHERE owner_id=? AND device_id=? AND sequence>? ORDER BY sequence LIMIT 100').bind(auth.userId,device,Number(after)).all<{sequence:number;envelope:string}>();return jsonResponse({events:results.map(r=>({sequence:r.sequence,envelope:JSON.parse(r.envelope)}))});
  }
  if(path==='/api/secure/send'&&request.method==='POST'){
    const e=await envelope(await inputJson(request)),sender=fullAddress(e.from),target=fullAddress(e.to);
    if(e.from!==auth.username+'@'+new URL(await serverOrigin(env,url.origin)).hostname||!await env.DB.prepare('SELECT 1 FROM secure_devices WHERE user_id=? AND device_id=? AND identity_key=? AND revoked_at IS NULL').bind(auth.userId,e.fromDevice,e.senderKey).first())return bad('فرستنده یا دستگاه معتبر نیست.',403);
    if(target.host===sender.host){backgroundNotification(env,await deliver(env,e),e.thread,ctx);return jsonResponse({ok:true,id:e.id,queued:false});}
    const settings=await serverKeys(env,url.origin);if(!settings.enabled)return bad('ارتباط سرور غیرفعال است.',403);await peerKey(env,target.host,settings);
    const text=JSON.stringify(e),hash=await digest(text);await env.DB.prepare('INSERT OR IGNORE INTO secure_outbox(id,owner_id,peer,envelope,digest,next_attempt) VALUES (?,?,?,?,?,?)').bind(e.id,auth.userId,target.host,text,hash,Date.now()).run();
    const existing=await env.DB.prepare('SELECT digest FROM secure_outbox WHERE id=? AND owner_id=?').bind(e.id,auth.userId).first<{digest:string}>();if(existing?.digest!==hash)return bad('شناسهٔ پیام تکراری است.',409);
    try{
      const receipt=await signedFetch(env,settings,target.host,'/api/federation/inbox',e);
      if(receipt.id===e.id&&receipt.ok===true){await env.DB.prepare("UPDATE secure_outbox SET delivered_at=?,last_error='' WHERE id=?").bind(Date.now(),e.id).run();return jsonResponse({ok:true,id:e.id,queued:false});}
    }catch{/* The durable outbox retries when the destination returns. */}
    return jsonResponse({ok:true,id:e.id,queued:true});
  }
  if(path==='/api/secure/delivery'&&request.method==='GET'){
    const id=uuid(url.searchParams.get('id')),row=await env.DB.prepare('SELECT id,attempts,delivered_at AS deliveredAt,last_error AS error FROM secure_outbox WHERE id=? AND owner_id=?').bind(id,auth.userId).first();return row?jsonResponse(row):jsonResponse({error:'یافت نشد.'},404);
  }
  return jsonResponse({error:'یافت نشد.'},404);
}
