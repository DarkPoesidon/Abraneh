import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { APP_MARKER, validAccount, validName } from './deploy.mjs';
import { CloudflareError } from './cloudflare.mjs';

const excluded = new Set(['service_control','service_operations','service_restore','user_sessions','session_security','security_challenges','rate_limits','schema_migrations','push_subscriptions','wihm_installation']);
const roomNames = new Set(['messages','message_keys','room_meta','sync_queue','message_details','message_reactions']);
const tokens = new Map(), active = new Set();
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact = (actual, expected) => actual.length === expected.length && [...actual].sort().every((value,index)=>value === [...expected].sort()[index]);
function check(condition, message = 'فایل پشتیبان یا فهرست ساختار آن معتبر نیست.') { if (!condition) throw new Error(message); }
function object(value, keys) { check(record(value) && exact(Object.keys(value),keys)); }
const quoted = name => '"' + name + '"';
function tableData(data, columns) {
  object(data,['columns','rows']);
  check(Array.isArray(data.columns) && data.columns.length === columns.length && data.columns.every((column,index)=>column === columns[index]));
  check(Array.isArray(data.rows) && data.rows.length <= 100_000);
  for (const row of data.rows) {
    check(Array.isArray(row) && row.length === columns.length && row.every(value=>value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)));
    check(Buffer.byteLength(JSON.stringify(row)) <= 256_000,'یک ردیف پشتیبان بیش از ظرفیت این نسخه است.');
  }
}
async function planFor(backup,payloadDir) {
  const [release,manifest] = await Promise.all(['release.json','backup-schema.json'].map(async file=>JSON.parse(await readFile(join(payloadDir,file),'utf8'))));
  check(record(manifest) && record(manifest.tables) && record(manifest.roomTables));
  const names=Object.keys(manifest.tables), roomTables=Object.keys(manifest.roomTables);
  check(names.includes('users') && names.includes('chats') && names.every(name=>identifier(name) && !excluded.has(name) && !name.startsWith('sqlite_')));
  check(exact(roomTables,[...roomNames]));
  for(const [name,table] of [...Object.entries(manifest.tables),...Object.entries(manifest.roomTables)]) {
    check(record(table) && Array.isArray(table.columns) && table.columns.length>0 && table.columns.length<100 && table.columns.every(identifier) && new Set(table.columns).size===table.columns.length);
    if(names.includes(name) && manifest.tables[name]===table) check(Array.isArray(table.dependencies) && table.dependencies.every(dependency=>names.includes(dependency)));
  }
  object(backup,['format','appVersion','tables','rooms','secrets']);
  check(backup.format===1 && /^\d+\.\d+\.\d+$/.test(release.appVersion) && backup.appVersion===release.appVersion,'نسخهٔ پشتیبان باید دقیقاً با این نصب‌کننده یکسان باشد.');
  check(record(backup.tables) && exact(Object.keys(backup.tables),names) && record(backup.rooms));
  const serialized=JSON.stringify(backup);
  check(Buffer.byteLength(serialized)<=32*1024*1024,'این نسخه حداکثر پشتیبان ۳۲ مگابایتی را بازیابی می‌کند.');
  for(const name of names) tableData(backup.tables[name],manifest.tables[name].columns);
  const chatIndex=manifest.tables.chats.columns.indexOf('id');
  check(chatIndex>=0);
  const chats=backup.tables.chats.rows.map(row=>row[chatIndex]);
  check(new Set(chats).size===chats.length && chats.every(chat=>typeof chat==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(chat)) && exact(Object.keys(backup.rooms),chats));
  for(const room of Object.values(backup.rooms)) {
    object(room,roomTables);
    for(const name of roomTables) tableData(room[name],manifest.roomTables[name].columns);
    const keyIndex=manifest.roomTables.room_meta.columns.indexOf('key');
    check(keyIndex>=0 && room.room_meta.rows.every(row=>row[keyIndex]!=='call-v1'),'وضعیت تماس زنده نباید در پشتیبان باشد.');
  }
  const counts={tables:Object.fromEntries(names.map(name=>[name,backup.tables[name].rows.length])),rooms:Object.entries(backup.rooms).map(([chatId,room])=>({chatId,counts:Object.fromEntries(roomTables.map(name=>[name,room[name].rows.length]))}))};
  check(Buffer.byteLength(JSON.stringify(counts))<=400_000,'تعداد گفتگوهای پشتیبان بیش از ظرفیت این نسخه است.');
  check(record(backup.secrets) && Object.keys(backup.secrets).every(name=>['JWT_SECRET','TELEGRAM_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY'].includes(name)));
  check(typeof backup.secrets.JWT_SECRET==='string' && Buffer.byteLength(backup.secrets.JWT_SECRET)>=32 && Buffer.byteLength(backup.secrets.JWT_SECRET)<=4096,'کلید امنیتی پشتیبان معتبر نیست.');
  if('TELEGRAM_KEY' in backup.secrets) check(typeof backup.secrets.TELEGRAM_KEY==='string' && /^[a-f0-9]{64}$/.test(backup.secrets.TELEGRAM_KEY));
  if(backup.tables.telegram_bots?.rows.length) check(backup.secrets.TELEGRAM_KEY,'کلید رمزگذاری ربات‌ها در پشتیبان نیست.');
  check(('VAPID_PUBLIC_KEY' in backup.secrets)===('VAPID_PRIVATE_KEY' in backup.secrets));
  for(const name of ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY']) if(name in backup.secrets) check(typeof backup.secrets[name]==='string' && /^[A-Za-z0-9_-]{20,200}$/.test(backup.secrets[name]));
  const order=[],visiting=new Set(),done=new Set();
  function visit(name) {
    if(done.has(name))return;
    check(!visiting.has(name),'فهرست وابستگی جدول‌ها معتبر نیست.');visiting.add(name);
    for(const dependency of manifest.tables[name].dependencies)if(dependency!==name)visit(dependency);
    visiting.delete(name);done.add(name);order.push(name);
  }
  names.forEach(visit);
  return {digest:createHash('sha256').update(serialized).digest('hex'),version:backup.appVersion,order,roomTables};
}
export async function validateBackup(backup,payloadDir) {
  const plan=await planFor(backup,payloadDir);
  return {digest:plan.digest,version:plan.version,tables:Object.fromEntries(plan.order.map(name=>[name,backup.tables[name].rows.length])),roomCount:Object.keys(backup.rooms).length};
}
function pages(rows,columns) {
  const pages=[];let page=[],size=0;
  for(const row of rows) {
    const bytes=Buffer.byteLength(JSON.stringify(row))+1;
    if(page.length && (page.length>=Math.floor(99/columns) || size+bytes>400_000)) {pages.push(page);page=[];size=0;}
    page.push(row);size+=bytes;
  }
  if(page.length)pages.push(page);
  return pages;
}
export async function restoreBackup({api,accountId,name,backup,payloadDir,fetcher=fetch,progress=()=>{}}) {
  // Validate a private snapshot before the first remote mutation, including on retries.
  backup=structuredClone(backup);
  const plan=await planFor(backup,payloadDir);
  check(validAccount(accountId) && validName(name),'نام یا حساب مقصد معتبر نیست.');
  const key=accountId+':'+name;
  check(!active.has(key),'بازیابی همین مقصد در حال انجام است.');active.add(key);
  try {
    const path=`/accounts/${accountId}/workers/scripts/${name}`,settings=(await api.request(path+'/settings')).result;
    const binding=name=>settings?.bindings?.find(row=>row.name===name);
    check(binding('WIHM_INSTALLER')?.text===APP_MARKER && binding('WIHM_VERSION')?.text===plan.version && binding('DB')?.type==='d1' && typeof binding('DB')?.id==='string' && binding('CHAT_ROOM')?.type==='durable_object_namespace' && binding('CHAT_ROOM')?.class_name==='ChatRoom','مقصد، نصب تازه و سازگار همین نصب‌کننده نیست.');
    const databaseId=binding('DB').id;
    const query=async(sql,params=[])=>{const result=await api.query(accountId,databaseId,sql,params);check(Array.isArray(result) && result.every(row=>row.success!==false),'اجرای بازیابی دیتابیس کامل نشد. دوباره تلاش کنید.');return result[0]?.results||[];};
    const ownership=(await query('SELECT app,worker_name FROM wihm_installation WHERE id=1'))[0];
    check(ownership?.app===APP_MARKER && ownership.worker_name===name,'مالکیت دیتابیس مقصد تأیید نشد.');
    const subdomain=(await api.request(`/accounts/${accountId}/workers/subdomain`)).result?.subdomain;
    check(typeof subdomain==='string' && /^[a-z0-9][a-z0-9-]*$/.test(subdomain),'نشانی مقصد معتبر نیست.');
    const url=`https://${name}.${subdomain}.workers.dev`;
    const marker=async()=>(await query('SELECT digest,state FROM service_restore WHERE id=1'))[0];
    const complete=async()=>{try{await api.request(path+'/secrets/RESTORE_TOKEN',{method:'DELETE'});}catch(error){if(!(error instanceof CloudflareError && error.status===404))throw error;}tokens.delete(key);return {url,verified:true,restored:true,version:plan.version,digest:plan.digest};};
    let saved=await marker();
    if(saved) {
      check(saved.digest===plan.digest && ['importing','complete'].includes(saved.state),'این مقصد به پشتیبان دیگری تعلق دارد؛ مقصد تازه انتخاب کنید.');
      if(saved.state==='complete')return await complete();
    } else {
      const empty=plan.order.map(table=>`NOT EXISTS(SELECT 1 FROM ${quoted(table)})`).join(' AND ');
      await query(`INSERT OR IGNORE INTO service_restore(id,digest,state,created_at) SELECT 1,?,'importing',? WHERE ${empty}`,[plan.digest,Date.now()]);
      saved=await marker();
      check(saved?.digest===plan.digest && saved.state==='importing','مقصد اطلاعات دارد؛ بازیابی فقط روی نصب تازه و خالی مجاز است.');
    }
    progress('restore-secrets');
    if(!tokens.has(key))tokens.set(key,randomBytes(32).toString('hex'));
    const restoreToken=tokens.get(key);
    for(const [name,text] of Object.entries({...backup.secrets,RESTORE_TOKEN:restoreToken}))await api.request(path+'/secrets',{method:'PUT',json:{name,text,type:'secret_text'}});
    const guard="EXISTS(SELECT 1 FROM service_restore WHERE id=1 AND digest=? AND state='importing')";
    progress('restore-database');
    for(const table of [...plan.order].reverse())await query(`DELETE FROM ${quoted(table)} WHERE ${guard}`,[plan.digest]);
    for(const table of plan.order) {
      const data=backup.tables[table],columns=data.columns.map(quoted).join(',');
      for(const rows of pages(data.rows,data.columns.length)) {
        const values=rows.map(row=>'('+row.map(()=>'?').join(',')+')').join(',');
        await query(`INSERT INTO ${quoted(table)}(${columns}) SELECT * FROM (VALUES ${values}) WHERE ${guard}`,[...rows.flat(),plan.digest]);
      }
      const count=(await query(`SELECT count(*) AS n FROM ${quoted(table)}`))[0]?.n;
      check(count===data.rows.length,'تعداد ردیف‌های بازیابی‌شده تأیید نشد؛ همان فایل را دوباره بازیابی کنید.');
    }
    const target=async(route,body)=>{
      let response;
      try{response=await fetcher(url+'/api/_restore/'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60_000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+restoreToken},body:JSON.stringify(body)});}catch{throw new Error('ارتباط با مقصد بازیابی کامل نشد؛ با همان فایل دوباره تلاش کنید.');}
      const result=await response.json().catch(()=>null);
      check(response.ok && result?.ok===true,'مقصد بازیابی را تأیید نکرد؛ با همان فایل دوباره تلاش کنید.');
      return result;
    };
    progress('restore-rooms');
    const rooms=[];
    for(const [chatId,room] of Object.entries(backup.rooms)) {
      const counts={};
      for(const table of plan.roomTables) {
        const data=room[table];let offset=0;
        const chunks=pages(data.rows,data.columns.length);
        for(const rows of (chunks.length?chunks:[[]])) {
          await target('room',{digest:plan.digest,chatId,table,columns:data.columns,rows,offset});offset+=rows.length;
        }
        counts[table]=offset;
      }
      rooms.push({chatId,counts});
    }
    progress('restore-verify');
    await target('finish',{digest:plan.digest,tables:Object.fromEntries(plan.order.map(name=>[name,backup.tables[name].rows.length])),rooms});
    const final=await marker();check(final?.digest===plan.digest && final.state==='complete','پایان بازیابی هنوز تأیید نشده است؛ با همان فایل دوباره تلاش کنید.');
    return await complete();
  } finally {active.delete(key);}
}
