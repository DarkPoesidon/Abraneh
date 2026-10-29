const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createHash,createHmac,generateKeyPairSync,randomBytes,sign}=require('node:crypto');
const {runInNewContext}=require('node:vm');
const {encodeCBOR}=require('@levischuck/tiny-cbor');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const origin='https://security.example.com',password='testpass123';
let mf,db,serial=0;
before(async()=>{
  const compiled=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],external:['cloudflare:workers']});
  mf=new Miniflare(convertV4MiniflareOptions({name:'security',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'security'},durableObjects:{CHAT_ROOM:{className:'ChatRoom',useSQLite:true}},bindings:{JWT_SECRET:randomBytes(32).toString('hex')}}));
  db=await mf.getD1Database('DB');
  for(const file of ['schema.sql','migrations/0006_advanced_security.sql'])for(const sql of readFileSync(file,'utf8').replace(/^--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
});
after(async()=>mf?.dispose());
async function api(path,body,user,base=origin){
  const response=await mf.dispatchFetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'198.51.100.'+(user?.ip||70),...(user?{Authorization:'Bearer '+user.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
async function account(){const username='security_'+(++serial),result=await api('/api/auth/register',{username,password});assert.equal(result.status,201,JSON.stringify(result));return {...result.data,ip:serial+70};}
const login=(user,otp)=>api('/api/auth/login',{username:user.user.username,password,...(otp?{otp}:{})});
function otp(uri,offset=0){
  const secret=new URL(uri).searchParams.get('secret');let bits=0,value=0;const bytes=[];
  for(const char of secret){value=(value<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
  const step=Buffer.alloc(8);step.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offset));
  const mac=createHmac('sha1',Buffer.from(bytes)).update(step).digest(),start=mac[19]&15;
  return ((mac.readUInt32BE(start)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
async function enableTotp(user){
  const setup=await api('/api/security/totp/setup',{password},user);assert.equal(setup.status,200,JSON.stringify(setup));
  const setupCode=otp(setup.data.uri),activated=await api('/api/security/totp/enable',{challengeId:setup.data.challengeId,otp:setupCode},user);assert.equal(activated.status,200,JSON.stringify(activated));
  return {uri:setup.data.uri,setupCode,codes:activated.data.recoveryCodes};
}
function authenticator(){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'}),id=randomBytes(32);
  const cose=encodeCBOR(new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y,'base64url'))]]));
  function authData(counter,uv,registration=false,rp='security.example.com'){
    const head=Buffer.alloc(37);createHash('sha256').update(rp).digest().copy(head);head[32]=1|(uv?4:0)|(registration?64:0);head.writeUInt32BE(counter,33);
    if(!registration)return head;
    const length=Buffer.alloc(2);length.writeUInt16BE(id.length);return Buffer.concat([head,Buffer.alloc(16),length,id,Buffer.from(cose)]);
  }
  function client(challenge,type,base=origin){return Buffer.from(JSON.stringify({challenge,type,origin:base,crossOrigin:false}));}
  return {id:id.toString('base64url'),register(options,{uv=true,base=origin,rp}={}){
    return {id:id.toString('base64url'),rawId:id.toString('base64url'),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client(options.challenge,'webauthn.create',base).toString('base64url'),attestationObject:Buffer.from(encodeCBOR(new Map([['fmt','none'],['attStmt',new Map()],['authData',new Uint8Array(authData(0,uv,true,rp))]]))).toString('base64url'),transports:['internal']}};
  },authenticate(options,{counter=1,uv=true,base=origin,rp,tamper=false}={}){
    const data=authData(counter,uv,false,rp),json=client(options.challenge,'webauthn.get',base),signed=sign('sha256',Buffer.concat([data,createHash('sha256').update(json).digest()]),privateKey);if(tamper)signed[signed.length-1]^=1;
    return {id:id.toString('base64url'),rawId:id.toString('base64url'),type:'public-key',clientExtensionResults:{},response:{authenticatorData:data.toString('base64url'),clientDataJSON:json.toString('base64url'),signature:signed.toString('base64url')}};
  }};
}
async function enroll(user,key){const saved=await api('/api/security/passkeys/options',{password},user);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.data.options.authenticatorSelection.userVerification,'required');const result=await api('/api/security/passkeys/verify',{challengeId:saved.data.challengeId,credential:key.register(saved.data.options),name:'My device'},user);assert.equal(result.status,200,JSON.stringify(result));return saved;}
async function passkeyLogin(user,key,settings){const saved=await api('/api/auth/passkey/options',{username:user.user.username});assert.equal(saved.status,200,JSON.stringify(saved));return api('/api/auth/passkey/verify',{challengeId:saved.data.challengeId,credential:key.authenticate(saved.data.options,settings)});}

