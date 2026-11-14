/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { DurableObject } from 'cloudflare:workers';
import { APP_VERSION } from './version.js';
import { downloadBundle, newer, sha256, validVersion } from './update-bundle.js';
import { CloudApi, migrateBundle, ownedMain, publishMain, publishUpdater, UpdaterEnv } from './update-engine.js';
import { inputJson, jsonResponse } from './http.js';

type Mode='notify'|'automatic'|'manual';
interface Latest {version:string;digest:string;notes:string;}
interface Job {version:string;digest:string;phase:'prepare'|'database'|'publish'|'verify'|'updater';state:'running'|'failed'|'done';attempt:number;updatedAt:number;error?:string;verifyChecks?:number;republished?:boolean;}
// Cloudflare can keep serving the old version for minutes after accepting an upload, and that is not a failure.
const VERIFY_EVERY_MS=20_000,VERIFY_CHECKS=30,REPUBLISH_AFTER=15;
const safeError=(error:any)=>/[\u0600-\u06ff]/.test(error?.message||'')?String(error.message).slice(0,400):'این مرحله کامل نشد؛ دوباره تلاش کنید. اطلاعات قبلی حذف نشده‌اند.';

export default {
  async fetch(request:Request,env:UpdaterEnv) {
    const supplied=request.headers.get('Authorization')||'';
    if(!env.UPDATER_AUTH||await sha256(supplied)!==await sha256('Bearer '+env.UPDATER_AUTH))return jsonResponse({error:'دسترسی به به‌روزرسان مجاز نیست.'},403);
    if(!env.CF_TOKEN&&!['/access','/status'].includes(new URL(request.url).pathname))return jsonResponse({error:'دسترسی انتشار تنظیم نیست؛ کد دسترسی تازه را از تنظیمات به‌روزرسانی ثبت کنید.'},503);
    return env.MANAGER.get(env.MANAGER.idFromName('installation')).fetch(request);
  },
};

