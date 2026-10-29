const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createECDH,randomBytes,hkdfSync,createDecipheriv}=require('node:crypto');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions,Response}=require('miniflare');
let mf,db;const calls=[],vapid=createECDH('prime256v1'),receiver=createECDH('prime256v1'),auth=randomBytes(16);vapid.generateKeys();receiver.generateKeys();
before(async()=>{
 const source=await build({stdin:{contents:`import {sendUpdatePush} from './src/push.ts';export default {async fetch(request,env){return Response.json({cursor:await sendUpdatePush(env,'2.0.0')});}};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral', mainFields:['browser','module','main']});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:{DB:'notice-db'},bindings:{VAPID_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url')},outboundService:async request=>{assert.equal(new URL(request.url).hostname,'fcm.googleapis.com');calls.push({url:request.url,body:Buffer.from(await request.arrayBuffer()),encoding:request.headers.get('content-encoding')});return new Response(null,{status:201});}}));
 db=await mf.getD1Database('DB');for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 for(const id of ['owner','ordinary'])await db.batch([db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').bind(id,id,'h','s',id,1),db.prepare('INSERT INTO user_profiles(user_id,notifications) VALUES (?,1)').bind(id),db.prepare('INSERT INTO user_sessions(id,user_id,label,created_at,expires_at) VALUES (?,?,?,1,?)').bind(id+'-session',id,'test',Date.now()+3600000),db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?,?)').bind(id,id,id+'-session','https://fcm.googleapis.com/fcm/send/'+id,receiver.getPublicKey().toString('base64url'),auth.toString('base64url'),1)]);
 await db.prepare("INSERT INTO service_admins VALUES (1,'owner')").run();
});
after(async()=>mf?.dispose());
test('update notices reach only the owner via a real Workers fetch and decrypt to a safe update action',async()=>{
 await mf.dispatchFetch('http://localhost');assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/owner'));assert.equal(calls[0].encoding,'aes128gcm');
 const data=calls[0].body,salt=data.subarray(0,16),key=data.subarray(21,21+data[20]),ciphertext=data.subarray(21+data[20]);
 const ikm=hkdfSync('sha256',receiver.computeSecret(key),auth,Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),key]),32);
 const cek=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16),nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12),decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(ciphertext.subarray(-16));const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);let end=plain.length-1;while(plain[end]===0)end--;assert.equal(plain[end],2);const notice=JSON.parse(plain.subarray(0,end));assert.equal(notice.kind,'update');assert.match(notice.body,/2\.0\.0/);assert.equal(notice.chatId,undefined);
});
test('owner update notices respect notification preferences and revoked sessions',async()=>{
 calls.length=0;await db.prepare("UPDATE user_profiles SET notifications=0 WHERE user_id='owner'").run();await mf.dispatchFetch('http://localhost');assert.equal(calls.length,0);
 await db.prepare("UPDATE user_profiles SET notifications=1 WHERE user_id='owner'").run();await db.prepare("UPDATE user_sessions SET revoked_at=1 WHERE user_id='owner'").run();await mf.dispatchFetch('http://localhost');assert.equal(calls.length,0);
});