test('security is opt-in and setup needs a password; secrets stay encrypted and confirmation expires once',async()=>{
  const user=await account();assert.equal((await login(user)).status,200);
  assert.equal((await api('/api/security/status')).status,401);
  assert.deepEqual((await api('/api/security/status',undefined,user)).data,{passkeys:[],totp:false,recoveryRemaining:0});
  assert.equal((await api('/api/security/totp/setup',{password:'wrong'},user)).status,403);
  const setup=await api('/api/security/totp/setup',{password},user);assert.equal(setup.status,200);
  const secret=new URL(setup.data.uri).searchParams.get('secret'),saved=await db.prepare('SELECT challenge FROM security_challenges WHERE id=?').bind(setup.data.challengeId).first();
  assert.ok(!saved.challenge.includes(secret));assert.match(saved.challenge,/^[\w-]+\.[\w-]+$/);
  assert.equal((await api('/api/security/status',undefined,user)).data.totp,false);assert.equal((await login(user)).status,200);
  await db.prepare('UPDATE security_challenges SET expires_at=0 WHERE id=?').bind(setup.data.challengeId).run();
  assert.equal((await api('/api/security/totp/enable',{challengeId:setup.data.challengeId,otp:otp(setup.data.uri)},user)).status,403);
  const invalid=await api('/api/security/totp/setup',{password},user);
  assert.equal((await api('/api/security/totp/enable',{challengeId:invalid.data.challengeId,otp:'invalid'},user)).status,403);
  assert.equal((await api('/api/security/totp/enable',{challengeId:invalid.data.challengeId,otp:otp(invalid.data.uri)},user)).status,403,'Failed confirmation is consumed');
});
test('TOTP protects password login and password changes; recovery and TOTP cannot replay',async()=>{
  const user=await account(),old=(await login(user)).data,{uri,setupCode,codes}=await enableTotp(user);
  assert.equal((await api('/api/security/status',undefined,old)).status,401,'Enabling MFA revokes other sessions');
  assert.equal((await login(user)).status,401);assert.equal((await login(user,'bad')).status,401);assert.equal((await login(user,setupCode)).status,401,'Setup TOTP is already spent');
  const nextCode=otp(uri,1);assert.equal((await login(user,nextCode)).status,200);assert.equal((await login(user,nextCode)).status,401);
  assert.equal(codes.length,8);const stored=await db.prepare('SELECT code_hash FROM security_recovery WHERE user_id=?').bind(user.user.id).all();assert.ok(stored.results.every(row=>!codes.includes(row.code_hash)));
  const results=await Promise.all([login(user,codes[0]),login(user,codes[0])]);assert.deepEqual(results.map(row=>row.status).sort(),[200,401]);
  assert.equal((await api('/api/profile/password',{currentPassword:password,newPassword:'newpassword123'},user)).status,403);
  assert.equal((await api('/api/security/totp/disable',{password},user)).status,403);
  assert.equal((await api('/api/security/totp/disable',{password:'wrong',otp:codes[1]},user)).status,403);
  const renewed=await api('/api/security/recovery',{password,otp:codes[1]},user);assert.equal(renewed.status,200);
  assert.equal((await login(user,codes[2])).status,401,'Replacing recovery codes invalidates old codes');
  assert.equal((await api('/api/security/totp/disable',{password,otp:renewed.data.recoveryCodes[0]},user)).status,200);
  assert.equal((await login(user)).status,200);assert.equal((await api('/api/security/status',undefined,user)).data.recoveryRemaining,0);
});
test('real ES256 registration and authentication enforce origin, RP, UV, signature, counters and single-use challenges',async()=>{
  const user=await account(),key=authenticator();
  assert.equal((await api('/api/security/passkeys/options',{password:'wrong'},user)).status,403);
  const saved=await enroll(user,key);
  assert.equal((await api('/api/security/passkeys/verify',{challengeId:saved.data.challengeId,credential:key.register(saved.data.options)},user)).status,403);
  const listed=await api('/api/security/status',undefined,user);assert.equal(listed.data.passkeys.length,1);assert.equal(listed.data.passkeys[0].name,'My device');assert.ok(!JSON.stringify(listed.data).includes('public_key'));
  for(const settings of [{uv:false},{base:'https://evil.example.com'},{rp:'evil.example.com'},{tamper:true}])assert.equal((await passkeyLogin(user,key,settings)).status,401,JSON.stringify(settings));
  const options=await api('/api/auth/passkey/options',{username:user.user.username}),body={challengeId:options.data.challengeId,credential:key.authenticate(options.data.options)};
  const accepted=await api('/api/auth/passkey/verify',body);assert.equal(accepted.status,200,JSON.stringify(accepted));assert.equal(accepted.data.user.id,user.user.id);
  assert.equal((await api('/api/auth/passkey/verify',body)).status,401);assert.equal((await passkeyLogin(user,key,{counter:1})).status,401,'Counter must advance');
  await enableTotp(user);assert.equal((await login(user)).status,401);assert.equal((await passkeyLogin(user,key,{counter:2})).status,200,'Verified PIN/biometric passkey is the second factor');
  assert.equal((await api('/api/security/passkeys/delete',{password,id:key.id},user)).status,403,'Password alone cannot remove a passkey when MFA is enabled');
});
test('registration challenge is bound to session, user, password version, expiry and origin; removal is owner scoped',async()=>{
  const user=await account(),other=await account(),key=authenticator();
  let saved=await api('/api/security/passkeys/options',{password},user),body={challengeId:saved.data.challengeId,credential:key.register(saved.data.options)};
  assert.equal((await api('/api/security/passkeys/verify',body,other)).status,403);
  const second=(await login(user)).data;assert.equal((await api('/api/security/passkeys/verify',body,second)).status,403);
  assert.equal((await api('/api/security/passkeys/verify',body,user,'https://other.example.com')).status,403);
  assert.equal((await api('/api/security/passkeys/verify',body,user)).status,200,'Unrelated session cannot consume owner challenge');
  assert.equal((await api('/api/security/passkeys/delete',{password,id:key.id},other)).status,200);assert.equal((await api('/api/security/status',undefined,user)).data.passkeys.length,1);
  assert.equal((await api('/api/security/passkeys/delete',{password,id:key.id},user)).status,200);assert.equal((await passkeyLogin(user,key)).status,401);
  saved=await api('/api/security/passkeys/options',{password},user);await db.prepare('UPDATE security_challenges SET expires_at=0 WHERE id=?').bind(saved.data.challengeId).run();
  assert.equal((await api('/api/security/passkeys/verify',{challengeId:saved.data.challengeId,credential:key.register(saved.data.options)},user)).status,403);
  saved=await api('/api/security/passkeys/options',{password},user);await db.prepare('UPDATE security_challenges SET password_version=100 WHERE id=?').bind(saved.data.challengeId).run();
  assert.equal((await api('/api/security/passkeys/verify',{challengeId:saved.data.challengeId,credential:key.register(saved.data.options)},user)).status,403);
});
test('browser native and fallback WebAuthn serialization preserve binary fields and login uses the verified result',async()=>{
  const window={isSecureContext:true},navigator={credentials:{}},sandbox={window,navigator,Uint8Array,atob,btoa};runInNewContext(readFileSync('public/security.js','utf8'),sandbox);
  const security=window.WihmSecurity,buffer=Uint8Array.from([0,255,128,1]).buffer,encoded=Buffer.from(buffer).toString('base64url');
  const credential={id:encoded,rawId:buffer,type:'public-key',getClientExtensionResults:()=>({}),response:{clientDataJSON:buffer,authenticatorData:buffer,signature:buffer,userHandle:buffer}};
  const json=security.credentialJSON(credential);assert.equal(json.response.signature,encoded);assert.equal(json.response.userHandle,encoded);assert.equal(json.rawId,encoded);
  credential.response={clientDataJSON:buffer,attestationObject:buffer,getTransports:()=>['internal']};assert.equal(security.credentialJSON(credential).response.attestationObject,encoded);
  assert.deepEqual(security.credentialJSON({toJSON:()=>({native:true})}),{native:true});
  const creation=security.options({challenge:encoded,user:{id:encoded},excludeCredentials:[{id:encoded}]},true);assert.deepEqual([...creation.user.id],[0,255,128,1]);assert.deepEqual([...creation.excludeCredentials[0].id],[0,255,128,1]);
  let prompted=false;const calls=[];navigator.credentials.get=async value=>{prompted=true;assert.deepEqual([...value.publicKey.challenge],[0,255,128,1]);return {toJSON:()=>({signed:true})};};
  const result=await security.login(async(path,body)=>{calls.push({path,body});return path.endsWith('/options')?{challengeId:'once',options:{challenge:encoded,allowCredentials:[{id:encoded}]}}:{token:'verified',user:{id:'alice'}};},'alice');
  assert.ok(prompted);assert.equal(result.token,'verified');assert.equal(calls[1].body.challengeId,'once');assert.ok(calls[1].body.credential.signed);
  window.isSecureContext=false;await assert.rejects(security.login(async()=>({options:{}}),'alice'),/HTTPS/);
});