export class UpdateManager extends DurableObject<UpdaterEnv> {
  private busy=false;
  async status() {
    const mode=await this.ctx.storage.get<Mode>('mode')||'notify',latest=await this.ctx.storage.get<Latest>('latest'),job=await this.ctx.storage.get<Job>('job');
    return {configured:true,updaterVersion:APP_VERSION,mode,latest:latest?{version:latest.version,notes:latest.notes}:null,checkedAt:await this.ctx.storage.get<number>('checkedAt')||0,error:await this.ctx.storage.get<string>('checkError')||null,job:job?{version:job.version,phase:job.phase,state:job.state,attempt:job.attempt,updatedAt:job.updatedAt,error:job.error||null}:null};
  }
  async queue(latest:Latest) {
    const job=await this.ctx.storage.get<Job>('job');
    if(job?.state==='running')throw new Error('به‌روزرسانی دیگری در حال اجراست.');
    const next:Job=job?.state==='failed'&&job.version===latest.version&&job.digest===latest.digest?{...job,state:'running',attempt:0,error:undefined,verifyChecks:0,updatedAt:Date.now()}:{version:latest.version,digest:latest.digest,phase:'prepare',state:'running',attempt:0,updatedAt:Date.now()};
    await this.ctx.storage.transaction(async txn=>{await txn.put('job',next);await txn.setAlarm(Date.now()+100);});
  }
  async fetch(request:Request) {
    const path=new URL(request.url).pathname;
    if(path==='/status'&&request.method==='GET')return jsonResponse(await this.status());
    if(request.method!=='POST'||!['/check','/apply','/mode','/access'].includes(path))return jsonResponse({error:'یافت نشد.'},404);
    if(this.busy)return jsonResponse({error:'در حال بررسی نسخه هستیم؛ کمی صبر کنید.'},409);
    this.busy=true;
    try {
      const body=await inputJson(request);
      if(path==='/access'){
        if(typeof body.token!=='string'||!/^[A-Za-z0-9_-]{20,256}$/.test(body.token))return jsonResponse({error:'کد دسترسی کلادفلر معتبر نیست.'},400);
        const job=await this.ctx.storage.get<Job>('job');
        if(job?.state==='running'&&!/HTTP (401|403)/.test(job.error||''))return jsonResponse({error:'به‌روزرسانی در حال اجراست؛ پس از پایان آن دسترسی را تغییر دهید.'},409);
        const api=new CloudApi({...this.env,CF_TOKEN:body.token});await ownedMain(api);
        const settings=await api.settings(this.env.UPDATER_NAME),installed=settings.bindings?.find((b:any)=>b.name==='WIHM_UPDATER_VERSION')?.text;
        if(!validVersion(installed)||newer(installed,APP_VERSION))throw new Error('به‌روزرسان تغییر کرده است؛ صفحه را دوباره باز و تلاش کنید.');
        const {bundle}=await downloadBundle(APP_VERSION);await publishUpdater(api,bundle,body.token);await this.ctx.storage.put('checkError','');return jsonResponse({ok:true});
      }
      if(path==='/mode'){
        if(!['notify','automatic','manual'].includes(body.mode))return jsonResponse({error:'حالت به‌روزرسانی معتبر نیست.'},400);
        await this.ctx.storage.put('mode',body.mode);
        const latest=await this.ctx.storage.get<Latest>('latest'),job=await this.ctx.storage.get<Job>('job');
        if(body.mode==='automatic'&&latest&&newer(latest.version,APP_VERSION)&&job?.version!==latest.version)await this.queue(latest);
        return jsonResponse(await this.status());
      }
      if(path==='/check'){
        const mode=await this.ctx.storage.get<Mode>('mode')||'notify',checked=await this.ctx.storage.get<number>('checkedAt')||0;
        const failed=!!await this.ctx.storage.get<string>('checkError');
        if((mode==='manual'&&!body.manual)||Date.now()-checked<(body.manual?60_000:failed?5*60_000:6*3600_000))return jsonResponse(await this.status());
        try {
          const {bundle,digest}=await downloadBundle();
          if(newer(bundle.minimumUpdaterVersion,APP_VERSION))throw new Error('این نسخه به به‌روزرسان جدیدتری نیاز دارد؛ راهنمای ارتقا را بررسی کنید.');
          const latest={version:bundle.version,digest,notes:bundle.notes};
          await this.ctx.storage.put({latest,checkedAt:Date.now(),checkError:''});
          const job=await this.ctx.storage.get<Job>('job');
          if(mode==='automatic'&&newer(bundle.version,APP_VERSION)&&job?.version!==bundle.version)await this.queue(latest);
        } catch(error){await this.ctx.storage.put({checkedAt:Date.now(),checkError:safeError(error)});}
        return jsonResponse(await this.status());
      }
      const latest=await this.ctx.storage.get<Latest>('latest'),job=await this.ctx.storage.get<Job>('job');
      if(!validVersion(body.version)||!latest||latest.version!==body.version||(!newer(body.version,APP_VERSION)&&!(job?.state==='failed'&&job.version===body.version)))return jsonResponse({error:'ابتدا نسخهٔ تازه را بررسی و همان نسخه را انتخاب کنید.'},409);
      await this.queue(latest);return jsonResponse(await this.status(),202);
    } catch(error){return jsonResponse({error:safeError(error)},400);} finally{this.busy=false;}
  }
  async alarm() {
    const job=await this.ctx.storage.get<Job>('job');if(!job||job.state!=='running')return;
    // Persist a recovery alarm before external I/O. An interrupted isolate can resume.
    await this.ctx.storage.setAlarm(Date.now()+60_000);
    try {
      const {bundle,digest}=await downloadBundle(job.version);
      if(digest!==job.digest)throw new Error('محتوای نسخهٔ انتخاب‌شده تغییر کرده است؛ عملیات متوقف شد.');
      if(newer(bundle.minimumUpdaterVersion,APP_VERSION))throw new Error('نسخهٔ به‌روزرسان برای این بسته کافی نیست.');
      const api=new CloudApi(this.env);
      if(job.phase==='prepare'){await ownedMain(api);job.phase='database';}
      else if(job.phase==='database'){await ownedMain(api);await migrateBundle(api,bundle);job.phase='publish';}
      else if(job.phase==='publish'){await publishMain(api,bundle,job.republished);job.phase='verify';}
      else if(job.phase==='verify'){
        const response=await this.env.MAIN.fetch('https://app.internal/api/health'),health=await response.json<any>().catch(()=>null);
        if(response.ok&&health?.app==='wihm-cloudflare'&&health.database&&health.version===job.version)job.phase='updater';
        else {
          const stale=health?.app==='wihm-cloudflare'&&health.version!==job.version,message=stale?'نسخهٔ تازه منتشر شد و کلادفلر در حال فعال‌کردن آن است؛ معمولاً چند دقیقه طول می‌کشد.':'نسخهٔ تازه منتشر شد ولی پاسخ سلامت آن هنوز کامل نیست؛ دوباره بررسی می‌شود.';
          job.verifyChecks=(job.verifyChecks||0)+1;
          if(job.verifyChecks>=VERIFY_CHECKS){job.attempt=4;throw new Error(stale?'کلادفلر نسخهٔ تازه را فعال نکرد؛ «تلاش دوباره» را بزنید.':'نسخهٔ تازه منتشر شد ولی دیتابیس یا پاسخ سلامت آن کامل نیست؛ «تلاش دوباره» را بزنید.');}
          // An upload Cloudflare accepted but never activated would otherwise wait here forever.
          if(stale&&job.verifyChecks===REPUBLISH_AFTER&&!job.republished){job.republished=true;job.phase='publish';}
          job.error=message;job.updatedAt=Date.now();
          await this.ctx.storage.transaction(async txn=>{await txn.put('job',job);await txn.setAlarm(Date.now()+VERIFY_EVERY_MS);});
          return;
        }
      } else {await publishUpdater(api,bundle);job.state='done';}
      job.updatedAt=Date.now();job.attempt=0;delete job.error;
      await this.ctx.storage.transaction(async txn=>{await txn.put('job',job);if(job.state==='running')await txn.setAlarm(Date.now()+100);else await txn.deleteAlarm();});
    } catch(error){job.attempt++;job.updatedAt=Date.now();job.error=safeError(error);if(job.attempt>=5)job.state='failed';await this.ctx.storage.transaction(async txn=>{await txn.put('job',job);if(job.state==='running')await txn.setAlarm(Date.now()+Math.min(15*60_000,30_000*2**job.attempt));else await txn.deleteAlarm();});}
  }
}
