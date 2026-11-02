import { assetTypes, decode64, encode64, sha256, newer, validVersion, UpdateBundle, UPDATER_MARKER } from './update-bundle.js';

export interface UpdaterEnv {
  CF_TOKEN: string; ACCOUNT_ID: string; DATABASE_ID: string; WORKER_NAME: string; UPDATER_NAME: string;
  UPDATER_AUTH: string; MAIN: Fetcher; MANAGER: DurableObjectNamespace;
}
export class CloudApi {
  constructor(readonly env:UpdaterEnv,readonly fetcher:typeof fetch=fetch) {}
  async request(path:string,method='GET',body?:any,uploadToken?:string) {
    let response:Response;const fetcher=this.fetcher;
    try {response=await fetcher('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+(uploadToken||this.env.CF_TOKEN),...(!(body instanceof FormData)&&body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(45_000)});}catch{throw new Error('ارتباط به‌روزرسان با کلادفلر قطع شد؛ دوباره تلاش کنید.');}
    const value=await response.json<any>().catch(()=>null);
    if(!response.ok||!value||value.success===false)throw new Error(`کلادفلر مرحلهٔ به‌روزرسانی را نپذیرفت (HTTP ${response.status}). دسترسی توکن را بررسی کنید.`);
    return value.result;
  }
  async query(sql:string,params:any[]=[]){const rows=await this.request(`/accounts/${this.env.ACCOUNT_ID}/d1/database/${this.env.DATABASE_ID}/query`,'POST',{sql,params});if(!Array.isArray(rows)||rows.some(r=>r.success===false))throw new Error('آماده‌سازی دیتابیس کامل نشد؛ داده‌های قبلی حذف نشده‌اند.');return rows;}
  async settings(name:string) {return this.request(`/accounts/${this.env.ACCOUNT_ID}/workers/scripts/${name}/settings`);}
}
export function retainedBindings(settings:any,version:string) {
  if(!Array.isArray(settings?.bindings))throw new Error('تنظیمات نصب قبلی معتبر نیست.');
  return settings.bindings.map((binding:any)=>{
    if(binding.type==='secret_text')return {name:binding.name,type:'inherit'};
    if(binding.name==='WIHM_VERSION'||binding.name==='WIHM_UPDATER_VERSION')return {...binding,text:version};
    return binding;
  });
}
export async function ownedMain(api:CloudApi) {
  const settings=await api.settings(api.env.WORKER_NAME),binding=(name:string)=>settings.bindings?.find((b:any)=>b.name===name);
  if(binding('WIHM_INSTALLER')?.text!=='wihm-cloudflare-v2'||binding('DB')?.id!==api.env.DATABASE_ID||binding('JWT_SECRET')?.type!=='secret_text'||binding('CHAT_ROOM')?.type!=='durable_object_namespace')throw new Error('نصب قبلی با این به‌روزرسان مطابقت ندارد؛ عملیات متوقف شد.');
  return settings;
}
export async function migrateBundle(api:CloudApi,bundle:UpdateBundle) {
  const text=(name:string)=>new TextDecoder().decode(decode64(bundle.files[name]));
  const versions=(await api.query('SELECT version FROM schema_migrations'))[0]?.results?.map((r:any)=>r.version)||[];
  const files=Object.keys(bundle.files).filter(name=>name.startsWith('migrations/')).sort();
  if(versions.some((name:string)=>!files.includes('migrations/'+name)))throw new Error('دیتابیس از این بسته جدیدتر است؛ به‌روزرسانی متوقف شد.');
  await api.query(text('schema.sql'));
  for(const name of files)if(!versions.includes(name.slice(11))){await api.query(text(name));await api.query('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)',[name.slice(11),Date.now()]);}
}
export async function uploadBundleAssets(api:CloudApi,bundle:UpdateBundle) {
  const manifest:Record<string,{hash:string;size:number}>={},files=new Map<string,{bytes:Uint8Array;type:string}>();
  for(const [name,value]of Object.entries(bundle.files).filter(([name])=>name.startsWith('public/'))){const bytes=decode64(value),ext=name.split('.').at(-1)!,hash=(await sha256(value+ext)).slice(0,32);manifest['/'+name.slice(7)]={hash,size:bytes.length};files.set(hash,{bytes,type:assetTypes[ext]});}
  const root=`/accounts/${api.env.ACCOUNT_ID}/workers`,session=await api.request(`${root}/scripts/${api.env.WORKER_NAME}/assets-upload-session`,'POST',{manifest});
  if(typeof session?.jwt!=='string'||!Array.isArray(session.buckets))throw new Error('مجوز بارگذاری فایل‌ها دریافت نشد.');
  let completion=session.buckets.length?null:session.jwt;
  for(const bucket of session.buckets){if(!Array.isArray(bucket))throw new Error('فهرست بارگذاری معتبر نیست.');const form=new FormData();for(const hash of bucket){const file=files.get(hash);if(!file)throw new Error('فهرست فایل‌های بسته معتبر نیست.');form.append(hash,new Blob([encode64(file.bytes)],{type:file.type}),hash);}const result=await api.request(root+'/assets/upload?base64=true','POST',form,session.jwt);if(result?.jwt)completion=result.jwt;}
  if(!completion)throw new Error('بارگذاری فایل‌ها کامل نشد.');return completion;
}
export async function publishMain(api:CloudApi,bundle:UpdateBundle,force=false) {
  const settings=await ownedMain(api);
  const installed=settings.bindings.find((b:any)=>b.name==='WIHM_VERSION')?.text;
  if(validVersion(installed)&&newer(installed,bundle.version))throw new Error('سرور از این بسته جدیدتر است؛ بازگشت ناخواسته به نسخهٔ قدیمی انجام نشد.');
  // An accepted upload followed by a lost response is safe to resume.
  if(!force&&settings.bindings.find((b:any)=>b.name==='WIHM_VERSION')?.text===bundle.version)return;
  const jwt=await uploadBundleAssets(api,bundle),form=new FormData();
  form.append('metadata',new Blob([JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-01-01',compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],bindings:retainedBindings(settings,bundle.version),assets:{jwt,config:{html_handling:'auto-trailing-slash',not_found_handling:'none'}}})],{type:'application/json'}));
  form.append('worker.mjs',new Blob([decode64(bundle.files['worker.mjs'])],{type:'application/javascript+module'}),'worker.mjs');
  await api.request(`/accounts/${api.env.ACCOUNT_ID}/workers/scripts/${api.env.WORKER_NAME}?bindings_inherit=strict`,'PUT',form);
}
export async function publishUpdater(api:CloudApi,bundle:UpdateBundle,replacementToken?:string) {
  const settings=await api.settings(api.env.UPDATER_NAME);
  if(settings.bindings?.find((b:any)=>b.name==='WIHM_UPDATER')?.text!==UPDATER_MARKER||settings.bindings?.find((b:any)=>b.name==='WORKER_NAME')?.text!==api.env.WORKER_NAME)throw new Error('به‌روزرسان متعلق به این نصب نیست.');
  const installed=settings.bindings.find((b:any)=>b.name==='WIHM_UPDATER_VERSION')?.text;
  if(validVersion(installed)&&newer(installed,bundle.version))throw new Error('به‌روزرسان از این بسته جدیدتر است؛ نسخهٔ قدیمی جایگزین نشد.');
  if(settings.bindings.find((b:any)=>b.name==='WIHM_UPDATER_VERSION')?.text===bundle.version&&!replacementToken)return;
  const bindings=retainedBindings(settings,bundle.version).map((binding:any)=>replacementToken&&binding.name==='CF_TOKEN'?{name:'CF_TOKEN',type:'secret_text',text:replacementToken}:binding);
  const form=new FormData();form.append('metadata',new Blob([JSON.stringify({main_module:'updater.mjs',compatibility_date:'2026-01-01',compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],bindings})],{type:'application/json'}));
  form.append('updater.mjs',new Blob([decode64(bundle.files['updater.mjs'])],{type:'application/javascript+module'}),'updater.mjs');
  await api.request(`/accounts/${api.env.ACCOUNT_ID}/workers/scripts/${api.env.UPDATER_NAME}?bindings_inherit=strict`,'PUT',form);
}
