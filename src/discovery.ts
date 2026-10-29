import { Env, JwtPayload } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { serviceAdmin, audit } from './management.js';
import { APP_VERSION } from './version.js';
import { serverOrigin } from './server-identity.js';

const fail=(message='نشانی باید مانند user@chat.example.org و بدون مسیر، پورت یا IP باشد.')=>{throw new InputError(message);};
const disabledDiscovery='مدیر سرور مقصد پیدا شدن کاربران را فعال نکرده یا نشانی اصلی را تنظیم نکرده است. در مقصد «مدیریت سرویس ← پیدا کردن بین سرورها» را تنظیم کنید؛ سپس صاحب حساب هم باید اجازهٔ نمایش بدهد.';
export function serverHost(value:unknown):string {
  if(typeof value!=='string'||value.length>253||value!==value.toLowerCase()||!value.includes('.')||/[^a-z0-9.-]/.test(value)||value.endsWith('.')||value.split('.').some(p=>!p||p.length>63||p.startsWith('-')||p.endsWith('-'))||!/[a-z]/.test(value.split('.').at(-1)!)||/(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(value))return fail();
  const url=new URL('https://'+value);if(url.hostname!==value||url.port||url.username||url.password)return fail();return value;
}
export function address(value:unknown) {
  if(typeof value!=='string')return fail();
  const parts=value.trim().toLowerCase().replace(/^@/,'').split('@');
  if(parts.length!==2||!/[a-z0-9_]/.test(parts[0])||!/^[a-z0-9_]{3,20}$/.test(parts[0]))return fail();
  return {username:parts[0],host:serverHost(parts[1])};
}
async function config(env:Env) {
  const {results}=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key IN ('discovery_enabled','discovery_origin','discovery_peers')").all<{key:string;value:string}>();
  const values=Object.fromEntries(results.map(row=>[row.key,row.value]));let peers:string[]=[];try{peers=JSON.parse(values.discovery_peers||'[]');}catch{}
  return {enabled:values.discovery_enabled!=='0',origin:values.discovery_origin||'',peers};
}
export async function publicDiscovery(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url),match=url.pathname.match(/^\/api\/discovery\/([a-z0-9_]{3,20})$/);
  if(url.pathname!=='/.well-known/wihm'&&!match)return null;
  if(request.method!=='GET')return jsonResponse({error:'یافت نشد.'},404);
  try{
    const settings=await config(env);
    const enabled=settings.enabled,canonical=await serverOrigin(env,url.origin);
    if(!match)return jsonResponse({protocol:'wihm-discovery/1',app:'wihm-cloudflare',version:APP_VERSION,origin:url.origin,canonicalOrigin:canonical,enabled,capabilities:{lookup:enabled,messaging:true,e2ee:'experimental-mls'}});
    if(!enabled)return jsonResponse({error:'پیدا کردن کاربران این سرویس فعال نیست.'},404);
    if(!await allowRequest(env,'public-discovery',request.headers.get('CF-Connecting-IP')||'unknown',60,3600_000))return jsonResponse({error:'درخواست زیاد است.'},429);
    const row=await env.DB.prepare(`SELECT u.username,u.display_name AS displayName FROM users u JOIN discovery_profiles p ON p.user_id=u.id AND p.enabled=1 WHERE u.username=? AND NOT EXISTS(SELECT 1 FROM service_user_state s WHERE s.user_id=u.id AND s.disabled_at IS NOT NULL)`).bind(match[1]).first<any>();
    if(!row)return jsonResponse({error:'کاربر پیدا نشد یا اجازهٔ نمایش نداده است.'},404);
    return jsonResponse({address:row.username+'@'+url.hostname,canonicalAddress:row.username+'@'+new URL(canonical).hostname,username:row.username,displayName:row.displayName,origin:url.origin,capabilities:{messaging:true,e2ee:'experimental-mls'}});
  }catch(error){if(error instanceof InputError)return jsonResponse({error:error.message},error.status);return jsonResponse({error:'بررسی سرویس کامل نشد.'},503);}
}
async function remoteJson(url:string,kind:'server'|'profile') {
  // Never forward the caller's token, cookies or supplied URL paths.
  let response:Response;
  try{response=await fetch(url,{redirect:'manual',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});}catch{throw new InputError('اتصال به سرور مقصد برقرار نشد؛ نشانی، اینترنت و دسترسی عمومی سرور مقصد را بررسی کنید.',502);}
  const unavailable=kind==='server'?'سرور مقصد این روش پیدا کردن را ندارد یا نسخهٔ آن قدیمی است؛ صاحب سرور باید برنامه را به‌روز کند.':'این نام در سرور مقصد پیدا نشد یا صاحب حساب اجازهٔ نمایش نداده است. از مخاطب بخواهید در «کاربران سرورهای دیگر» اجازهٔ پیدا شدن را فعال کند.';
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw new InputError('سرور مقصد به نشانی دیگری هدایت می‌کند؛ نشانی اصلی HTTPS را از صاحب سرور بگیرید.',502);}
  if(response.status===401||response.status===403){await response.body?.cancel();throw new InputError('دسترسی عمومی به سرور مقصد بسته است؛ محدودیت‌های شبکه یا Cloudflare Access را با صاحب سرور بررسی کنید.',502);}
  if(response.status===429||response.status>=500){await response.body?.cancel();throw new InputError('سرور مقصد فعلاً پاسخ مناسب نمی‌دهد یا محدودیت درخواست دارد؛ بعداً دوباره تلاش کنید.',502);}
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){await response.body?.cancel();throw new InputError(unavailable,kind==='profile'&&response.status===404?404:502);}
  const reader=response.body?.getReader();if(!reader)throw new InputError('پاسخ سرور مقصد خالی است.',502);
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>6000){await reader.cancel();throw new InputError('پاسخ سرور مقصد بیش از حد مجاز است.',502);}chunks.push(part.value);}}
  catch(error){if(error instanceof InputError)throw error;throw new InputError('دریافت پاسخ سرور مقصد کامل نشد؛ دوباره تلاش کنید.',502);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  let result:any;try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new InputError('پاسخ سرور مقصد معتبر نیست.',502);}
  if(!response.ok){if(kind==='server'&&response.status===404&&result?.error==='پیدا کردن کاربران این سرویس فعال نیست.')throw new InputError(disabledDiscovery,409);throw new InputError(unavailable,kind==='profile'&&response.status===404?404:502);}
  return result;
}
export async function handleDiscovery(request:Request,env:Env,auth:JwtPayload) {
  const path=new URL(request.url).pathname;
  if(path==='/api/service/network'){
    await serviceAdmin(env,auth.userId);
    if(request.method==='GET')return jsonResponse(await config(env));
    if(request.method==='PATCH'){
      const body=await inputJson(request);if(typeof body.enabled!=='boolean'||typeof body.origin!=='string'||!Array.isArray(body.peers)||body.peers.length>20)return fail('تنظیمات شبکه معتبر نیست.');
      const peers=[...new Set<string>(body.peers.map((host:unknown)=>serverHost(host)))];
      let origin:URL;try{origin=new URL(body.origin);}catch{return fail('نشانی اصلی باید با https:// شروع شود.');}
      if(origin.protocol!=='https:'||origin.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)return fail('فقط آدرس اصلی HTTPS همین پیام‌رسان را بدون مسیر وارد کنید.');
      serverHost(origin.hostname);
      if(origin.origin!==new URL(request.url).origin)return fail('تنظیمات را از آدرس اصلی پیام‌رسان باز کنید و همان آدرس را ثبت کنید.');
      await env.DB.batch([env.DB.prepare("INSERT INTO site_settings VALUES ('discovery_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.enabled?'1':'0'),env.DB.prepare("INSERT INTO site_settings VALUES ('discovery_origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(origin.origin),env.DB.prepare("INSERT INTO site_settings VALUES ('discovery_peers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(peers))]);
      await audit(env,auth.userId,'discovery-'+(body.enabled?'enabled':'disabled'));return jsonResponse(await config(env));
    }
  }
  if(path==='/api/profile/discovery'){
    if(request.method==='POST'){const body=await inputJson(request);if(typeof body.enabled!=='boolean')return fail('وضعیت نمایش معتبر نیست.');await env.DB.prepare('INSERT INTO discovery_profiles VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').bind(auth.userId,body.enabled?1:0).run();}
    else if(request.method!=='GET')return jsonResponse({error:'یافت نشد.'},404);
    const [settings,row]=await Promise.all([config(env),env.DB.prepare('SELECT enabled FROM discovery_profiles WHERE user_id=?').bind(auth.userId).first<{enabled:number}>()]);
    return jsonResponse({enabled:row?.enabled===1,serverEnabled:settings.enabled,address:auth.username+'@'+new URL(await serverOrigin(env,new URL(request.url).origin)).hostname});
  }
  if(path==='/api/network/lookup'&&request.method==='POST'){
    if(!await allowRequest(env,'remote-lookup',auth.userId,20,3600_000))throw new InputError('جستجوی بین سرورها زیاد است؛ بعداً تلاش کنید.',429);
    const body=await inputJson(request),who=address(body.address),origin='https://'+who.host,settings=await config(env);
    const meta=await remoteJson(origin+'/.well-known/wihm','server');
    if(meta?.protocol!=='wihm-discovery/1'||meta.origin!==origin)throw new InputError('سرور مقصد با این روش پیدا کردن سازگار نیست؛ نشانی اصلی و نسخهٔ برنامهٔ مقصد را بررسی کنید.',502);
    if(meta.enabled===false||meta.capabilities?.lookup===false)throw new InputError(disabledDiscovery,409);
    if(meta.capabilities?.lookup!==true)throw new InputError('نسخه یا تنظیمات سرور مقصد از پیدا کردن کاربران پشتیبانی نمی‌کند.',502);
    const row=await remoteJson(origin+'/api/discovery/'+who.username,'profile');
    if(row?.address!==who.username+'@'+who.host||row.origin!==origin||row.username!==who.username||typeof row.displayName!=='string'||row.displayName.length>100)throw new InputError('هویت برگشتی با نشانی درخواستی مطابقت ندارد.',502);
    let canonicalAddress=row.address;
    if(row.canonicalAddress&&row.canonicalAddress!==row.address){
      const canonical=address(row.canonicalAddress),canonicalOrigin='https://'+canonical.host;
      if(canonical.username!==who.username||meta.canonicalOrigin!==canonicalOrigin)throw new InputError('نشانی اصلی مقصد معتبر نیست.',502);
      const confirmed=await remoteJson(canonicalOrigin+'/api/discovery/'+who.username,'profile');
      if(confirmed.address!==row.canonicalAddress||confirmed.origin!==canonicalOrigin||confirmed.username!==who.username)throw new InputError('نشانی اصلی مقصد تأیید نشد.',502);
      canonicalAddress=confirmed.address;
    }
    return jsonResponse({address:canonicalAddress,username:row.username,displayName:row.displayName,origin:'https://'+address(canonicalAddress).host,messaging:row.capabilities?.messaging===true,e2ee:row.capabilities?.e2ee||false});
  }
  return null;
}
