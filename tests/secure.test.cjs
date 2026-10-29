const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {randomUUID,randomBytes,generateKeyPairSync,sign,createHash,createHmac,createPrivateKey,createECDH}=require('node:crypto');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions,Response}=require('miniflare');
const servers=[],origins=['https://alpha.network.workers.dev','https://beta.network.workers.dev'];let offline=false,pushBroken=false;const vapid=createECDH('prime256v1');vapid.generateKeys();const calls=[];
const data=e=>JSON.stringify(['wihm-mls/1',e.id,e.thread,e.from,e.fromDevice,e.to,e.toDevice,e.kind,e.payload,e.senderKey]);
const deviceData=(who,id,kp)=>JSON.stringify(['wihm-device/1',who,id,kp]);
const hash=text=>createHash('sha256').update(text).digest('base64');
const keypair=()=>{const pair=generateKeyPairSync('ed25519');return {...pair,key:Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url').toString('base64')};};
async function api(i,path,{user='alice',method='GET',body,headers={}}={}){
 const response=await servers[i].mf.dispatchFetch(origins[i]+path,{method:body===undefined?method:method==='GET'?'POST':method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+servers[i].users[user].token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};
}
async function register(i,user){
 const pair=keypair(),device=randomUUID(),who=user+'@'+new URL(origins[i]).hostname,keyPackage=Buffer.concat([Buffer.from([0,1,0,5]),randomBytes(100)]).toString('base64'),signature=sign(null,Buffer.from(deviceData(who,device,keyPackage)),pair.privateKey).toString('base64');
 const result=await api(i,'/api/secure/devices',{user,body:{device,identityKey:pair.key,keyPackage,signature}});assert.equal(result.status,200,JSON.stringify(result));return {...pair,device,who,keyPackage,signature};
}
function event(from,to,overrides={}){
 const e={id:randomUUID(),thread:randomUUID(),from:from.who,fromDevice:from.device,to:to.who,toDevice:to.device,kind:'message',payload:Buffer.concat([Buffer.from([0,1,0,2]),randomBytes(64)]).toString('base64'),senderKey:from.key,...overrides};e.signature=sign(null,Buffer.from(data(e)),from.privateKey).toString('base64');return e;
}
before(async()=>{
 const compiled=await build({stdin:{contents:`import {publicSecure,handleSecure,scheduledSecure} from './src/secure.ts'; import {requestIdentity} from './src/sessions.ts'; import {InputError,jsonResponse} from './src/http.ts'; export default {async fetch(r,e){try{if(new URL(r.url).pathname==='/test/tick'){await scheduledSecure(e);return jsonResponse({ok:true});}const p=await publicSecure(r,e);if(p)return p;const auth=await requestIdentity(r,e);if(!auth)return jsonResponse({error:'auth'},401);return await handleSecure(r,e,auth)||jsonResponse({error:'missing'},404);}catch(x){return jsonResponse({error:x instanceof InputError?x.message:'internal'},x instanceof InputError?x.status:500);}}};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral', mainFields:['browser','module','main'],external:['cloudflare:workers']});
 for(let i=0;i<2;i++){
  const secret=randomBytes(32).toString('hex'),mf=new Miniflare(convertV4MiniflareOptions({name:'secure-'+i,modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'secure-'+i},bindings:{JWT_SECRET:secret,VAPID_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url')},outboundService:async r=>{calls.push({url:r.url,headers:Object.fromEntries(r.headers),body:await r.clone().text()});if(new URL(r.url).hostname==='fcm.googleapis.com')return new Response(null,{status:pushBroken?413:201});if(offline)return new Response(null,{status:503});const index=origins.indexOf(new URL(r.url).origin);if(index===-1)return Response.json({error:'missing'},{status:404});return servers[index].mf.dispatchFetch(r.url,{method:r.method,headers:r.headers,...(r.method==='GET'?{}:{body:await r.text()})});}}));
  const db=await mf.getD1Database('DB');servers.push({mf,db,users:{}});
  for(const file of ['schema.sql','migrations/0007_secure_federation.sql'])for(const sql of readFileSync(file,'utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const username of ['alice','bob','mallory','carol','dave']){
   const id=randomUUID(),sid=randomUUID(),now=Date.now();await db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').bind(id,username,'hash','salt',username,now).run();await db.prepare('INSERT INTO discovery_profiles VALUES (?,1)').bind(id).run();await db.prepare('INSERT INTO user_sessions VALUES (?,?,?,?,?,NULL)').bind(sid,id,'test',now,now+86400000).run();
   const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),claims=Buffer.from(JSON.stringify({userId:id,username,displayName:username,sid,exp:Math.floor(now/1000)+86400})).toString('base64url'),sig=createHmac('sha256',secret).update(header+'.'+claims).digest('base64url');servers[i].users[username]={id,token:header+'.'+claims+'.'+sig};
  }
  await db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(servers[i].users.alice.id).run();
  servers[i].alice=await register(i,'alice');servers[i].bob=await register(i,'bob');
 }
});
after(async()=>{await Promise.all(servers.map(s=>s.mf.dispose()));});
test('isolated mailbox accepts signed opaque payloads idempotently, rejects tamper and wrong users, and never writes legacy messages',async()=>{
 const e=event(servers[0].alice,servers[0].bob),first=await api(0,'/api/secure/send',{body:e});assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.data.queued,false);assert.equal((await api(0,'/api/secure/send',{body:e})).status,200);
 const inbox=await api(0,'/api/secure/inbox?device='+servers[0].bob.device,{user:'bob'});assert.equal(inbox.data.events.length,1);assert.deepEqual(inbox.data.events[0].envelope,e);
 assert.equal((await api(0,'/api/secure/inbox?device='+servers[0].bob.device)).status,403);
 assert.equal((await api(0,'/api/secure/send',{user:'mallory',body:e})).status,403);
 assert.equal((await api(0,'/api/secure/send',{body:{...e,payload:Buffer.from([0,1,0,2,1,2,3,4,5]).toString('base64')}})).status,403);
 assert.equal((await api(0,'/api/secure/send',{body:{...e,text:'accidental plaintext'}})).status,400);
 assert.equal((await api(0,'/api/secure/send',{body:event(servers[0].alice,servers[0].bob,{id:e.id})})).status,409);
 assert.equal((await servers[0].db.prepare('SELECT count(*) AS n FROM messages').first()).n,0);
 assert.equal((await servers[0].db.prepare('SELECT count(*) AS n FROM secure_events').first()).n,1);
});
test('device keys are immutable, account-bound and revoked device cannot send, receive or be rediscovered',async()=>{
 const device=await register(0,'mallory'),e=event(device,servers[0].bob);
 assert.equal((await api(0,'/api/secure/devices',{user:'mallory',body:{device:device.device,identityKey:device.key,keyPackage:device.keyPackage,signature:device.signature}})).status,200);
 const replacement=keypair(),keyPackage=Buffer.concat([Buffer.from([0,1,0,5]),randomBytes(100)]).toString('base64'),signature=sign(null,Buffer.from(deviceData(device.who,device.device,keyPackage)),replacement.privateKey).toString('base64');
 assert.equal((await api(0,'/api/secure/devices',{user:'mallory',body:{device:device.device,identityKey:replacement.key,keyPackage,signature}})).status,409);
 assert.equal((await api(0,'/api/secure/devices',{user:'bob',method:'DELETE',body:{device:device.device}})).status,200);
 assert.equal((await api(0,'/api/secure/send',{user:'mallory',body:e})).status,200,'other user cannot revoke');
 assert.equal((await api(0,'/api/secure/devices',{user:'mallory',method:'DELETE',body:{device:device.device}})).status,200);
 assert.equal((await api(0,'/api/secure/send',{user:'mallory',body:event(device,servers[0].bob)})).status,403);
 assert.equal((await api(0,'/api/secure/inbox?device='+device.device,{user:'mallory'})).status,403);
});
test('independent servers connect automatically without administrator pairing and pin their HTTPS identity',async()=>{
 const keys=await api(0,'/api/secure/keys',{body:{address:servers[1].bob.who}});assert.equal(keys.status,200,JSON.stringify(keys));assert.equal(keys.data.devices[0].identityKey,servers[1].bob.key);
 assert.equal((await servers[0].db.prepare('SELECT count(*) AS n FROM secure_peer_keys').first()).n,1);
 assert.equal((await servers[1].db.prepare('SELECT count(*) AS n FROM secure_peer_keys').first()).n,1);
 assert.equal((await api(0,'/api/secure/keys',{body:{address:'bob@127.0.0.1'}})).status,400);
 for(let i=0;i<2;i++)servers[i].settings=(await api(i,'/api/service/federation')).data;
 for(let i=0;i<2;i++){
  const peers={[new URL(origins[1-i]).hostname]:servers[1-i].settings.publicKey};
  assert.equal((await api(i,'/api/service/federation',{method:'PATCH',body:{enabled:true,origin:origins[i],peers}})).status,200);
  assert.equal((await api(i,'/api/service/federation',{user:'bob'})).status,403);
  for(const origin of ['http://'+new URL(origins[i]).hostname,'https://127.0.0.1','https://evil.network.workers.dev','https://'+new URL(origins[i]).hostname+'/path'])assert.equal((await api(i,'/api/service/federation',{method:'PATCH',body:{enabled:true,origin,peers}})).status,400);
 }
 assert.equal((await api(0,'/api/secure/keys',{body:{address:'bob@unavailable.org'}})).status,502);
 assert.ok(!JSON.stringify((await api(0,'/api/service/federation')).data).includes('privateKey'));assert.ok(calls.every(c=>!('authorization'in c.headers)&&!('cookie'in c.headers)));
});
test('remote device lookup respects personal privacy even when federation is enabled',async()=>{
 await servers[1].db.prepare('UPDATE discovery_profiles SET enabled=0 WHERE user_id=?').bind(servers[1].users.bob.id).run();
 const hidden=await api(0,'/api/secure/keys',{body:{address:servers[1].bob.who}});assert.equal(hidden.status,200);assert.deepEqual(hidden.data.devices,[]);
 await servers[1].db.prepare('UPDATE discovery_profiles SET enabled=1 WHERE user_id=?').bind(servers[1].users.bob.id).run();
});

test('remote messages deliver immediately and an alias preserves the canonical account identity',async()=>{
 const identity=await servers[0].mf.dispatchFetch('https://alias.network.workers.dev/api/secure/identity',{headers:{Authorization:'Bearer '+servers[0].users.alice.token}});
 assert.equal((await identity.json()).address,servers[0].alice.who);
 const e=event(servers[0].alice,servers[1].alice),sent=await api(0,'/api/secure/send',{body:e});assert.equal(sent.status,200);assert.equal(sent.data.queued,false);
 assert.equal((await servers[1].db.prepare('SELECT count(*) AS n FROM secure_events WHERE id=?').bind(e.id).first()).n,1);
 const stored=await servers[1].db.prepare("SELECT value FROM site_settings WHERE key='secure_server_keys'").first();
 const different=keypair();await servers[1].db.prepare("UPDATE site_settings SET value=? WHERE key='secure_server_keys'").bind(JSON.stringify({privateKey:different.privateKey.export({format:'jwk'}),publicKey:different.key})).run();
 const rejected=await api(1,'/api/secure/keys',{body:{address:servers[0].alice.who}});assert.equal(rejected.status,502,'Previously pinned identity cannot silently rotate');
 await servers[1].db.prepare("UPDATE site_settings SET value=? WHERE key='secure_server_keys'").bind(stored.value).run();
});

test('persistent federation retries after outage and accepts retry once without duplicate delivery or forged origin',async()=>{
 const e=event(servers[0].alice,servers[1].bob);offline=true;
 assert.equal((await api(0,'/api/secure/send',{body:e})).data.queued,true);assert.equal((await api(0,'/test/tick')).status,200);
 let status=await api(0,'/api/secure/delivery?id='+e.id);assert.equal(status.data.attempts,1);assert.equal(status.data.deliveredAt,null);
 assert.equal((await api(0,'/api/secure/delivery?id='+e.id,{user:'bob'})).status,404);
 offline=false;await servers[0].db.prepare('UPDATE secure_outbox SET next_attempt=0 WHERE id=?').bind(e.id).run();assert.equal((await api(0,'/test/tick')).status,200);
 status=await api(0,'/api/secure/delivery?id='+e.id);assert.ok(status.data.deliveredAt);
 const inbox=await api(1,'/api/secure/inbox?device='+servers[1].bob.device,{user:'bob'});assert.equal(inbox.data.events.length,1);assert.equal(inbox.data.events[0].envelope.id,e.id);
 const sent=calls.filter(c=>c.url.endsWith('/api/federation/inbox')).at(-1);delete sent.headers['content-length'];delete sent.headers.host;
 assert.equal((await api(1,'/api/federation/inbox',{user:null,body:e,headers:sent.headers})).status,409,'request nonce replay rejected');
 assert.equal((await api(1,'/api/federation/inbox',{user:null,body:{...e,to:servers[1].alice.who},headers:{...sent.headers,'x-wihm-nonce':randomUUID()}})).status,403,'body tamper rejected');
 assert.equal((await api(1,'/api/federation/inbox',{user:null,body:e,headers:{...sent.headers,'x-wihm-time':String(Date.now()-600000)}})).status,403,'expired request rejected');
 assert.equal((await api(1,'/api/federation/inbox',{user:null,body:e,headers:{...sent.headers,'x-wihm-origin':'https://evil.network.workers.dev'}})).status,502,'missing HTTPS identity rejected');
});
test('local and remote blocks and disabled accounts stop mailbox delivery without deleting history',async()=>{
 const remote=servers[0].alice,recipient=servers[1].bob;
 assert.equal((await api(1,'/api/secure/blocks',{user:'bob',body:{address:remote.who}})).status,200);
 const e=event(remote,recipient);await api(0,'/api/secure/send',{body:e});await api(0,'/test/tick');const row=await api(0,'/api/secure/delivery?id='+e.id);assert.equal(row.data.deliveredAt,null);
 await servers[0].db.prepare('INSERT INTO blocked_users VALUES (?,?,?)').bind(servers[0].users.bob.id,servers[0].users.alice.id,Date.now()).run();assert.equal((await api(0,'/api/secure/send',{body:event(servers[0].alice,servers[0].bob)})).status,404);
 await servers[0].db.prepare('INSERT INTO service_user_state VALUES (?,?,?)').bind(servers[0].users.alice.id,Date.now(),'test').run();assert.equal((await api(0,'/api/secure/devices')).status,401);
 assert.equal((await servers[1].db.prepare('SELECT count(*) AS n FROM secure_events WHERE owner_id=?').bind(servers[1].users.bob.id).first()).n,1);
});
test('real browser MLS clients verify devices, encrypt offline text and replies, reject tamper/replay, and recover history with new keys',async()=>{
 const {createSecureClient,fingerprint}=await import('../public/secure.js');
 const states=[null,null];let clientOffline=false;
 const clients=await Promise.all([0,1].map(i=>createSecureClient({address:(i?'dave':'carol')+'@'+new URL(origins[i]).hostname,storage:{load:async()=>structuredClone(states[i]),save:async state=>{states[i]=structuredClone(state);}},request:async(path,method,body)=>{if(clientOffline&&path==='/api/secure/send')throw Error('offline');const result=await api(i,path,{user:i?'dave':'carol',method,body});if(result.status>=400)throw Error(result.data.error);return result.data;}})));
 const [a,b]=await Promise.all(clients.map(c=>c.init()));
 const peer='dave@'+new URL(origins[1]).hostname,devices=await clients[0].lookup(peer),target=devices[0];assert.equal(target.device,b.device);
 const next=await clients[0].lookup(peer);assert.notEqual(next[0].keyPackage,target.keyPackage,'server atomically claims a fresh one-time prekey');
 for(let i=0;i<8;i++)await clients[0].lookup(peer);assert.equal((await clients[0].lookup(peer)).length,0);await clients[1].sync();assert.equal((await clients[0].lookup(peer)).length,1,'recipient replenishes consumed public prekeys without discarding pending private prekeys');
 await assert.rejects(clients[0].start(peer,target),/اثر/);
 await assert.rejects(clients[0].trust(peer,target.device,target.identityKey,'wrong'),/اثر/);
 await clients[0].trust(peer,target.device,target.identityKey,await fingerprint(target.identityKey));
 const thread=await clients[0].start(peer,target);
 await assert.rejects(clients[0].start(peer,target),/قبلاً/,'single-use key package cannot be reused');
 clientOffline=true;const marker='TOP_SECRET_متن_خصوصی_12345';const first=await clients[0].send(thread,marker);await Promise.all([clients[0].send(thread,'second secret',first),clients[0].send(thread,'third secret')]);
 let sender=await clients[0].view();assert.equal(sender.queued,3);assert.ok(!JSON.stringify(states[0].outbox).includes(marker));
 clientOffline=false;await clients[0].sync();await api(0,'/test/tick');await clients[1].sync();let receiver=await clients[1].view();assert.equal(receiver.threads.length,0,'server cannot silently inject a device');assert.ok(receiver.pending.length>=1);
 const incoming=receiver.pending.find(e=>e.kind==='welcome');await clients[1].trust(incoming.from,incoming.fromDevice,incoming.senderKey,await fingerprint(incoming.senderKey));await clients[1].sync();receiver=await clients[1].view();
 assert.equal(receiver.threads[0].messages.length,3);assert.equal(receiver.threads[0].messages[0].text,marker);assert.equal(receiver.threads[0].messages[1].replyTo,first);
 assert.ok(!calls.slice(-20).some(c=>c.body.includes(marker)));const envelopes=await servers[1].db.prepare('SELECT envelope FROM secure_events WHERE owner_id=?').bind(servers[1].users.dave.id).all();assert.ok(!JSON.stringify(envelopes).includes(marker));
 const inbox=await api(1,'/api/secure/inbox?device='+b.device,{user:'dave'}),application=inbox.data.events.find(e=>e.envelope.kind==='message');
 states[1].pending.push({sequence:999,envelope:application.envelope});await clients[1].sync();assert.equal((await clients[1].view()).threads[0].messages.length,3,'replay cannot duplicate plaintext');
 const tampered={...application.envelope,id:randomUUID(),payload:Buffer.from([0,1,0,2,1,2,3,4,5]).toString('base64')};states[1].pending.push({sequence:1000,envelope:tampered});await clients[1].sync();assert.ok((await clients[1].view()).alerts.length);
 const validOuter={...application.envelope,id:randomUUID()},damaged=Buffer.from(validOuter.payload,'base64');damaged[damaged.length-1]^=1;validOuter.payload=damaged.toString('base64');validOuter.signature=sign(null,Buffer.from(data(validOuter)),createPrivateKey({key:Buffer.from(states[0].device.private,'base64'),format:'der',type:'pkcs8'})).toString('base64');
 assert.equal((await api(0,'/api/secure/send',{user:'carol',body:validOuter})).status,200);await api(0,'/test/tick');const alertsBefore=(await clients[1].view()).alerts.length;await clients[1].sync();receiver=await clients[1].view();assert.equal(receiver.threads[0].messages.length,3);assert.ok(receiver.alerts.length>alertsBefore,'MLS rejects tampered ciphertext even when outer envelope is signed');
 const recovery=await clients[1].exportRecovery('independent recovery passphrase');assert.ok(!recovery.includes(marker));await assert.rejects(clients[1].importRecovery(recovery,'incorrect password'),/رمز/);await assert.rejects(clients[0].importRecovery(recovery,'independent recovery passphrase'),/رمز/);
 await clients[1].importRecovery(recovery,'independent recovery passphrase');receiver=await clients[1].view();assert.notEqual(receiver.device,b.device);assert.equal(receiver.threads[0].archived,true);assert.equal(receiver.threads[0].messages[0].text,marker);assert.deepEqual(receiver.trusted,{});await assert.rejects(clients[1].send(thread,'cannot use old ratchet'),/اثر|فقط/);
 assert.equal((await api(1,'/api/secure/inbox?device='+b.device,{user:'dave'})).status,403,'recovery revokes old identity');
});

test('a failed secure push retries later without blocking another recipient',async()=>{
 const db=servers[1].db;await db.prepare('UPDATE secure_events SET notified_at=1').run();
 const receiver=createECDH('prime256v1');receiver.generateKeys();
 for(const username of ['alice','bob']){
  const userId=servers[1].users[username].id,sid=(await db.prepare('SELECT id FROM user_sessions WHERE user_id=? LIMIT 1').bind(userId).first()).id;
  await db.prepare('INSERT INTO user_profiles(user_id,notifications) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET notifications=1').bind(userId).run();
  await db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?,?)').bind('push-'+username,userId,sid,'https://fcm.googleapis.com/fcm/send/'+username,receiver.getPublicKey().toString('base64url'),randomBytes(16).toString('base64url'),1).run();
 }
 const a=event(servers[1].alice,servers[1].bob),b=event(servers[1].bob,servers[1].alice);
 await api(1,'/api/secure/send',{user:'alice',body:a});await api(1,'/api/secure/send',{user:'bob',body:b});
 pushBroken=true;await api(1,'/test/tick');
 const delayed=await db.prepare('SELECT notified_at,push_next_attempt FROM secure_events WHERE id=?').bind(a.id).first();assert.equal(delayed.notified_at,null);assert.ok(delayed.push_next_attempt>Date.now());
 pushBroken=false;await api(1,'/test/tick');assert.ok((await db.prepare('SELECT notified_at FROM secure_events WHERE id=?').bind(b.id).first()).notified_at);
 await db.prepare('UPDATE secure_events SET push_next_attempt=0 WHERE id=?').bind(a.id).run();await api(1,'/test/tick');assert.ok((await db.prepare('SELECT notified_at FROM secure_events WHERE id=?').bind(a.id).first()).notified_at);
});
