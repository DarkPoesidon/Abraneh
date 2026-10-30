const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),{build}=require('esbuild'),{randomBytes,webcrypto}=require('node:crypto'),vm=require('node:vm');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
let compiled,source,target,owner,other,room,socket,snapshotId,backup;
async function runtime(name){const options={name,modules:true,script:compiled,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],d1Databases:{DB:name},durableObjects:{CHAT_ROOM:{className:'ChatRoom',useSQLite:true}},bindings:{JWT_SECRET:randomBytes(48).toString('hex'),TELEGRAM_KEY:'a'.repeat(64)}};const mf=new Miniflare(convertV4MiniflareOptions(options)),db=await mf.getD1Database('DB');for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();return{mf,db,options};}
async function api(runtime,path,{user=owner,body,method='GET'}={}){const response=await runtime.mf.dispatchFetch('https://restored-chat.test-account.workers.dev'+path,{method:body===undefined?method:method==='GET'?'POST':method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
before(async()=>{
 require('node:child_process').execFileSync(process.execPath,['scripts/build-installer.mjs'],{stdio:'pipe'});
 compiled=(await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],external:['cloudflare:workers']})).outputFiles[0].text;
 source=await runtime('backup-source');target=await runtime('backup-target');
 owner=(await api(source,'/api/auth/register',{user:null,body:{username:'backupowner',password:'backuppass123'}})).data;
 other=(await api(source,'/api/auth/register',{user:null,body:{username:'backupother',password:'backuppass123'}})).data;
 await source.db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(owner.user.id).run();
 await source.db.prepare("INSERT INTO site_settings VALUES ('call_turn','opaque-test-configuration')").run();
 room=(await api(source,'/api/chats',{body:{targetUserId:other.user.id}})).data.id;
 const response=await source.mf.dispatchFetch('https://source.test/ws?chatId='+room+'&token='+owner.token,{headers:{Upgrade:'websocket'}});socket=response.webSocket;socket.accept();
 const saved=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Message not acknowledged')),5000);socket.addEventListener('message',e=>{if(JSON.parse(e.data).event==='new_message'){clearTimeout(timer);resolve();}});});socket.send(JSON.stringify({action:'send_message',chatId:room,text:'تاریخچهٔ اصلی برای بازیابی',clientMsgId:'backup-message'}));await saved;
});
after(async()=>{socket?.close();await Promise.all([source?.mf.dispose(),target?.mf.dispose()]);});
test('snapshot requires owner reauthentication, waits for leases and freezes REST/websocket mutations',async()=>{
 assert.equal((await api(source,'/api/service/backup/start',{user:other,body:{password:'backuppass123'}})).status,403);
 assert.equal((await api(source,'/api/service/backup/start',{body:{password:'wrong'}})).status,403);
 const start=await api(source,'/api/service/backup/start',{body:{password:'backuppass123'}});assert.equal(start.status,200);snapshotId=start.data.id;
 let ready=false;for(let i=0;i<50;i++){ready=(await api(source,'/api/service/backup/status?id='+snapshotId)).data.ready;if(ready)break;await wait(20);}assert.ok(ready);
 assert.equal((await api(source,'/api/chats',{body:{targetUserId:other.user.id}})).status,503);
 const rejected=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Maintenance reply missing')),5000);socket.addEventListener('message',e=>{const event=JSON.parse(e.data);if(event.clientMsgId==='paused-message'){clearTimeout(timer);resolve(event);}});});socket.send(JSON.stringify({action:'send_message',chatId:room,text:'must stay queued',clientMsgId:'paused-message'}));assert.equal((await rejected).retryable,true);
 assert.equal((await source.db.prepare('SELECT count(*) AS n FROM messages').first()).n,1);
});
test('portable snapshot includes authoritative room SQLite and app keys but excludes sessions and runtime metadata',async()=>{
 const manifest=await api(source,'/api/service/backup/manifest?id='+snapshotId);assert.equal(manifest.status,200,JSON.stringify(manifest));assert.ok(!manifest.data.tables.includes('service_operations'));assert.ok(!manifest.data.tables.includes('user_sessions'));assert.ok(!manifest.data.tables.includes('schema_migrations'));
 backup={format:1,appVersion:manifest.data.appVersion,tables:{},rooms:{},secrets:manifest.data.secrets};
 async function page(table,chat){const data={columns:[],rows:[]};let offset=0;while(true){const response=await api(source,`/api/service/backup/page?id=${snapshotId}&table=${table}&offset=${offset}${chat?'&room='+chat:''}`);assert.equal(response.status,200,JSON.stringify(response));data.columns=response.data.columns;data.rows.push(...response.data.rows);offset+=response.data.scanned;if(offset>=response.data.total)break;}return data;}
 for(const table of manifest.data.tables)backup.tables[table]=await page(table);
 for(const id of manifest.data.rooms){backup.rooms[id]={};for(const table of manifest.data.roomTables)backup.rooms[id][table]=await page(table,id);}
 assert.equal(backup.secrets.JWT_SECRET,source.options.bindings.JWT_SECRET);assert.ok(!Object.hasOwn(backup.secrets,'CF_TOKEN'));assert.equal(backup.rooms[room].messages.rows.length,1);assert.equal((await api(source,'/api/service/backup/end?id='+snapshotId,{body:{}})).status,200);
 assert.equal((await api(source,'/api/chats')).status,200);
});
test('browser backup encryption rejects wrong passwords and tampering without changing the snapshot',async()=>{
 const context={window:{},crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')};vm.runInNewContext(readFileSync('public/backup.js','utf8'),context);const helper=context.window.WihmBackup;
 const encrypted=await helper.encrypt(backup,'independent backup password');assert.ok(!JSON.stringify(encrypted).includes(backup.secrets.JWT_SECRET));assert.deepEqual(JSON.parse(JSON.stringify(await helper.decrypt(JSON.stringify(encrypted),'independent backup password'))),backup);
 await assert.rejects(helper.decrypt(JSON.stringify(encrypted),'wrong password'));encrypted.ciphertext=(encrypted.ciphertext[0]==='A'?'B':'A')+encrypted.ciphertext.slice(1);await assert.rejects(helper.decrypt(JSON.stringify(encrypted),'independent backup password'));
});
test('actual installer helper restores all D1/DO data into a fresh worker and never revives old sessions',async()=>{
 const {restoreBackup}=await import('../installer/backup.mjs');await target.db.prepare('CREATE TABLE wihm_installation(id INTEGER PRIMARY KEY,app TEXT,worker_name TEXT)').run();await target.db.prepare("INSERT INTO wihm_installation VALUES (1,'wihm-cloudflare-v2','restored-chat')").run();
 const secrets={},cloud={async request(path,options){
  if(path.endsWith('/settings'))return{result:{bindings:[{name:'WIHM_INSTALLER',text:'wihm-cloudflare-v2'},{name:'WIHM_VERSION',text:backup.appVersion},{name:'DB',type:'d1',id:'target-db'},{name:'CHAT_ROOM',type:'durable_object_namespace',class_name:'ChatRoom'}]}};
  if(path.endsWith('/workers/subdomain'))return{result:{subdomain:'test-account'}};
  if(path.endsWith('/secrets')){secrets[options.json.name]=options.json.text;return{result:{}};}
  if(path.endsWith('/secrets/RESTORE_TOKEN')){delete secrets.RESTORE_TOKEN;return{result:{}};}throw Error('Unexpected API path');
 },async query(_account,_db,sql,params=[]){return[await target.db.prepare(sql).bind(...params).all()];}};
 let installed=false;const fetcher=async(url,options)=>{if(!installed){target.options.bindings={...target.options.bindings,...secrets};await target.mf.setOptions(convertV4MiniflareOptions(target.options));target.db=await target.mf.getD1Database('DB');installed=true;}const response=await target.mf.dispatchFetch(url,options);if(!response.ok)console.error(new URL(url).pathname,response.status,await response.clone().text());return response;};
 const restored=await restoreBackup({api:cloud,accountId:'a'.repeat(32),name:'restored-chat',backup,payloadDir:'dist/WIHM-Installer/payload',fetcher});assert.equal(restored.restored,true);assert.equal(secrets.RESTORE_TOKEN,undefined);
 assert.equal((await api(target,'/api/profile')).status,401);assert.equal((await target.db.prepare('SELECT count(*) AS n FROM users').first()).n,2);
 assert.equal(await target.db.prepare("SELECT 1 FROM site_settings WHERE key='call_turn'").first(),null,'Restore must not revive paid TURN credentials');
 const login=await api(target,'/api/auth/login',{user:null,body:{username:'backupowner',password:'backuppass123'}});assert.equal(login.status,200,JSON.stringify(login));const history=await api(target,`/api/chats/${room}/messages`,{user:login.data});assert.equal(history.status,200);assert.equal(history.data[0].text,'تاریخچهٔ اصلی برای بازیابی');
 assert.equal((await restoreBackup({api:cloud,accountId:'a'.repeat(32),name:'restored-chat',backup,payloadDir:'dist/WIHM-Installer/payload',fetcher})).restored,true);assert.equal((await api(target,'/api/profile',{user:login.data})).status,200,'Retry after finish must preserve new sessions');
});
