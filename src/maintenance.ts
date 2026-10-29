import { Env } from './types.js';
import { InputError } from './http.js';

export async function beginOperation(env:Env) {
  // shortcut: hard-killed invocations require operator review; add write fencing before reclaiming their rows.
  const id=crypto.randomUUID();
  const result=await env.DB.prepare(`INSERT INTO service_operations SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM service_control WHERE paused_until>?) AND NOT EXISTS(SELECT 1 FROM service_restore WHERE state='importing')`).bind(id,Date.now(),Date.now()).run();
  if(!result.meta.changes)throw new InputError('سرویس موقتاً برای پشتیبان یا بازیابی متوقف است؛ پیام در صف دستگاه می‌ماند. کمی بعد دوباره تلاش کنید.',503);
  return async()=>{await env.DB.prepare('DELETE FROM service_operations WHERE id=?').bind(id).run();};
}
export async function withOperation<T>(env:Env,work:()=>Promise<T>):Promise<T>{const finish=await beginOperation(env);try{return await work();}finally{await finish();}}
