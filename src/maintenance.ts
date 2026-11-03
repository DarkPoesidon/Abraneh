import { Env } from './types.js';
import { InputError } from './http.js';

// Runs on every request and websocket message, so it must only read: the free D1 plan allows 100,000 written rows a day.
export async function withOperation<T>(env:Env,work:()=>Promise<T>):Promise<T>{
  const stopped=await env.DB.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM service_control WHERE paused_until>?) OR EXISTS(SELECT 1 FROM service_restore WHERE state='importing')`).bind(Date.now()).first();
  if(stopped)throw new InputError('سرویس موقتاً برای پشتیبان یا بازیابی متوقف است؛ پیام در صف دستگاه می‌ماند. کمی بعد دوباره تلاش کنید.',503);
  return work();
}
