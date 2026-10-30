const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const currentVersion=JSON.parse(readFileSync('package.json','utf8')).version;
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {generateKeyPairSync,sign,randomBytes}=require('node:crypto');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions,Response}=require('miniflare');
let manager,managerOptions,main,db,directory,owner,other,helpers;
const key=generateKeyPairSync('ed25519'),trust=key.publicKey.export({type:'spki',format:'der'}).toString('base64');
const shared='test-private-updater-auth',cloudToken='test-cloud-token-not-for-the-app';
const baseBundle={format:1,version:'2.0.0',minimumUpdaterVersion:'1.5.0',sourceCommit:'a'.repeat(40),notes:'نسخهٔ آزمایشی برای آزمون ارتقا',files:{'worker.mjs':Buffer.from('export default {}').toString('base64'),'updater.mjs':Buffer.from('export default {}').toString('base64'),'schema.sql':Buffer.from('CREATE TABLE IF NOT EXISTS example(id TEXT)').toString('base64'),'migrations/0001_example.sql':Buffer.from('CREATE TABLE IF NOT EXISTS extra(id TEXT)').toString('base64'),'public/index.html':Buffer.from('<html>دو</html>').toString('base64'),'public/sw.js':Buffer.from('self.version=2').toString('base64'),'public/fonts/Vazir-Variable.woff2':readFileSync('public/fonts/Vazir-Variable.woff2').toString('base64')}};
const renewedToken='replacement-cloud-token-only-for-updater';
let signed=Buffer.from(JSON.stringify(baseBundle)),signature=sign(null,signed,key.privateKey).toString('base64'),tamper=false,loseUpload=true,loseSelfUpload=true;
const state={mainVersion:currentVersion,updaterVersion:currentVersion,cloudCalls:[],mainUploads:[],updaterUploads:[],applied:new Set(),manifest:null};
const mainBindings=()=>[{name:'WIHM_INSTALLER',type:'plain_text',text:'wihm-cloudflare-v2'},{name:'WIHM_VERSION',type:'plain_text',text:state.mainVersion},{name:'DB',type:'d1',id:'same-database'},{name:'CHAT_ROOM',type:'durable_object_namespace',namespace_id:'same-rooms'},{name:'JWT_SECRET',type:'secret_text'},{name:'TELEGRAM_KEY',type:'secret_text'},{name:'VAPID_PRIVATE_KEY',type:'secret_text'},{name:'UPDATER',type:'service',service:'family-updates'},{name:'UPDATER_AUTH',type:'secret_text'}];
const success=result=>Response.json({success:true,result});
async function outgoing(request){
 const url=new URL(request.url);
 if(url.hostname==='github.com'){assert.equal(request.headers.get('Authorization'),null);if(url.pathname.includes(`/installer-v${currentVersion}/`)){const payload=Buffer.from(JSON.stringify({...baseBundle,version:currentVersion}));return new Response(url.pathname.endsWith('.sig')?sign(null,payload,key.privateKey).toString('base64'):payload);}if(url.pathname.endsWith('.sig'))return new Response(signature);return new Response(tamper?Buffer.concat([signed,Buffer.from(' ')]):signed);}
 assert.equal(url.hostname,'api.cloudflare.com');assert.ok(['Bearer '+cloudToken,'Bearer '+renewedToken,'Bearer upload-session'].includes(request.headers.get('Authorization')));
 const path=url.pathname.replace('/client/v4','');state.cloudCalls.push(path);
 if(path.endsWith('/family/settings'))return success({bindings:mainBindings()});
 if(path.endsWith('/family-updates/settings'))return success({bindings:[{name:'WIHM_UPDATER',type:'plain_text',text:'wihm-updater-v1'},{name:'WORKER_NAME',type:'plain_text',text:'family'},{name:'WIHM_UPDATER_VERSION',type:'plain_text',text:state.updaterVersion},{name:'MANAGER',type:'durable_object_namespace',namespace_id:'same-updater-object'},{name:'CF_TOKEN',type:'secret_text'},{name:'UPDATER_AUTH',type:'secret_text'}]});
 if(path.endsWith('/query')){const {sql,params}=await request.json();if(sql==='SELECT version FROM schema_migrations')return success([{success:true,results:[...state.applied].map(version=>({version}))}]);if(sql.startsWith('INSERT OR IGNORE INTO schema_migrations'))state.applied.add(params[0]);return success([{success:true,results:[]}]);}
 if(path.endsWith('/assets-upload-session')){state.manifest=(await request.json()).manifest;assert.ok(state.manifest['/fonts/Vazir-Variable.woff2']);return success({jwt:'upload-session',buckets:[[...new Set(Object.values(state.manifest).map(f=>f.hash))]]});}
 if(path.endsWith('/assets/upload')){assert.equal(url.searchParams.get('base64'),'true');const form=await request.formData();assert.ok([...form].length>=3);return success({jwt:'complete-assets'});}
 if(path.endsWith('/scripts/family')){const form=await request.formData(),metadata=JSON.parse(await form.get('metadata').text());state.mainUploads.push(metadata);state.mainVersion=metadata.bindings.find(b=>b.name==='WIHM_VERSION').text;if(loseUpload){loseUpload=false;throw Error('Connection lost AFTER accepting publication');}return success({id:'family'});}
 if(path.endsWith('/scripts/family-updates')){const form=await request.formData();const metadata=JSON.parse(await form.get('metadata').text());state.updaterUploads.push(metadata);state.updaterVersion=metadata.bindings.find(b=>b.name==='WIHM_UPDATER_VERSION').text;if(loseSelfUpload&&state.updaterVersion!==currentVersion){loseSelfUpload=false;throw Error('Connection lost AFTER accepting updater publication');}return success({id:'family-updates'});}
 throw Error('Unexpected mocked Cloudflare path '+path);
}
async function control(path,body,auth=shared){const response=await manager.dispatchFetch('https://internal'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let i=0;i<100;i++){const value=(await control('/status')).data;if(predicate(value))return value;await pause(50);}throw Error('Updater did not reach expected state: '+JSON.stringify((await control('/status')).data));}
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'wihm-update-state-'));
 const helper=await build({entryPoints:['src/update-bundle.ts'],bundle:true,write:false,format:'cjs',platform:'node'});const module={exports:{}};new Function('exports','module',helper.outputFiles[0].text)(module.exports,module);helpers=module.exports;
 const compiled=await build({stdin:{contents:`import handler,{UpdateManager} from './src/updater.ts';export class TestManager extends UpdateManager {async fetch(request){if(new URL(request.url).pathname==='/__test/expire-cache'){await this.ctx.storage.delete('checkedAt');return Response.json({ok:true});}if(new URL(request.url).pathname==='/__test/retry'){await this.ctx.storage.setAlarm(Date.now()+1);return Response.json({ok:true});}return super.fetch(request);}}export default handler;`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral', mainFields:['browser','module','main'],external:['cloudflare:workers'],plugins:[{name:'fixture-key',setup(build){build.onLoad({filter:/update-key\.ts$/},()=>({contents:`export const UPDATE_PUBLIC_KEY=${JSON.stringify(trust)};`,loader:'ts'}));}}]});
 managerOptions=convertV4MiniflareOptions({name:'update-runtime',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],durableObjects:{MANAGER:{className:'TestManager',useSQLite:true}},resourcePersistencePath:directory,bindings:{CF_TOKEN:cloudToken,ACCOUNT_ID:'a'.repeat(32),DATABASE_ID:'same-database',WORKER_NAME:'family',UPDATER_NAME:'family-updates',UPDATER_AUTH:shared},serviceBindings:{MAIN:async()=>Response.json({app:'wihm-cloudflare',database:true,version:state.mainVersion})},outboundService:outgoing});manager=new Miniflare(managerOptions);
 const app=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral', mainFields:['browser','module','main'],external:['cloudflare:workers']});
 main=new Miniflare(convertV4MiniflareOptions({name:'update-app',modules:true,script:app.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'update-app-db'},durableObjects:{CHAT_ROOM:{className:'ChatRoom',useSQLite:true}},bindings:{JWT_SECRET:randomBytes(32).toString('hex'),UPDATER_AUTH:shared},serviceBindings:{UPDATER:request=>{assert.equal(request.headers.get('Authorization'),'Bearer '+shared);return Response.json({configured:true,mode:'notify',latest:{version:'2.0.0',notes:'جدید'}});}}}));
 db=await main.getD1Database('DB');for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 async function account(username,ip){const response=await main.dispatchFetch('https://app.test/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({username,password:'testpass123'})});return response.json();}
 owner=await account('updateowner','198.51.100.1');other=await account('updateother','198.51.100.2');await db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(owner.user.id).run();
});
after(async()=>{await Promise.all([manager?.dispose(),main?.dispose()]);if(directory)await rm(directory,{recursive:true,force:true});});
test('release verification rejects changed bytes, untrusted signatures and path traversal before deployment',async()=>{
 assert.equal((await helpers.verifyBundle(signed,signature,trust)).version,'2.0.0');
 await assert.rejects(helpers.verifyBundle(Buffer.concat([signed,Buffer.from(' ')]),signature,trust),/امضای/);
 await assert.rejects(helpers.verifyBundle(signed,signature),/امضای/);
 const bad=Buffer.from(JSON.stringify({...baseBundle,files:{...baseBundle.files,'public/../secret.txt':'YQ=='}}));await assert.rejects(helpers.verifyBundle(bad,sign(null,bad,key.privateKey).toString('base64'),trust),/امضای/);
});
test('only the owner can control server upgrades; the private updater rejects unauthenticated requests',async()=>{
 assert.equal((await control('/status',undefined,'wrong')).status,403);
 const unauthorized=await main.dispatchFetch('https://app.test/api/service/updates');assert.equal(unauthorized.status,401);
 const denied=await main.dispatchFetch('https://app.test/api/service/updates',{headers:{Authorization:'Bearer '+other.token}});assert.equal(denied.status,403);
 const allowed=await main.dispatchFetch('https://app.test/api/service/updates',{headers:{Authorization:'Bearer '+owner.token}});assert.equal(allowed.status,200);assert.ok(!(await allowed.text()).includes(cloudToken));
});
test('expired publication access can be replaced inside the private updater without reinstalling or touching app secrets',async()=>{
 assert.equal((await control('/access',{token:'bad'})).status,400);const response=await control('/access',{token:renewedToken});assert.equal(response.status,200,JSON.stringify(response));assert.equal(state.mainUploads.length,0);assert.deepEqual(state.updaterUploads.at(-1).bindings.find(b=>b.name==='CF_TOKEN'),{name:'CF_TOKEN',type:'secret_text',text:renewedToken});assert.ok(!JSON.stringify((await control('/status')).data).includes(renewedToken));state.updaterUploads.length=0;
});
test('signed upgrade resumes after an accepted upload loses its response and never rotates secrets or databases',async()=>{
 const checked=await control('/check',{manual:true});assert.equal(checked.status,200);assert.equal(checked.data.latest.version,'2.0.0');assert.equal(checked.data.mode,'notify');assert.equal(checked.data.job,null);
 assert.equal((await control('/apply',{version:'2.0.0'})).status,202);
 const interrupted=await until(s=>s.job?.attempt===1);assert.equal(interrupted.job.phase,'publish',JSON.stringify({interrupted,calls:state.cloudCalls}));assert.ok(!JSON.stringify(interrupted).includes(cloudToken));
 await manager.dispose();manager=new Miniflare(managerOptions);const restored=(await control('/status')).data;assert.equal(restored.job.attempt,1);assert.equal(restored.job.phase,'publish');
 await control('/__test/retry',{});const selfInterrupted=await until(s=>s.job?.attempt===1&&s.job.phase==='updater');assert.equal(selfInterrupted.job.state,'running');await manager.dispose();manager=new Miniflare(managerOptions);await control('/__test/retry',{});const done=await until(s=>s.job?.state==='done');assert.equal(done.job.version,'2.0.0');assert.equal(state.mainUploads.length,1,'Do not republish after a lost response if the target version is already present');
 const metadata=state.mainUploads[0];assert.equal(metadata.migrations,undefined);assert.equal(metadata.bindings.find(b=>b.name==='DB').id,'same-database');assert.equal(metadata.bindings.find(b=>b.name==='CHAT_ROOM').namespace_id,'same-rooms');for(const name of ['JWT_SECRET','TELEGRAM_KEY','VAPID_PRIVATE_KEY','UPDATER_AUTH'])assert.deepEqual(metadata.bindings.find(b=>b.name===name),{name,type:'inherit'});
 assert.equal(state.updaterUploads.length,1);assert.deepEqual(state.updaterUploads[0].bindings.find(b=>b.name==='CF_TOKEN'),{name:'CF_TOKEN',type:'inherit'});assert.ok(!state.cloudCalls.some(path=>path.endsWith('/d1/database')));assert.ok(state.applied.has('0001_example.sql'));
});
test('automatic mode starts a known pending signed release without another confirmation',async()=>{
 signed=Buffer.from(JSON.stringify({...baseBundle,version:'3.0.0'}));signature=sign(null,signed,key.privateKey).toString('base64');
 await control('/__test/expire-cache',{});
 await control('/check',{manual:true});const automatic=await control('/mode',{mode:'automatic'});assert.equal(automatic.status,200);assert.equal(automatic.data.job.state,'running');assert.equal(automatic.data.job.version,'3.0.0');
 const done=await until(s=>s.job?.state==='done'&&s.job.version==='3.0.0');assert.equal(done.mode,'automatic');assert.equal(state.mainVersion,'3.0.0');

});
