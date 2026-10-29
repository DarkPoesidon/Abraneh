import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { Env, JwtPayload, UserRow } from './types.js';
import { verifyPassword } from './auth.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { tokenHash } from './access.js';
import { issueSession, revokeSessions } from './sessions.js';

type Identity = JwtPayload & { sid:string };
type Account = UserRow & { authVersion:number };
type Challenge = { user_id:string|null; challenge:string; password_version:number };
type Passkey = { id:string; public_key:string; counter:number; transports:string };
const text = new TextEncoder();
function fail(message = 'تأیید امنیتی نامعتبر یا منقضی است.', status = 401):never { throw new InputError(message,status); }
const b64 = (bytes:Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const bytes = (value:string) => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(24)));
function origin(request:Request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) fail('کلید عبور به HTTPS نیاز دارد.',400);
  return url;
}
async function account(env:Env,id:string):Promise<Account|null> {
  return env.DB.prepare('SELECT u.*,COALESCE(a.password_version,1) AS authVersion FROM users u LEFT JOIN account_security a ON a.user_id=u.id WHERE u.id=?').bind(id).first<Account>();
}
async function challenge(env:Env,request:Request,user:Account|null,kind:string,value:string,sid='') {
  const id=random(),now=Date.now();
  await env.DB.prepare('DELETE FROM security_challenges WHERE expires_at<=?').bind(now).run();
  await env.DB.prepare('INSERT INTO security_challenges VALUES (?,?,?,?,?,?,?,?)').bind(id,user?.id||null,kind,value,origin(request).origin,sid,user?.authVersion||1,now+300_000).run();
  return id;
}
async function consume(env:Env,request:Request,id:unknown,kind:string,sid=''):Promise<Challenge> {
  if(typeof id!=='string'||id.length>100)fail(undefined,sid?403:401);
  const row=await env.DB.prepare('DELETE FROM security_challenges WHERE id=? AND kind=? AND origin=? AND session_id=? AND expires_at>? RETURNING user_id,challenge,password_version').bind(id,kind,origin(request).origin,sid,Date.now()).first<Challenge>();
  if(!row)fail(undefined,sid?403:401);
  return row;
}
async function current(env:Env,saved:Challenge,status=401) {
  const user=saved.user_id?await account(env,saved.user_id):null;
  if(!user||user.authVersion!==saved.password_version)fail(undefined,status);
  return user;
}
async function totpKey(env:Env) {
  const key=await crypto.subtle.importKey('raw',text.encode(env.JWT_SECRET), 'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:text.encode('WIHM security v1'),info:text.encode('TOTP secret encryption')},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function seal(env:Env,id:string,secret:Uint8Array) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:text.encode(id)},await totpKey(env),secret);
  return b64(iv)+'.'+b64(new Uint8Array(cipher));
}
async function unseal(env:Env,id:string,sealed:string) {
  const [iv,cipher]=sealed.split('.');
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:text.encode(id)},await totpKey(env),bytes(cipher)));
}
function base32(secret:Uint8Array) {
  let buffer=0,bits=0,result='';
  for(const byte of secret){buffer=(buffer<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(buffer>>>bits)&31];}}
  if(bits)result+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(buffer<<(5-bits))&31];
  return result;
}
async function totp(secret:Uint8Array,step:number) {
  const counter=new Uint8Array(8);new DataView(counter.buffer).setBigUint64(0,BigInt(step));
  const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,counter)),offset=digest[19]&15;
  return ((new DataView(digest.buffer).getUint32(offset)&0x7fffffff)%1_000_000).toString().padStart(6,'0');
}
function equal(a:string,b:string) { let mismatch=a.length^b.length;for(let i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0; }
async function matchingStep(secret:Uint8Array,otp:string) {
  const now=Math.floor(Date.now()/30_000);
  for(const step of [now,now-1,now+1])if(equal(await totp(secret,step),otp))return step;
  return -1;
}
// A verified passkey requires possession and local PIN/biometric; password logins use this extra factor.
export async function enforceSecondFactor(env:Env,userId:string,body:any,failureStatus=401):Promise<void> {
  const row=await env.DB.prepare('SELECT secret FROM user_totp WHERE user_id=?').bind(userId).first<{secret:string}>();
  if(!row)return;
  if(!await allowRequest(env,'second-factor',userId,20,900_000))fail('تعداد تلاش تأیید زیاد است؛ ۱۵ دقیقه دیگر تلاش کنید.',429);
  const otp=typeof body.otp==='string'?body.otp.trim():'';
  if(/^[0-9]{6}$/.test(otp)) {
    const step=await matchingStep(await unseal(env,userId,row.secret),otp);
    if(step>=0&&(await env.DB.prepare('UPDATE user_totp SET last_step=? WHERE user_id=? AND secret=? AND last_step<?').bind(step,userId,row.secret,step).run()).meta.changes)return;
  } else if(/^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/.test(otp)) {
    if(await env.DB.prepare('DELETE FROM security_recovery WHERE user_id=? AND code_hash=? RETURNING code_hash').bind(userId,await tokenHash(otp)).first())return;
  }
  fail('کد دومرحله‌ای یا کد بازیابی لازم است؛ هر کد فقط یک بار پذیرفته می‌شود.',failureStatus);
}
async function reauthenticate(env:Env,userId:string,body:any) {
  if(!await allowRequest(env,'security-password',userId,15,900_000))fail('تعداد تلاش زیاد است؛ ۱۵ دقیقه دیگر تلاش کنید.',429);
  const user=await account(env,userId);
  if(!user||typeof body.password!=='string'||body.password.length>1024||!await verifyPassword(body.password,user.salt,user.password_hash))fail('رمز عبور فعلی درست نیست.',403);
  await enforceSecondFactor(env,userId,body,403);
  return user;
}
async function recovery(env:Env,userId:string) {
  const codes=Array.from({length:8},()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('').match(/.{8}/g)!.join('-'));
  const hashes=await Promise.all(codes.map(tokenHash));
  await env.DB.batch([env.DB.prepare('DELETE FROM security_recovery WHERE user_id=?').bind(userId),...hashes.map(hash=>env.DB.prepare('INSERT INTO security_recovery SELECT ?,? WHERE EXISTS(SELECT 1 FROM user_totp WHERE user_id=?)').bind(userId,hash,userId))]);
  return codes;
}
export async function publicSecurity(request:Request,env:Env):Promise<Response|null> {
  const path=new URL(request.url).pathname;
  if(!['/api/auth/passkey/options','/api/auth/passkey/verify'].includes(path)||request.method!=='POST')return null;
  const rp=origin(request),ip=request.headers.get('CF-Connecting-IP')||'unknown';
  if(!await allowRequest(env,'passkey-login',ip,60,900_000))fail('تعداد تلاش ورود زیاد است.',429);
  const body=await inputJson(request);
  if(path.endsWith('/options')) {
    const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
    if(!/^[a-z0-9_]{3,20}$/.test(username))fail('نام کاربری را وارد کنید.',400);
    const found=await env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first<{id:string}>();
    const user=found?await account(env,found.id):null;
    const {results}=await env.DB.prepare('SELECT id,transports FROM passkeys WHERE user_id=?').bind(user?.id||'').all<Passkey>();
    const options=await generateAuthenticationOptions({rpID:rp.hostname,userVerification:'required',allowCredentials:results.length?results.map(row=>({id:row.id,transports:JSON.parse(row.transports)})):[{id:random()}]});
    return jsonResponse({challengeId:await challenge(env,request,user,'login',options.challenge),options});
  }
  const saved=await consume(env,request,body.challengeId,'login'),user=await current(env,saved);
  const credential=body.credential;
  if(!credential||typeof credential.id!=='string')fail();
  const key=await env.DB.prepare('SELECT * FROM passkeys WHERE id=? AND user_id=?').bind(credential.id,user.id).first<Passkey>();
  if(!key)fail();
  let verified;
  try{verified=await verifyAuthenticationResponse({response:credential,expectedChallenge:saved.challenge,expectedOrigin:rp.origin,expectedRPID:rp.hostname,requireUserVerification:true,credential:{id:key.id,publicKey:bytes(key.public_key),counter:key.counter,transports:JSON.parse(key.transports)}});}catch{fail();}
  if(!verified.verified)fail();
  const updated=await env.DB.prepare('UPDATE passkeys SET counter=? WHERE id=? AND user_id=? AND counter=?').bind(verified.authenticationInfo.newCounter,key.id,user.id,key.counter).run();
  if(!updated.meta.changes)fail();
  const profile={id:user.id,username:user.username,displayName:user.display_name,createdAt:user.created_at};
  return jsonResponse({token:await issueSession(request,env,profile,user.authVersion),user:profile});
}
export async function handleSecurity(request:Request,env:Env,auth:Identity):Promise<Response|null> {
  const path=new URL(request.url).pathname,method=request.method,userId=auth.userId;
  if(!path.startsWith('/api/security/'))return null;
  if(path==='/api/security/status'&&method==='GET') {
    const {results:passkeys}=await env.DB.prepare('SELECT id,name,created_at AS createdAt FROM passkeys WHERE user_id=? ORDER BY created_at').bind(userId).all();
    const enabled=!!await env.DB.prepare('SELECT 1 FROM user_totp WHERE user_id=?').bind(userId).first();
    const remaining=await env.DB.prepare('SELECT count(*) AS n FROM security_recovery WHERE user_id=?').bind(userId).first<{n:number}>();
    return jsonResponse({passkeys,totp:enabled,recoveryRemaining:remaining?.n||0});
  }
  if(method!=='POST')return null;
  if(!['passkeys/options','passkeys/verify','passkeys/delete','totp/setup','totp/enable','totp/disable','recovery'].some(route=>path==='/api/security/'+route))return null;
  const body=await inputJson(request),rp=origin(request);
  if(path==='/api/security/passkeys/verify') {
    const saved=await consume(env,request,body.challengeId,'register',auth.sid),user=await current(env,saved,403);
    if(user.id!==userId)fail(undefined,403);
    let verified;
    try{verified=await verifyRegistrationResponse({response:body.credential,expectedChallenge:saved.challenge,expectedOrigin:rp.origin,expectedRPID:rp.hostname,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});}catch{fail(undefined,403);}
    if(!verified.verified||!verified.registrationInfo)fail(undefined,403);
    const key=verified.registrationInfo.credential;
    const name=typeof body.name==='string'?body.name.trim().slice(0,80):'کلید عبور';
    const savedKey=await env.DB.prepare('INSERT OR IGNORE INTO passkeys SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM passkeys WHERE user_id=?)<10').bind(key.id,userId,b64(key.publicKey),key.counter,JSON.stringify(key.transports||[]),name||'کلید عبور',Date.now(),userId).run();
    if(!savedKey.meta.changes)fail('کلید تکراری است یا سقف ۱۰ کلید پر شده است.',409);
    return jsonResponse({ok:true});
  }
  if(path==='/api/security/totp/enable') {
    const saved=await consume(env,request,body.challengeId,'totp',auth.sid),user=await current(env,saved,403);
    if(user.id!==userId)fail(undefined,403);
    const secret=await unseal(env,userId,saved.challenge),otp=typeof body.otp==='string'?body.otp.trim():'';
    const step=/^[0-9]{6}$/.test(otp)?await matchingStep(secret,otp):-1;
    if(step<0)fail('کد برنامهٔ رمزساز درست نیست. راه‌اندازی را دوباره انجام دهید.',403);
    const enabled=await env.DB.prepare('INSERT OR IGNORE INTO user_totp VALUES (?,?,?)').bind(userId,saved.challenge,step).run();
    if(!enabled.meta.changes)fail('ورود دومرحله‌ای قبلاً فعال شده است.',409);
    await env.DB.prepare('DELETE FROM security_challenges WHERE user_id=?').bind(userId).run();
    await env.DB.prepare('INSERT INTO session_policy (user_id,legacy_disabled) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET legacy_disabled=1').bind(userId).run();
    const {results}=await env.DB.prepare('SELECT id FROM user_sessions WHERE user_id=? AND id!=? AND revoked_at IS NULL').bind(userId,auth.sid).all<{id:string}>();
    await revokeSessions(env,userId,results.map(row=>row.id));
    return jsonResponse({ok:true,recoveryCodes:await recovery(env,userId)});
  }
  const user=await reauthenticate(env,userId,body);
  if(path==='/api/security/passkeys/options') {
    const {results}=await env.DB.prepare('SELECT id FROM passkeys WHERE user_id=?').bind(userId).all<{id:string}>();
    if(results.length>=10)fail('حداکثر ۱۰ کلید عبور مجاز است.',400);
    const options=await generateRegistrationOptions({rpName:'WIHM',rpID:rp.hostname,userID:new Uint8Array(text.encode(userId)),userName:user.username,userDisplayName:user.display_name,attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'},supportedAlgorithmIDs:[-7,-257],excludeCredentials:results});
    return jsonResponse({challengeId:await challenge(env,request,user,'register',options.challenge,auth.sid),options});
  }
  if(path==='/api/security/passkeys/delete') {
    if(typeof body.id!=='string'||body.id.length>2048)fail('کلید عبور را انتخاب کنید.',400);
    await env.DB.prepare('DELETE FROM passkeys WHERE id=? AND user_id=?').bind(body.id,userId).run();
    return jsonResponse({ok:true});
  }
  if(path==='/api/security/totp/setup') {
    if(await env.DB.prepare('SELECT 1 FROM user_totp WHERE user_id=?').bind(userId).first())fail('ورود دومرحله‌ای قبلاً فعال است.',409);
    const secret=crypto.getRandomValues(new Uint8Array(20));
    await env.DB.prepare("DELETE FROM security_challenges WHERE user_id=? AND kind='totp'").bind(userId).run();
    return jsonResponse({challengeId:await challenge(env,request,user,'totp',await seal(env,userId,secret),auth.sid),uri:`otpauth://totp/${encodeURIComponent('WIHM:'+user.username+'@'+rp.hostname)}?secret=${base32(secret)}&issuer=WIHM&algorithm=SHA1&digits=6&period=30`});
  }
  if(path==='/api/security/totp/disable') {
    await env.DB.batch([env.DB.prepare('DELETE FROM user_totp WHERE user_id=?').bind(userId),env.DB.prepare('DELETE FROM security_recovery WHERE user_id=?').bind(userId),env.DB.prepare('DELETE FROM security_challenges WHERE user_id=?').bind(userId)]);
    return jsonResponse({ok:true});
  }
  if(!await env.DB.prepare('SELECT 1 FROM user_totp WHERE user_id=?').bind(userId).first())fail('ابتدا ورود دومرحله‌ای را فعال کنید.',400);
  return jsonResponse({recoveryCodes:await recovery(env,userId)});
}
