const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {randomBytes}=require('node:crypto');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions,Response}=require('miniflare');
const origins=['https://alpha.network.workers.dev','https://beta.network.workers.dev'];
const servers=[],calls=[],sockets=[];let remoteMode='normal';
async function api(index,path,{user=servers[index].owner,method='GET',body,headers={}}={}){
 const response=await servers[index].mf.dispatchFetch(origins[index]+path,{method:body===undefined?method:method==='GET'?'POST':method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{}),'CF-Connecting-IP':'198.51.100.10',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};
}
const network=(enabled,origin,peers=[])=>({enabled,origin,peers});
before(async()=>{
 const compiled=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral', mainFields:['browser','module','main'],external:['cloudflare:workers']});
 for(let i=0;i<2;i++){
  const mf=new Miniflare(convertV4MiniflareOptions({name:'management-'+i,modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'management-'+i},durableObjects:{CHAT_ROOM:{className:'ChatRoom',useSQLite:true}},bindings:{JWT_SECRET:randomBytes(32).toString('hex')},outboundService:async request=>{
   calls.push({url:request.url,authorization:request.headers.get('Authorization'),cookie:request.headers.get('Cookie')});
   const index=origins.indexOf(new URL(request.url).origin);if(index===-1)return Response.json({error:'missing'},{status:404});
   if(new URL(request.url).pathname==='/.well-known/wihm'){
    if(remoteMode==='legacy-disabled')return Response.json({error:'پیدا کردن کاربران این سرویس فعال نیست.'},{status:404});
    if(remoteMode==='legacy-missing')return Response.json({error:'Not found'},{status:404});
    if(remoteMode==='blocked')return new Response('Provider text must not leak',{status:403});
    if(remoteMode==='unavailable')return new Response('Provider text must not leak',{status:503});
    if(remoteMode==='nonjson')return new Response('<html>old application</html>',{headers:{'Content-Type':'text/html'}});
    if(remoteMode==='legacy-enabled')return Response.json({protocol:'wihm-discovery/1',origin:origins[index],capabilities:{lookup:true,messaging:false,e2ee:false}});
   }
   if(remoteMode==='redirect')return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/secret'}});
   if(remoteMode==='oversized')return Response.json({huge:'x'.repeat(7000)});
   if(remoteMode==='spoof'&&new URL(request.url).pathname.startsWith('/api/discovery/'))return Response.json({address:'imposter@evil.workers.dev',origin:origins[index],username:'sara',displayName:'bad'});
   return servers[index].mf.dispatchFetch(request.url,{headers:request.headers});
  }}));
  const db=await mf.getD1Database('DB');servers.push({mf,db});
  for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  servers[i].owner=(await api(i,'/api/auth/register',{user:null,body:{username:'owner',password:'testpass123'}})).data;
  servers[i].member=(await api(i,'/api/auth/register',{user:null,body:{username:i?'sara':'ali',displayName:i?'سارا':'علی',password:'testpass123'}})).data;
  await db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(servers[i].owner.user.id).run();
 }
});
after(async()=>{for(const socket of sockets)socket.close();await Promise.all(servers.map(s=>s.mf.dispose()));});
test('management endpoints require the owner and return bounded statistics without credentials or backup claims',async()=>{
 for(const path of ['/api/service/overview','/api/service/users','/api/service/audit','/api/service/network']){
  assert.equal((await api(0,path,{user:null})).status,401);
  assert.equal((await api(0,path,{user:servers[0].member})).status,403);
 }
 const overview=await api(0,'/api/service/overview');assert.equal(overview.status,200);assert.equal(overview.data.counts.users,2);assert.equal(overview.data.version,'1.7.22');assert.equal(overview.data.backupAvailable,true);assert.equal(overview.data.encryption,'legacy-transport;experimental-mls');
 const listed=await api(0,'/api/service/users');assert.equal(listed.data.users.length,2);assert.ok(!JSON.stringify(listed.data).includes('password'));assert.ok(!JSON.stringify(listed.data).includes('salt'));
});
test('disabling a user immediately revokes existing REST and websocket access, blocks new logins and survives re-enabling old tokens',async()=>{
 const member=servers[0].member,owner=servers[0].owner,db=servers[0].db;
 const room=await api(0,'/api/chats',{body:{targetUserId:member.user.id}});assert.equal(room.status,201);
 const response=await servers[0].mf.dispatchFetch(origins[0]+'/ws?chatId='+room.data.id,{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'wihm.v1, wihm.token.'+member.token}});assert.equal(response.status,101);const socket=response.webSocket;socket.accept();sockets.push(socket);
 const revoked=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Socket not revoked')),5000);socket.addEventListener('message',e=>{if(JSON.parse(e.data).event==='session_revoked'){clearTimeout(timer);resolve();}});});
 assert.equal((await api(0,'/api/service/users',{method:'PATCH',body:{userId:owner.user.id,action:'disable',reason:''}})).status,409);
 const sessionsBefore=(await db.prepare('SELECT count(*) AS n FROM user_sessions WHERE user_id=?').bind(member.user.id).first()).n;
 assert.equal((await api(0,'/api/service/users',{method:'PATCH',body:{userId:member.user.id,action:'disable',reason:'آزمون مدیریت'}})).status,200);await revoked;
 assert.equal((await api(0,'/api/profile',{user:member})).status,401);
 assert.equal((await api(0,'/api/auth/login',{user:null,body:{username:'ali',password:'testpass123'}})).status,403);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM user_sessions WHERE user_id=?').bind(member.user.id).first()).n,sessionsBefore);
 assert.equal((await api(0,'/api/service/users',{method:'PATCH',body:{userId:member.user.id,action:'enable',reason:''}})).status,200);
 assert.equal((await api(0,'/api/profile',{user:member})).status,401,'Old tokens remain revoked after re-enable');
 servers[0].member=(await api(0,'/api/auth/login',{user:null,body:{username:'ali',password:'testpass123'}})).data;
 assert.equal((await api(0,'/api/profile',{user:servers[0].member})).status,200);
 assert.equal((await api(0,'/api/service/audit')).data.filter(row=>row.target==='ali').length,2);
});
test('server discovery works automatically while personal profiles remain private until consent',async()=>{
 const manifest=await api(1,'/.well-known/wihm',{user:null});assert.equal(manifest.status,200);assert.equal(manifest.data.enabled,true);assert.equal(manifest.data.capabilities.lookup,true);await api(1,'/api/service/network',{method:'PATCH',body:network(false,origins[1])});assert.equal(manifest.data.version,JSON.parse(readFileSync('package.json','utf8')).version);assert.equal(manifest.data.app,'wihm-cloudflare');
 assert.ok(!JSON.stringify(manifest.data).includes('sara'));
 const disabled=await api(0,'/api/network/lookup',{user:servers[0].member,body:{address:'sara@beta.network.workers.dev'}});assert.equal(disabled.status,409);assert.match(disabled.data.error,/مدیر سرور مقصد/);assert.equal(calls.length,1,'Disabled destination must not receive a profile probe');
 assert.equal((await api(1,'/api/service/network',{method:'PATCH',body:network(true,origins[1])})).status,200);
 assert.equal((await api(1,'/api/discovery/sara',{user:null})).status,404);
 assert.equal((await api(1,'/api/profile/discovery',{user:servers[1].member,body:{enabled:true}})).status,200);
 const row=await api(1,'/api/discovery/sara',{user:null});assert.equal(row.status,200);assert.equal(row.data.address,'sara@beta.network.workers.dev');assert.deepEqual(Object.keys(row.data).sort(),['address','canonicalAddress','capabilities','displayName','origin','username']);
 assert.equal((await api(1,'/api/discovery',{user:null})).status,401,'No anonymous user directory');
 const found=await api(0,'/api/network/lookup',{user:servers[0].member,body:{address:'sara@beta.network.workers.dev'},headers:{Cookie:'local-private-cookie'}});assert.equal(found.status,200,JSON.stringify(found));assert.equal(found.data.displayName,'سارا');assert.equal(found.data.messaging,true);assert.equal(found.data.e2ee,'experimental-mls');
 assert.equal(calls.length,3);assert.ok(calls.every(call=>call.authorization===null&&call.cookie===null));
 assert.equal((await api(1,'/api/profile/discovery',{user:servers[1].member,body:{enabled:false}})).status,200);
 const hidden=await api(0,'/api/network/lookup',{body:{address:'sara@beta.network.workers.dev'}});assert.equal(hidden.status,404);assert.match(hidden.data.error,/صاحب حساب اجازهٔ نمایش نداده/);
});

