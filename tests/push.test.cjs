const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createECDH,randomBytes,hkdfSync,createDecipheriv,createPublicKey,verify}=require('node:crypto');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
let mf,db;
const vapid=createECDH('prime256v1');vapid.generateKeys();
const receiver=createECDH('prime256v1');receiver.generateKeys();
const auth=randomBytes(16),endpoint='https://fcm.googleapis.com/fcm/send/test-private-endpoint';
before(async()=>{
  const compiled=await build({stdin:{contents:`import {sendPush,sendSecurePush,validPushEndpoint,validatePush} from './src/push.ts';
    export default {async fetch(request,env){
      const url=new URL(request.url);
      if(url.pathname==='/validate') {try{validatePush(await request.json());return Response.json({ok:true});}catch{return Response.json({ok:false},{status:400});}}
      const calls=[];const transport=async(endpoint,options)=>{calls.push({endpoint,headers:options.headers,body:[...options.body]});return new Response(null,{status:201});};if(url.searchParams.has('secure')){await sendSecurePush(env,'receiver','secure-thread','',transport);return Response.json(calls);}
      const cursor=await sendPush(env,{id:'message',chatId:'room',senderId:'sender',senderName:'فرستنده',text:'متن خصوصی فارسی',createdAt:1},async(endpoint,options)=>{
        calls.push({endpoint,headers:options.headers,body:[...options.body]});return new Response(null,{status:url.searchParams.has('gone')?410:201});},url.searchParams.get('after')||'',url.searchParams.has('call')?{callId:'incoming-call',expiresAt:Date.now()+45000,video:true}:undefined);
      return Response.json(url.searchParams.has('page')?{calls,cursor}:calls);
    }};`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'neutral', mainFields:['browser','module','main'],write:false});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:{DB:'push-test'},bindings:{VAPID_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url')}}));
  db=await mf.getD1Database('DB');
  for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.batch([
    db.prepare("INSERT INTO users VALUES ('sender','sender','h','s','فرستنده',1),('receiver','receiver','h','s','گیرنده',1)"),
    db.prepare("INSERT INTO chats VALUES ('room','dm',NULL,1,1)"),
    db.prepare("INSERT INTO chat_members(chat_id,user_id,joined_at) VALUES ('room','sender',1),('room','receiver',1)"),
    db.prepare("INSERT INTO user_sessions(id,user_id,label,created_at,expires_at) VALUES ('session','receiver','phone',1,?)").bind(Date.now()+3600000),
    db.prepare("INSERT INTO user_profiles(user_id,notifications) VALUES ('receiver',1)"),
    db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?,?)').bind('subscription','receiver','session',endpoint,receiver.getPublicKey().toString('base64url'),auth.toString('base64url'),1),
  ]);
});
after(async()=>mf?.dispose());
const trigger=async(suffix='')=>(await mf.dispatchFetch('http://localhost/'+suffix)).json();
test('incoming call push has a short lifetime and never exposes private message content',async()=>{
  const calls=await trigger('?call');const payload=decrypt(calls);
  assert.equal(payload.kind,'call');assert.equal(payload.callId,'incoming-call');assert.equal(payload.chatId,'room');
  assert.ok(payload.expiresAt>Date.now());assert.ok(Number(calls[0].headers.ttl)>0&&Number(calls[0].headers.ttl)<=45);
  assert.ok(!JSON.stringify(payload).includes('متن خصوصی'));assert.equal(payload.title,'تماس ورودی در ابرانه');
});
function decrypt(calls){
  const data=Buffer.from(calls[0].body),salt=data.subarray(0,16),senderKey=data.subarray(21,21+data[20]),ciphertext=data.subarray(21+data[20]);
  const ikm=hkdfSync('sha256',receiver.computeSecret(senderKey),auth,Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),senderKey]),32);
  const cek=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16),nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
  const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(ciphertext.subarray(-16));
  const plaintext=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);let end=plaintext.length-1;while(plaintext[end]===0)end--;assert.equal(plaintext[end],2);return JSON.parse(plaintext.subarray(0,end).toString());
}
test('Web Push uses decryptable RFC 8291 encryption and a verifiable VAPID signature, with preview hidden by default',async()=>{
  const calls=await trigger();assert.equal(calls.length,1);assert.equal(calls[0].endpoint,endpoint);assert.equal(calls[0].headers['content-encoding'],'aes128gcm');
  assert.ok(calls[0].body.length<1024,'Short notifications must not be padded to the push service limit');
  let payload=decrypt(calls);assert.equal(payload.chatId,'room');assert.ok(!payload.body.includes('متن خصوصی'));assert.ok(!payload.title.includes('فرستنده'));
  const jwt=calls[0].headers.authorization.match(/t=([^, ]+)/)[1],parts=jwt.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  assert.equal(claims.aud,'https://fcm.googleapis.com');
  const pub=vapid.getPublicKey();const publicKey=createPublicKey({key:{kty:'EC',crv:'P-256',x:pub.subarray(1,33).toString('base64url'),y:pub.subarray(33).toString('base64url')},format:'jwk'});
  assert.ok(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')));
  await db.prepare("UPDATE user_profiles SET notification_preview=1 WHERE user_id='receiver'").run();payload=decrypt(await trigger());assert.equal(payload.body,'متن خصوصی فارسی');
});
test('secure message notifications contain no plaintext or sender identity and respect account revocation',async()=>{
 const payload=decrypt(await trigger('?secure'));assert.equal(payload.kind,'secure');assert.equal(payload.chatId,'secure-thread');assert.ok(!JSON.stringify(payload).includes('متن خصوصی فارسی'));assert.equal(payload.title,'پیام امن تازه در ابرانه');
 await db.prepare("INSERT INTO service_user_state VALUES ('receiver',1,'disabled')").run();assert.equal((await trigger('?secure')).length,0);await db.prepare('DELETE FROM service_user_state').run();
});

test('muted chats, blocks, revoked or outdated sessions and removed membership never receive push; expired endpoints are removed',async()=>{
  for(const [set,reset] of [
    ["INSERT INTO chat_preferences(chat_id,user_id,muted) VALUES ('room','receiver',1)","DELETE FROM chat_preferences"],
    ["INSERT INTO blocked_users VALUES ('sender','receiver',1)","DELETE FROM blocked_users"],
    ["UPDATE user_sessions SET revoked_at=1","UPDATE user_sessions SET revoked_at=NULL"],
    ["INSERT INTO account_security VALUES ('receiver',2)","DELETE FROM account_security"],
    ["DELETE FROM chat_members WHERE user_id='receiver'","INSERT INTO chat_members(chat_id,user_id,joined_at) VALUES ('room','receiver',1)"],
  ]){await db.prepare(set).run();assert.equal((await trigger()).length,0,set);await db.prepare(reset).run();}
  assert.equal((await trigger('?gone')).length,1);assert.equal((await trigger()).length,0);
});
test('subscription validation rejects arbitrary destinations and invalid key material',async()=>{
  const subscription={endpoint,keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
  for(const bad of ['http://fcm.googleapis.com/test','https://localhost/test','https://fcm.googleapis.com.evil.test/test','https://name:password@fcm.googleapis.com/test','https://fcm.googleapis.com:444/test']){
    assert.equal((await mf.dispatchFetch('http://localhost/validate',{method:'POST',body:JSON.stringify({...subscription,endpoint:bad})})).status,400,bad);
  }
  assert.equal((await mf.dispatchFetch('http://localhost/validate',{method:'POST',body:JSON.stringify(subscription)})).status,200);
  assert.equal((await mf.dispatchFetch('http://localhost/validate',{method:'POST',body:JSON.stringify({...subscription,keys:{p256dh:'bad',auth:'bad'}})})).status,400);
});
test('large recipient sets resume by cursor in bounded pages without skipping or duplicating endpoints',async()=>{
  await db.prepare("UPDATE chats SET type='group',title='گروه' WHERE id='room'").run();
  await db.batch(Array.from({length:46},(_,i)=>db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?,?)').bind('batch-'+String(i).padStart(2,'0'),'receiver','session',endpoint+'-'+i,receiver.getPublicKey().toString('base64url'),auth.toString('base64url'),1)));
  const all=[];let cursor='';
  do {const result=await trigger('?page&after='+cursor);assert.ok(result.calls.length<=24);all.push(...result.calls.map(row=>row.endpoint));cursor=result.cursor;}while(cursor);
  assert.equal(all.length,46);assert.equal(new Set(all).size,46);
});
