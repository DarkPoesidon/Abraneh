import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudflareError } from './cloudflare.mjs';

const MARKER='wihm-updater-v1';
export async function inspectUpdater(api,accountId,name) {
  let settings;
  try{settings=(await api.request(`/accounts/${accountId}/workers/scripts/${name}-updates/settings`)).result;}
  catch(error){if(error instanceof CloudflareError&&error.status===404&&error.codes.includes(10007))return null;throw error;}
  const binding=key=>settings.bindings?.find(row=>row.name===key);
  if(binding('WIHM_UPDATER')?.text!==MARKER||binding('WORKER_NAME')?.text!==name||binding('MANAGER')?.type!=='durable_object_namespace')throw new Error('برنامه‌ای دیگر از نام به‌روزرسان استفاده می‌کند؛ هیچ تغییری در آن انجام نشد.');
  return settings;
}
export async function installUpdater({api,accountId,name,databaseId,payloadDir,version,auth,attachMain}) {
  if(typeof api.token!=='string'||!api.token)throw new Error('دسترسی انتشار در اختیار نصب‌کننده نیست؛ دوباره حساب را متصل کنید.');
  const prior=await inspectUpdater(api,accountId,name),updaterName=name+'-updates';
  const metadata={main_module:'updater.mjs',compatibility_date:'2026-01-01',compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],bindings:[
    {name:'MANAGER',type:'durable_object_namespace',class_name:'UpdateManager'},
    {name:'WIHM_UPDATER',type:'plain_text',text:MARKER},{name:'WIHM_UPDATER_VERSION',type:'plain_text',text:version},
    {name:'WORKER_NAME',type:'plain_text',text:name},{name:'UPDATER_NAME',type:'plain_text',text:updaterName},
    {name:'ACCOUNT_ID',type:'plain_text',text:accountId},{name:'DATABASE_ID',type:'plain_text',text:databaseId},
    {name:'CF_TOKEN',type:'secret_text',text:api.token},{name:'UPDATER_AUTH',type:'secret_text',text:auth},
    ...(attachMain?[{name:'MAIN',type:'service',service:name}]:[]),
  ],...(!prior?{migrations:{new_tag:'updater-v1',new_sqlite_classes:['UpdateManager']}}:{})};
  const form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
  form.append('updater.mjs',new Blob([await readFile(join(payloadDir,'updater.mjs'))],{type:'application/javascript+module'}),'updater.mjs');
  const path=`/accounts/${accountId}/workers/scripts/${updaterName}`;
  await api.request(path+'?bindings_inherit=strict',{method:'PUT',form});
  await api.request(path+'/subdomain',{method:'POST',json:{enabled:false,previews_enabled:false}});
}
