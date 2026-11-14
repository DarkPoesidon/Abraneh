/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env, JwtPayload } from './types.js';
import { APP_VERSION } from './version.js';
import { inputJson, jsonResponse, InputError } from './http.js';
import { allowRequest } from './limits.js';
import { newer } from './update-bundle.js';
import { sendUpdatePush } from './push.js';

async function callUpdater(env:Env,path:string,body?:any) {
  if(!env.UPDATER||!env.UPDATER_AUTH)return {configured:false,installedVersion:APP_VERSION,mode:'manual',latest:null,job:null};
  const response=await env.UPDATER.fetch('https://updater.internal'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+env.UPDATER_AUTH,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json<any>();if(!response.ok)throw new InputError(typeof data.error==='string'&&/[\u0600-\u06ff]/.test(data.error)?data.error:'ارتباط با به‌روزرسان برقرار نشد.',response.status);
  return {...data,installedVersion:APP_VERSION};
}
export async function handleUpdates(request:Request,env:Env,auth:JwtPayload) {
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/api/service/updates'))return null;
  if(!await env.DB.prepare('SELECT 1 FROM service_admins WHERE slot=1 AND user_id=?').bind(auth.userId).first())throw new InputError('این بخش فقط برای مدیر سرویس است.',403);
  if(path==='/api/service/updates'&&request.method==='GET')return jsonResponse(await callUpdater(env,'/status'));
  const action=path.slice('/api/service/updates'.length);
  if(!['/check','/mode','/apply','/access'].includes(action)||request.method!=='POST')return jsonResponse({error:'یافت نشد.'},404);
  if(!await allowRequest(env,'update-control',auth.userId,30,3600_000))throw new InputError('درخواست‌های بررسی زیاد است؛ بعداً تلاش کنید.',429);
  const body=await inputJson(request);
  if(!env.UPDATER||!env.UPDATER_AUTH)throw new InputError('برای فعال‌سازی، نصب‌کنندهٔ جدید را یک بار با همان نام و گزینهٔ به‌روزرسانی سرور اجرا کنید.',409);
  return jsonResponse(await callUpdater(env,action,action==='/check'?{manual:true}:action==='/mode'?{mode:body.mode}:action==='/access'?{token:typeof body.token==='string'?body.token.trim():''}:{version:body.version}),action==='/apply'?202:200);
}
export async function scheduledUpdates(env:Env) {
  if(!env.UPDATER||!env.UPDATER_AUTH)return;
  const status=await callUpdater(env,'/check',{manual:false});
  if(status.mode!=='notify'||!status.latest||!newer(status.latest.version,APP_VERSION))return;
  const key='update_push',old=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first<{value:string}>();
  let cursor:any={};try{cursor=JSON.parse(old?.value||'{}');}catch{/* Restart an incomplete notice. */}
  if(cursor.version!==status.latest.version)cursor={version:status.latest.version,after:'',complete:false};
  if(cursor.complete)return;
  const next=await sendUpdatePush(env,status.latest.version,cursor.after||'');cursor.after=next||'';cursor.complete=next===null;
  await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(cursor)).run();
}
