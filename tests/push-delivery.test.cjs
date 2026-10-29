const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{createECDH,randomBytes}=require('node:crypto'),{build}=require('esbuild'),{Miniflare,convertV4MiniflareOptions,Response}=require('miniflare');
const vapid=createECDH('prime256v1'),receiver=createECDH('prime256v1');vapid.generateKeys();receiver.generateKeys();
let mf,db,sender,recipient,status=201;const calls=[],sockets=[];
async function api(path,body,user=recipient){const response=await mf.dispatchFetch('https://app.test'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
before(async()=>{
 const compiled=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'push-delivery'},durableObjects:{CHAT_ROOM:{className:'ChatRoom',useSQLite:true}},bindings:{JWT_SECRET:randomBytes(32).toString('hex'),VAPID_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url')},outboundService:async request=>{assert.equal(new URL(request.url).hostname,'fcm.googleapis.com');calls.push({encoding:request.headers.get('content-encoding'),bytes:(await request.arrayBuffer()).byteLength});assert.ok(calls.at(-1).bytes<1024,'Provider must receive compact encrypted bytes');return new Response('never echo provider secrets',{status});}}));
 db=await mf.getD1Database('DB');for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 sender=(await api('/api/auth/register',{username:'sender',password:'testpass123'},null)).data;recipient=(await api('/api/auth/register',{username:'recipient',password:'testpass123'},null)).data;
 await db.prepare('INSERT INTO user_profiles(user_id,notifications) VALUES (?,1)').bind(recipient.user.id).run();
 await api('/api/push',{endpoint:'https://fcm.googleapis.com/fcm/send/device',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}});
});
after(async()=>{for(const socket of sockets)socket.close();await mf?.dispose();});
test('a real message travels through its room alarm to the Workers fetch push transport',async()=>{
 const room=await api('/api/chats',{targetUserId:recipient.user.id},sender);assert.equal(room.status,201);
 const response=await mf.dispatchFetch('https://app.test/ws?chatId='+room.data.id+'&token='+sender.token,{headers:{Upgrade:'websocket'}});assert.equal(response.status,101);const ws=response.webSocket;ws.accept();sockets.push(ws);
 ws.send(JSON.stringify({action:'send_message',chatId:room.data.id,text:'آزمون مسیر واقعی صف اعلان',clientMsgId:'alarm-push-test'}));
 const end=Date.now()+12_000;while(!calls.length&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert.equal(calls.length,1);assert.equal(calls[0].encoding,'aes128gcm');assert.ok(calls[0].bytes>80);
});
test('push diagnostics distinguishes accepted, rejected and expired delivery without exposing provider data',async()=>{
 assert.equal((await api('/api/push/test',{},sender)).status,409);
 const accepted=await api('/api/push/test',{});assert.equal(accepted.status,200);assert.equal(accepted.data.accepted,true);
 status=503;const rejected=await api('/api/push/test',{});assert.equal(rejected.status,502);assert.match(rejected.data.error,/503/);assert.ok(!JSON.stringify(rejected.data).includes('provider secrets'));
 status=410;assert.equal((await api('/api/push/test',{})).status,409);assert.equal((await api('/api/push/test',{})).status,409);
});
