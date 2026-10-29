// Experimental RFC 9420 text chats. Device verification is an application trust boundary.
import {getCiphersuiteImpl} from 'ts-mls/crypto/getCiphersuiteImpl.js';
import {getCiphersuiteFromName} from 'ts-mls/crypto/ciphersuite.js';
import {generateKeyPackageWithKey,verifyKeyPackage,makeKeyPackageRef} from 'ts-mls/keyPackage.js';
import {defaultCapabilities} from 'ts-mls/defaultCapabilities.js';
import {createGroup,joinGroup,encodeGroupState,decodeGroupState} from 'ts-mls/clientState.js';
import {createCommit} from 'ts-mls/createCommit.js';
import {createApplicationMessage} from 'ts-mls/createMessage.js';
import {processPrivateMessage} from 'ts-mls/processMessages.js';
import {emptyPskIndex} from 'ts-mls/pskIndex.js';
import {encodeMlsMessage,decodeMlsMessage} from 'ts-mls/message.js';
import {zeroOutUint8Array} from 'ts-mls/util/byteArray.js';
import {defaultClientConfig} from 'ts-mls/clientConfig.js';

const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true}),suite='MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const b64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);},unb64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const fail=message=>{throw Error(message);};
const packageData=(who,device,keyPackage)=>JSON.stringify(['wihm-device/1',who,device,keyPackage]);
const envelopeData=e=>JSON.stringify(['wihm-mls/1',e.id,e.thread,e.from,e.fromDevice,e.to,e.toDevice,e.kind,e.payload,e.senderKey]);
export async function fingerprint(key){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',unb64(key)))].map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();}
const credential=(who,device)=>JSON.stringify([who,device]);
function mlsDecode(encoded,format){const bytes=unb64(encoded),decoded=decodeMlsMessage(bytes,0);if(!decoded||decoded[1]!==bytes.length||decoded[0].wireformat!==format)fail('قالب پیام MLS معتبر نیست.');return decoded[0];}
const packState=state=>b64(encodeGroupState(state));
function validateAddress(who){if(typeof who!=='string'||who.length>300||!/^[a-z0-9_]{3,20}@[a-z0-9.-]+$/.test(who)||new URL('https://'+who.split('@')[1]).hostname!==who.split('@')[1])fail('نشانی کامل حساب معتبر نیست.');return who;}

export async function createSecureClient({address,storage,request,lock=(_name,fn)=>fn()}){
  validateAddress(address);const impl=await getCiphersuiteImpl(getCiphersuiteFromName(suite));
  let serial=Promise.resolve();
  const exclusive=fn=>{const task=serial.then(()=>lock('wihm-mls:'+address,fn));serial=task.catch(()=>{});return task;};
  const load=async()=>await storage.load()||{version:1,address,device:null,threads:{},trusted:{},pending:[],cursor:0,outbox:[],alerts:[]};
  const save=state=>storage.save(state);
  async function makeDevice(){const pair=await impl.signature.keygen();return {id:crypto.randomUUID(),key:b64(pair.publicKey),private:b64(pair.signKey),packages:[]};}
  async function makePackage(device){const now=BigInt(Math.floor(Date.now()/1000));return generateKeyPackageWithKey({credentialType:'basic',identity:enc.encode(credential(address,device.id))},defaultCapabilities(),{notBefore:now-300n,notAfter:now+2592000n},[],{publicKey:unb64(device.key),signKey:unb64(device.private)},impl);}
  async function replenish(state){
    const device=state.device;
    for(const item of device.packages)if(!item.used&&item.expiresAt<Date.now()){item.used=true;delete item.private;}
    const registered=await request('/api/secure/devices','GET'),available=registered.devices.find(d=>d.device===device.id)?.available||0;
    while(available+device.packages.filter(p=>!p.used&&!p.published).length<10){
      const generated=await makePackage(device);
      const encoded=b64(encodeMlsMessage({version:'mls10',wireformat:'mls_key_package',keyPackage:generated.publicPackage}));
      device.packages.push({encoded,ref:b64(await makeKeyPackageRef(generated.publicPackage,impl.hash)),private:Object.fromEntries(Object.entries(generated.privatePackage).map(([k,v])=>[k,b64(v)])),signature:b64(await impl.signature.sign(unb64(device.private),enc.encode(packageData(address,device.id,encoded)))),published:false,used:false,expiresAt:Date.now()+29*86400000});
    }
    // Persist private prekeys before making their public packages available.
    await save(state);
    for(const item of device.packages.filter(p=>!p.published&&!p.used)){
      await request('/api/secure/devices','POST',{device:device.id,identityKey:device.key,keyPackage:item.encoded,signature:item.signature});item.published=true;await save(state);
    }
  }
  async function checkDevice(who,device){
    validateAddress(who);if(!device||typeof device.device!=='string'||!/^[0-9a-f-]{36}$/.test(device.device)||unb64(device.identityKey).length!==32)fail('هویت دستگاه معتبر نیست.');
    if(!await impl.signature.verify(unb64(device.identityKey),enc.encode(packageData(who,device.device,device.keyPackage)),unb64(device.signature)))fail('امضای کلید مخاطب معتبر نیست.');
    const kp=mlsDecode(device.keyPackage,'mls_key_package').keyPackage;
    if(kp.cipherSuite!==suite||b64(kp.leafNode.signaturePublicKey)!==device.identityKey||dec.decode(kp.leafNode.credential.identity)!==credential(who,device.device)||!await verifyKeyPackage(kp,impl.signature))fail('بستهٔ کلید به مخاطب تعلق ندارد.');
    return kp;
  }
  function config(state,thread){
    const identities=new Map([[credential(address,state.device.id),state.device.key],[credential(thread.peer,thread.peerDevice),thread.peerKey]]);
    return {...defaultClientConfig,authService:{async validateCredential(c,key){return c.credentialType==='basic'&&identities.get(dec.decode(c.identity))===b64(key);}}};
  }
  function unpack(state,thread){const raw=unb64(thread.state),decoded=decodeGroupState(raw,0);if(!decoded||decoded[1]!==raw.length)fail('وضعیت محلی MLS معتبر نیست.');return {...decoded[0],clientConfig:config(state,thread)};}
  function requireTrusted(state,thread){if(state.trusted[thread.peer+'|'+thread.peerDevice]!==thread.peerKey)fail('ابتدا اثرانگشت این دستگاه را از راه دیگری با مخاطب تطبیق دهید.');if(thread.archived)fail('این تاریخچه بازیابی‌شده فقط خواندنی است؛ گفتگوی امن تازه بسازید.');}
  async function signedEnvelope(state,thread,kind,payload,id=crypto.randomUUID()){
    const e={id,thread:thread.id,from:address,fromDevice:state.device.id,to:thread.peer,toDevice:thread.peerDevice,kind,payload,senderKey:state.device.key};
    e.signature=b64(await impl.signature.sign(unb64(state.device.private),enc.encode(envelopeData(e))));return e;
  }
  async function verifiedEnvelope(state,e){
    if(e.to!==address||e.toDevice!==state.device.id||!['message','welcome'].includes(e.kind)||unb64(e.senderKey).length!==32||!await impl.signature.verify(unb64(e.senderKey),enc.encode(envelopeData(e)),unb64(e.signature)))fail('امضا یا مقصد پیام امن معتبر نیست.');validateAddress(e.from);
  }
  async function acceptPending(state){
    const waiting=[];
    state.pending.sort((a,b)=>Number(a.envelope.kind!=='welcome')-Number(b.envelope.kind!=='welcome'));
    for(const item of state.pending){
      const e=item.envelope;
      try{
        await verifiedEnvelope(state,e);
        if(state.trusted[e.from+'|'+e.fromDevice]!==e.senderKey){waiting.push(item);continue;}
        let thread=state.threads[e.thread];
        if(e.kind==='welcome'){
          if(thread)continue;
          const welcome=mlsDecode(e.payload,'mls_welcome').welcome;let joined,consumedPackage;
          thread={id:e.thread,peer:e.from,peerDevice:e.fromDevice,peerKey:e.senderKey,messages:[],seen:[],state:''};
          for(const item of state.device.packages.filter(p=>!p.used&&welcome.secrets.some(s=>b64(s.newMember)===p.ref))){
            try{joined=await joinGroup(welcome,mlsDecode(item.encoded,'mls_key_package').keyPackage,Object.fromEntries(Object.entries(item.private).map(([k,v])=>[k,unb64(v)])),emptyPskIndex,impl,undefined,undefined,config(state,thread));consumedPackage=item;break;}catch{}
          }
          if(!joined||!consumedPackage)fail('کلید دعوت موجود نیست، منقضی است یا قبلاً مصرف شده است.');
          const leaves=joined.ratchetTree.filter(n=>n?.nodeType==='leaf');
          if(dec.decode(joined.groupContext.groupId)!==e.thread||leaves.length!==2||!leaves.some(n=>b64(n.leaf.signaturePublicKey)===e.senderKey&&dec.decode(n.leaf.credential.identity)===credential(e.from,e.fromDevice)))fail('اعضای دعوت با دستگاه تأییدشده مطابقت ندارند.');
          thread.state=packState(joined);thread.seen.push(e.id);state.threads[e.thread]=thread;consumedPackage.used=true;delete consumedPackage.private;
        }else{
          if(!thread){waiting.push(item);continue;}
          if(thread.archived||thread.peer!==e.from||thread.peerDevice!==e.fromDevice||thread.peerKey!==e.senderKey)fail('فرستنده با این گفتگوی امن مطابقت ندارد.');
          if(thread.seen.includes(e.id))continue;
          const result=await processPrivateMessage(unpack(state,thread),mlsDecode(e.payload,'mls_private_message').privateMessage,emptyPskIndex,impl);
          if(result.kind!=='applicationMessage')fail('تغییر عضویت خودکار مجاز نیست؛ گفتگوی تأییدشدهٔ تازه بسازید.');
          const content=JSON.parse(dec.decode(result.message));if(content.id!==e.id||content.thread!==e.thread||typeof content.text!=='string'||content.text.length>8000||content.replyTo!==null&&typeof content.replyTo!=='string')fail('محتوای رمزگشایی‌شده معتبر نیست.');
          thread.state=packState(result.newState);thread.seen.push(e.id);thread.messages.push({id:e.id,text:content.text,replyTo:content.replyTo,from:e.from,createdAt:Date.now()});result.consumed.forEach(zeroOutUint8Array);
        }
      }catch(error){state.alerts.push({id:e.id,message:error.message});}
    }
    state.pending=waiting;state.alerts=state.alerts.slice(-30);await save(state);
  }
  async function flush(state){
    const remaining=[];state.deliveryError='';state.serverQueue||=[];
    for(const e of state.outbox){
      try{const result=await request('/api/secure/send','POST',e),message=state.threads[e.thread]?.messages.find(m=>m.id===e.id);if(message)message.delivery=result.queued?'server-queued':'delivered';if(result.queued&&!state.serverQueue.some(x=>x.id===e.id))state.serverQueue.push({id:e.id,thread:e.thread});}
      catch(error){remaining.push(e);state.deliveryError=error.message;}
    }
    state.outbox=remaining;await save(state);
    const pending=[];for(const item of state.serverQueue){try{const result=await request('/api/secure/delivery?id='+item.id,'GET');if(!result.deliveredAt){pending.push(item);continue;}const message=state.threads[item.thread]?.messages.find(m=>m.id===item.id);if(message)message.delivery='delivered';}catch{pending.push(item);}}
    state.serverQueue=pending;await save(state);
  }
  return {
    async init(){return exclusive(async()=>{const state=await load();if(state.address!==address)fail('این حافظه برای حساب دیگری است.');if(!state.device){state.device=await makeDevice();await save(state);}await replenish(state);return {device:state.device.id,key:state.device.key,fingerprint:await fingerprint(state.device.key)};});},
    async lookup(who){validateAddress(who);const result=await request('/api/secure/keys','POST',{address:who});if(result.address!==who||!Array.isArray(result.devices))fail('پاسخ مقصد معتبر نیست.');for(const device of result.devices){await checkDevice(who,device);device.fingerprint=await fingerprint(device.identityKey);}return result.devices;},
    async trust(who,device,key,confirmation){validateAddress(who);if(confirmation.replace(/\s/g,'').toUpperCase()!==await fingerprint(key))fail('اثر انگشت کامل با کلید نمایش‌داده‌شده مطابقت ندارد.');return exclusive(async()=>{const state=await load(),id=who+'|'+device,previous=state.trusted[id];state.trusted[id]=key;if(previous&&previous!==key)for(const thread of Object.values(state.threads))if(thread.peer===who&&thread.peerDevice===device)thread.archived=true;await acceptPending(state);});},
    async start(who,device){return exclusive(async()=>{const state=await load(),kp=await checkDevice(who,device),thread={id:crypto.randomUUID(),peer:who,peerDevice:device.device,peerKey:device.identityKey,messages:[],seen:[],state:''};requireTrusted(state,thread);
      const packageId=await fingerprint(device.keyPackage);state.spentPackages||=[];if(state.spentPackages.includes(packageId))fail('این بستهٔ کلید قبلاً مصرف شده است؛ دستگاه مخاطب را دوباره پیدا کنید.');
      const own=await makePackage(state.device),created=await createGroup(enc.encode(thread.id),own.publicPackage,own.privatePackage,[],impl,config(state,thread));
      const commit=await createCommit({state:created,cipherSuite:impl},{extraProposals:[{proposalType:'add',add:{keyPackage:kp}}],ratchetTreeExtension:true});
      thread.state=packState(commit.newState);state.threads[thread.id]=thread;state.spentPackages.push(packageId);state.outbox.push(await signedEnvelope(state,thread,'welcome',b64(encodeMlsMessage({version:'mls10',wireformat:'mls_welcome',welcome:commit.welcome}))));await save(state);commit.consumed.forEach(zeroOutUint8Array);await flush(state);return thread.id;});},
    async send(threadId,text,replyTo=null){if(typeof text!=='string'||!text.trim()||text.length>8000||replyTo!==null&&typeof replyTo!=='string')fail('پیام باید بین یک تا ۸۰۰۰ حرف باشد.');return exclusive(async()=>{const state=await load(),thread=state.threads[threadId];if(!thread)fail('گفتگوی امن پیدا نشد.');requireTrusted(state,thread);
      const id=crypto.randomUUID(),result=await createApplicationMessage(unpack(state,thread),enc.encode(JSON.stringify({id,thread:threadId,text,replyTo})),impl);
      const e=await signedEnvelope(state,thread,'message',b64(encodeMlsMessage({version:'mls10',wireformat:'mls_private_message',privateMessage:result.privateMessage})),id);
      thread.state=packState(result.newState);thread.seen.push(id);thread.messages.push({id,text,replyTo,from:address,createdAt:Date.now(),delivery:'local-queued'});state.outbox.push(e);await save(state);result.consumed.forEach(zeroOutUint8Array);await flush(state);return id;});},
    async sync(){return exclusive(async()=>{const state=await load();if(!state.device)fail('دستگاه امن را فعال کنید.');await flush(state);const result=await request('/api/secure/inbox?device='+state.device.id+'&after='+state.cursor,'GET');for(const item of result.events){if(!Number.isSafeInteger(item.sequence)||item.sequence<=state.cursor)continue;state.pending.push(item);state.cursor=item.sequence;}await save(state);await acceptPending(state);await replenish(state);return {pending:state.pending.length,queued:state.outbox.length};});},
    async view(){return exclusive(async()=>{const state=await load();return {device:state.device?.id,key:state.device?.key,threads:Object.values(state.threads).map(({state,seen,...thread})=>thread),pending:state.pending.map(x=>x.envelope),queued:state.outbox.length,serverQueued:state.serverQueue?.length||0,deliveryError:state.deliveryError||'',alerts:state.alerts,trusted:state.trusted};});},
    async exportRecovery(password){if(typeof password!=='string'||password.length<12)fail('رمز فایل بازیابی باید حداقل ۱۲ نویسه باشد.');return exclusive(async()=>{const state=await load(),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await recoveryKey(password,salt);
      // Recovery archives history and rotates the device on import, preventing ratchet rollback.
      const content={version:1,address,oldDevice:state.device.id,threads:Object.values(state.threads).map(({state,seen,...thread})=>({...thread,archived:true}))};
      return JSON.stringify({format:'wihm-secure-recovery/1',salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(address)},key,enc.encode(JSON.stringify(content)))))});});},
    async importRecovery(text,password){if(text.length>5000000)fail('فایل بازیابی بیش از حد بزرگ است.');const file=JSON.parse(text);if(file.format!=='wihm-secure-recovery/1'||unb64(file.salt).length!==16||unb64(file.iv).length!==12)fail('فایل بازیابی معتبر نیست.');let content;try{content=JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(file.iv),additionalData:enc.encode(address)},await recoveryKey(password,unb64(file.salt)),unb64(file.ciphertext))));}catch{fail('رمز، حساب یا فایل بازیابی درست نیست.');}
      if(content.version!==1||content.address!==address||!Array.isArray(content.threads)||content.threads.some(t=>!t||typeof t.id!=='string'||!/^[0-9a-f-]{36}$/.test(t.id)||!Array.isArray(t.messages)||typeof t.peer!=='string'||typeof t.peerDevice!=='string'||t.messages.some(m=>!m||typeof m.id!=='string'||typeof m.text!=='string'||typeof m.from!=='string'||m.replyTo!==null&&typeof m.replyTo!=='string')))fail('محتوای بازیابی معتبر نیست.');
      return exclusive(async()=>{const state=await load();if(state.outbox.length)fail('ابتدا پیام‌های صف فعلی را تحویل دهید.');await request('/api/secure/devices','DELETE',{device:content.oldDevice});for(const thread of Object.values(state.threads))thread.archived=true;for(const thread of content.threads)state.threads[thread.id]={...thread,archived:true,state:'',seen:[]};if(state.device)await request('/api/secure/devices','DELETE',{device:state.device.id});state.device=await makeDevice();state.cursor=0;state.pending=[];state.trusted={};await save(state);await replenish(state);});},
    async revoke(device){return exclusive(async()=>{const state=await load();if(state.device?.id===device&&state.outbox.length)fail('ابتدا پیام‌های صف محلی را تحویل دهید.');await request('/api/secure/devices','DELETE',{device});if(state.device?.id===device){for(const thread of Object.values(state.threads)){thread.archived=true;thread.state='';}state.device=null;state.pending=[];state.cursor=0;state.trusted={};await save(state);}});},
  };
}
async function recoveryKey(password,salt){return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']),{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}

async function browserStorage(address){
  const database=await new Promise((resolve,reject)=>{const r=indexedDB.open('wihm-secure',1);r.onupgradeneeded=()=>r.result.createObjectStore('accounts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const access=(mode,write,value)=>new Promise((resolve,reject)=>{const tx=database.transaction('accounts',mode),store=tx.objectStore('accounts'),r=write?store.put(value,address):store.get(address);let result;r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Local storage aborted'));});
  return {load:()=>access('readonly',false),save:value=>access('readwrite',true,value)};
}
let browserClient=null,browserAccount='',browserEpoch=0,refreshView=null;
async function connectBrowser(api,user){
  if(!navigator.locks||!crypto.subtle)throw Error('مرورگر را برای گفتگوی امن به‌روز کنید.');
  const account=user.id+'|'+location.origin;
  if(browserAccount!==account){browserAccount=account;browserClient=null;browserEpoch++;}
  const epoch=browserEpoch,guardedApi=(...args)=>{if(epoch!==browserEpoch)throw Error('Session changed');return api(...args);};
  if(!browserClient){
    const pending=(async()=>{const identity=await guardedApi('/api/secure/identity'),who=identity.address;
      const request=(path,method,body)=>guardedApi(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
      const client=await createSecureClient({address:who,storage:await browserStorage(who),request,lock:(name,fn)=>navigator.locks.request(name,fn)});
      await client.init();return {client,who,request};})();
    browserClient=pending;try{await pending;}catch(e){if(browserClient===pending)browserClient=null;throw e;}
  }
  return browserClient;
}
if(typeof window!=='undefined')window.WihmSecure={connect:connectBrowser,async refresh(){if(refreshView)await refreshView();},reset(){refreshView=null;browserAccount='';browserClient=null;browserEpoch++;},async open({api,post,show,error,escape:esc,user,initialAddress='',threadId=''}){
  if(!navigator.locks||!crypto.subtle){show('گفتگوی امن آزمایشی','<p>این مرورگر از ذخیرهٔ امن همزمان و رمزنگاری لازم پشتیبانی نمی‌کند. مرورگر را به‌روز کنید.</p>');return;}
  const {client,who,request}=await connectBrowser(api,user);
  let selected=threadId,lookupWho='',devices=[],busy=false;
  const by=id=>document.getElementById(id),status=message=>{const e=by('feature-status');if(e)e.textContent=message;};
  const bind=(id,fn,event='click')=>{const e=by(id);if(e)e.addEventListener(event,async ev=>{ev.preventDefault();if(busy)return;busy=true;try{await fn();}catch(x){status(x.message);}finally{busy=false;}});};
  async function verifyForm(peer,device,key,next){
    const fp=await fingerprint(key),view=await client.view(),old=view.trusted[peer+'|'+device];
    show('تأیید دستگاه مخاطب',`<p class="session-help">${old&&old!==key?'هشدار: کلید این دستگاه تغییر کرده است. تا تأیید دوباره ارسال متوقف است.':'اثر انگشت را از راهی مستقل مثل تماس با مخاطب مقایسه کنید.'} تطبیق نام یا پاسخ سرور کافی نیست.</p><p dir="ltr">${esc(peer)}<br>${esc(device)}</p><code dir="ltr" style="overflow-wrap:anywhere;display:block">${fp}</code><form id="secure-verify" class="feature-form"><label>اثر انگشت کامل تأییدشده<input id="secure-fp" class="form-input" autocomplete="off" dir="ltr" required></label><button class="btn-primary">تأیید و ادامه</button></form>`);
    bind('secure-verify',async()=>{await client.trust(peer,device,key,by('secure-fp').value);await next();},'submit');
  }
  async function render(){
    const view=await client.view(),thread=view.threads.find(t=>t.id===selected);
    show('گفتگوی امن آزمایشی · MLS',`<p class="session-help">کتابخانهٔ MLS ممیزی مستقل نشده است. هر گفتگو مخصوص دو دستگاه است؛ دستگاه تازه باید جداگانه تأیید شود. گفتگوهای قدیمی همچنان متن روشن‌اند. پاک‌کردن حافظهٔ مرورگر بدون فایل بازیابی، تاریخچهٔ امن را از دسترس خارج می‌کند.</p><details><summary>هویت این دستگاه و بازیابی</summary><p dir="ltr">${esc(who)}<br>${esc(view.device||'')}</p><code dir="ltr" style="overflow-wrap:anywhere;display:block">${view.key?await fingerprint(view.key):''}</code><p class="session-help">بازیابی فقط تاریخچهٔ این دستگاه را برمی‌گرداند و کلید تازه می‌سازد؛ پیام‌های دریافت‌نشده و ادامهٔ نشست قدیمی برنمی‌گردند. فایل و رمز را جدا نگه دارید.</p><label>رمز فایل<input id="secure-password" class="form-input" type="password" minlength="12" autocomplete="new-password"></label><div class="button-row"><button id="secure-export" class="quiet-button">دریافت فایل بازیابی</button><label class="quiet-button">بازیابی فایل<input id="secure-import" type="file" accept="application/json" hidden></label><button id="secure-devices" class="quiet-button">دستگاه‌های امن و لغو دسترسی</button></div></details><div class="button-row feature-section"><button id="secure-sync" class="quiet-button">همگام‌سازی</button><span>${view.queued} پیام در صف محلی · ${view.serverQueued} در صف سرور · ${view.pending.length} پیام منتظر تأیید</span></div>${view.deliveryError?`<p role="alert">${esc(view.deliveryError)}؛ پیام رمز‌شده در صف می‌ماند.</p>`:''}<form id="secure-lookup" class="feature-form"><label>نشانی کامل مخاطب<input id="secure-address" class="form-input" dir="ltr" placeholder="user@server.workers.dev" required></label><button class="btn-primary">یافتن دستگاه و شروع گفتگوی امن</button></form><div id="secure-choices"></div><div class="settings-list">${view.threads.map((t,i)=>`<button id="secure-thread-${i}" class="settings-row"><span>${esc(t.peer)}<small dir="ltr">${esc(t.peerDevice)} ${t.archived?'· تاریخچهٔ فقط خواندنی':''}</small></span></button>`).join('')}</div>${view.pending.filter(e=>e.kind==='welcome').map((e,i)=>`<button id="secure-invite-${i}" class="quiet-button">تأیید دعوت امن از ${esc(e.from)}</button>`).join('')}${thread?`<section class="feature-section"><h4>${esc(thread.peer)} · امن آزمایشی</h4><label>جستجو در همین دستگاه<input id="secure-search" class="form-input"></label><div id="secure-history"></div>${thread.archived?'':`<form id="secure-compose" class="feature-form"><label>پیام<textarea id="secure-text" class="form-input" maxlength="8000" required></textarea></label><label>شناسهٔ پیام برای پاسخ اختیاری<input id="secure-reply" class="form-input" dir="ltr"></label><button class="btn-primary">ارسال رمز‌شده</button></form>`}<button id="secure-block" class="quiet-button danger-text">مسدودکردن نشانی</button></section>`:''}${view.alerts.length?'<p role="alert">'+esc(view.alerts.at(-1).message)+'</p>':''}`);
    function history(){if(!thread)return;const query=by('secure-search').value.toLocaleLowerCase();by('secure-history').innerHTML=thread.messages.filter(m=>m.text.toLocaleLowerCase().includes(query)).map(m=>`<article class="feature-section"><small>${esc(m.from)} · <bdi>${esc(m.id)}</bdi>${m.delivery?' · '+({'local-queued':'در صف این دستگاه','server-queued':'در صف سرور',delivered:'رسیده به سرور مقصد'}[m.delivery]||''):''}</small>${m.replyTo?`<blockquote>پاسخ به ${esc(thread.messages.find(p=>p.id===m.replyTo)?.text||m.replyTo)}</blockquote>`:''}<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.text)}</p></article>`).join('');}
    history();by('secure-search')?.addEventListener('input',history);
    const root=by('secure-lookup');
    refreshView=async()=>{if(busy||by('secure-lookup')!==root||by('secure-choices')?.children.length)return;if(JSON.stringify(await client.view())===JSON.stringify(view))return;const focused=document.activeElement?.id,selection=document.activeElement?.selectionStart,drafts={};for(const id of ['secure-text','secure-reply','secure-search','secure-address','secure-password'])if(by(id))drafts[id]=by(id).value;await render();for(const [id,value] of Object.entries(drafts))if(by(id))by(id).value=value;by('secure-search')?.dispatchEvent(new Event('input'));if(focused&&by(focused)){by(focused).focus({preventScroll:true});if(typeof selection==='number')by(focused).setSelectionRange?.(selection,selection);}};
    bind('secure-sync',async()=>{await client.sync();await render();});
    bind('secure-compose',async()=>{await client.send(selected,by('secure-text').value,by('secure-reply').value||null);await render();},'submit');
    view.threads.forEach((t,i)=>bind('secure-thread-'+i,async()=>{selected=t.id;await render();}));
    view.pending.filter(e=>e.kind==='welcome').forEach((e,i)=>bind('secure-invite-'+i,()=>verifyForm(e.from,e.fromDevice,e.senderKey,async()=>{selected=e.thread;await client.sync();await render();})));
    bind('secure-lookup',async()=>{await lookup(by('secure-address').value);},'submit');
    async function lookup(value){lookupWho=value.trim().toLowerCase();devices=await client.lookup(lookupWho);by('secure-choices').innerHTML=devices.length?devices.map((d,i)=>`<button id="secure-choice-${i}" class="quiet-button">تأیید دستگاه <bdi>${esc(d.device)}</bdi></button>`).join(''):'<p>دستگاه آماده‌ای پیدا نشد؛ مخاطب باید گفتگوی امن را باز کند و همگام‌سازی کند.</p>';devices.forEach((d,i)=>bind('secure-choice-'+i,()=>verifyForm(lookupWho,d.device,d.identityKey,async()=>{selected=await client.start(lookupWho,d);await render();})));}
    if(initialAddress){const address=initialAddress;initialAddress='';by('secure-address').value=address;await lookup(address);}
    bind('secure-export',async()=>{const text=await client.exportRecovery(by('secure-password').value),link=document.createElement('a');link.href=URL.createObjectURL(new Blob([text],{type:'application/json'}));link.download='wihm-secure-recovery.json';link.click();URL.revokeObjectURL(link.href);status('فایل بازیابی را بیرون از این دستگاه نگه دارید.');});
    bind('secure-import',async()=>{const file=by('secure-import').files?.[0];if(!file)return;await client.importRecovery(await file.text(),by('secure-password').value);selected='';await render();},'change');
    bind('secure-devices',async()=>{const result=await request('/api/secure/devices','GET');show('دستگاه‌های امن',`<p class="session-help">لغو دستگاه، پیام‌های قبلاً ذخیره‌شده روی آن را پاک نمی‌کند. برای ادامه با دستگاه تازه، اثر انگشت دوباره تأیید می‌شود.</p>${result.devices.map((d,i)=>`<div class="member-row"><bdi>${esc(d.device)}</bdi><button id="secure-revoke-${i}" class="quiet-button danger-text">لغو دسترسی</button></div>`).join('')}`);result.devices.forEach((d,i)=>bind('secure-revoke-'+i,async()=>{await client.revoke(d.device);if(d.device===view.device){status('دستگاه لغو شد؛ برای ساخت دستگاه تازه این صفحه را دوباره باز کنید.');return;}await render();}));});
    bind('secure-block',async()=>{await request('/api/secure/blocks','POST',{address:thread.peer});status('نشانی مسدود شد.');});
  }
  show('گفتگوی امن آزمایشی','<p>در حال آماده‌سازی کلیدهای محلی…</p>');
  try{await client.sync();await render();}catch(e){error(e.message);}
}};