test('lookup distinguishes legacy disabled metadata, unsupported versions and blocked destinations without exposing provider text',async()=>{
 const cases=[['legacy-disabled',409,/مدیر سرور مقصد/],['legacy-missing',502,/نسخهٔ آن قدیمی/],['blocked',502,/دسترسی عمومی/],['unavailable',502,/فعلاً پاسخ مناسب/],['nonjson',502,/نسخهٔ آن قدیمی/]];
 for(const [mode,status,message] of cases){remoteMode=mode;const before=calls.length,result=await api(0,'/api/network/lookup',{user:servers[0].member,body:{address:'sara@beta.network.workers.dev'}});assert.equal(result.status,status,mode);assert.match(result.data.error,message,mode);assert.doesNotMatch(result.data.error,/Provider text/);assert.equal(calls.length,before+1,'No profile probe on metadata failure');}
 remoteMode='legacy-enabled';await api(1,'/api/profile/discovery',{user:servers[1].member,body:{enabled:true}});
 assert.equal((await api(0,'/api/network/lookup',{user:servers[0].member,body:{address:'sara@beta.network.workers.dev'}})).status,200,'Old enabled manifests remain compatible');remoteMode='normal';
});
test('lookup rejects private IPs, deceptive URLs, unapproved domains, redirects, oversized replies and mismatched identities',async()=>{
 const before=calls.length;
 for(const address of ['sara@127.0.0.1','sara@localhost','sara@0x7f000001','sara@beta.network.workers.dev:443','sara@beta.network.workers.dev/path','sara@user:pass@beta.network.workers.dev','sara@beta.network.workers.dev?x=1','sara@[::1]'])assert.equal((await api(0,'/api/network/lookup',{body:{address}})).status,400,address);
 assert.equal(calls.length,before);assert.equal((await api(0,'/api/network/lookup',{body:{address:'sara@unapproved.org'}})).status,502);
 await api(1,'/api/profile/discovery',{user:servers[1].member,body:{enabled:true}});
 for(const mode of ['redirect','oversized','spoof']){remoteMode=mode;const result=await api(0,'/api/network/lookup',{body:{address:'sara@beta.network.workers.dev'}});assert.notEqual(result.status,200,mode);}
 remoteMode='normal';
 assert.equal((await api(0,'/api/service/network',{method:'PATCH',body:network(true,'https://other.network.workers.dev')})).status,400);
 assert.equal((await api(0,'/api/service/network',{method:'PATCH',body:network(true,origins[0],['127.0.0.1'])})).status,400);
});
test('account disable and server opt-out immediately remove discoverability without deleting messages',async()=>{
 const member=servers[1].member;
 await api(1,'/api/service/users',{method:'PATCH',body:{userId:member.user.id,action:'disable',reason:''}});
 assert.equal((await api(1,'/api/discovery/sara',{user:null})).status,404);
 await api(1,'/api/service/users',{method:'PATCH',body:{userId:member.user.id,action:'enable',reason:''}});
 assert.equal((await api(1,'/api/discovery/sara',{user:null})).status,200);
 await api(1,'/api/service/network',{method:'PATCH',body:network(false,origins[1])});
 const meta=await api(1,'/.well-known/wihm',{user:null});assert.equal(meta.status,200);assert.equal(meta.data.enabled,false);assert.equal(meta.data.capabilities.lookup,false);
 assert.equal((await api(1,'/api/discovery/sara',{user:null})).status,404);
});
test('user listing uses bounded cursor pages and literal Persian search',async()=>{
 const db=servers[0].db;for(let i=0;i<35;i++)await db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').bind('page-'+i.toString().padStart(2,'0'),'page_'+i,'not-a-password','not-a-salt','نام فارسی '+i,Date.now()).run();
 const first=await api(0,'/api/service/users');assert.equal(first.data.users.length,30);assert.ok(first.data.next);
 const second=await api(0,'/api/service/users?after='+first.data.next);assert.equal(second.data.users.length,7);assert.equal(second.data.next,null);assert.equal(new Set([...first.data.users,...second.data.users].map(row=>row.id)).size,37);
 assert.equal((await api(0,'/api/service/users?q='+encodeURIComponent('فارسی 34'))).data.users.length,1);
});
test('the owner can create a one-time reset link that ends the member\'s sessions',async()=>{
 const login=(password,username='mina')=>api(0,'/api/auth/login',{user:null,body:{username,password}}),member=(await api(0,'/api/auth/register',{user:null,body:{username:'mina',password:'testpass123'}})).data,reset=body=>api(0,'/api/auth/reset',{user:null,body});
 const create=()=>api(0,'/api/service/users',{method:'PATCH',body:{userId:member.user.id,action:'reset-password',reason:''}});
 assert.equal((await api(0,'/api/service/users',{user:member,method:'PATCH',body:{userId:member.user.id,action:'reset-password',reason:''}})).status,403);
 assert.equal((await api(0,'/api/service/users',{method:'PATCH',body:{userId:servers[0].owner.user.id,action:'reset-password',reason:''}})).status,409);
 const first=(await create()).data.token,{token}=(await create()).data;assert.match(token,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(await servers[0].db.prepare('SELECT * FROM password_resets').all()).includes(token),'only a hash is stored');
 assert.equal((await reset({token:first,newPassword:'newpass12345'})).status,403,'a newer link replaces the older one');
 assert.equal((await reset({token,newPassword:'short'})).status,400);
 assert.equal((await reset({token:'0'.repeat(64),newPassword:'newpass12345'})).status,403);
 assert.equal((await login('testpass123')).status,200,'a failed attempt changes nothing');
 assert.equal((await reset({token,newPassword:'newpass12345'})).status,200);
 assert.equal((await reset({token,newPassword:'anotherpass123'})).status,403,'a link works once');
 assert.equal((await api(0,'/api/profile',{user:member})).status,401,'old sessions end');
 assert.equal((await login('testpass123')).status,401);assert.equal((await login('newpass12345')).status,200);
 const expired=(await create()).data.token;await servers[0].db.prepare('UPDATE password_resets SET expires_at=1').run();
 assert.equal((await reset({token:expired,newPassword:'anotherpass123'})).status,403,'a link expires');
});
