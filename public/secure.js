// Experimental RFC 9420 text chats. Device verification is an application trust boundary.
// Every pair of devices has its own two-member MLS group, as WhatsApp does with Signal sessions. A shared group
// would need one ordered list of commits, and these mailboxes, which can span servers, have no such order.
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
const listData=(who,list)=>JSON.stringify(['wihm-device-list/1',who,list.version,list.devices.map(d=>[d.device,d.key]),list.signer]);
const pairOf=(who,device)=>who+'|'+device;
// Six groups of four digits, about 80 bits: a person compares it at a glance, and forging a match is out of reach.
export async function safetyCode(keys){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify([...new Set(keys)].sort())))),view=new DataView(bytes.buffer);return Array.from({length:6},(_,i)=>String(view.getUint32(i*4)%10000).padStart(4,'0')).join(' ');}
// Both people's devices find the same conversation without having to agree on anything.
async function conversationId(a,b){const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify([a,b].sort()))))].map(x=>x.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-');}
function mlsDecode(encoded,format){const bytes=unb64(encoded),decoded=decodeMlsMessage(bytes,0);if(!decoded||decoded[1]!==bytes.length||decoded[0].wireformat!==format)fail('قالب پیام MLS معتبر نیست.');return decoded[0];}
const packState=state=>b64(encodeGroupState(state));
function validateAddress(who){if(typeof who!=='string'||who.length>300||!/^[a-z0-9_]{3,20}@[a-z0-9.-]+$/.test(who)||new URL('https://'+who.split('@')[1]).hostname!==who.split('@')[1])fail('نشانی کامل حساب معتبر نیست.');return who;}

export async function createSecureClient({address,storage,request,lock=(_name,fn)=>fn()}){
  validateAddress(address);const impl=await getCiphersuiteImpl(getCiphersuiteFromName(suite));
  let serial=Promise.resolve();
  const exclusive=fn=>{const task=serial.then(()=>lock('wihm-mls:'+address,fn));serial=task.catch(()=>{});return task;};
  // Before version 2 a thread was one MLS group, and that group becomes its first session.
  const load=async()=>{
    const state=await storage.load()||{version:2,address,device:null,threads:{},sessions:{},lists:{},trusted:{},pending:[],cursor:0,outbox:[],alerts:[]};
    if(state.version<2||!state.sessions){state.sessions={};state.lists={};for(const thread of Object.values(state.threads)){if(thread.state)state.sessions[thread.id]={id:thread.id,conversation:thread.id,peer:thread.peer,peerDevice:thread.peerDevice,peerKey:thread.peerKey,state:thread.state,seen:thread.seen||[],archived:thread.archived};thread.state='';}state.version=2;}
    return state;
  };
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
  function requireTrusted(state,thread){if(state.trusted[pairOf(thread.peer,thread.peerDevice)]!==thread.peerKey)fail('ابتدا اثرانگشت این دستگاه را از راه دیگری با مخاطب تطبیق دهید.');if(thread.archived)fail('این تاریخچه بازیابی‌شده فقط خواندنی است؛ گفتگوی امن تازه بسازید.');}
  async function signedEnvelope(state,thread,kind,payload,id=crypto.randomUUID()){
    const e={id,thread:thread.id,from:address,fromDevice:state.device.id,to:thread.peer,toDevice:thread.peerDevice,kind,payload,senderKey:state.device.key};
    e.signature=b64(await impl.signature.sign(unb64(state.device.private),enc.encode(envelopeData(e))));return e;
  }
  async function verifiedEnvelope(state,e){
    if(e.to!==address||e.toDevice!==state.device.id||!['message','control','welcome'].includes(e.kind)||unb64(e.senderKey).length!==32||!await impl.signature.verify(unb64(e.senderKey),enc.encode(envelopeData(e)),unb64(e.signature)))fail('امضا یا مقصد پیام امن معتبر نیست.');validateAddress(e.from);
  }
  const alert=(state,message)=>{state.alerts.push({id:crypto.randomUUID(),message});state.alerts=state.alerts.slice(-30);};
  async function listValid(who,list){
    if(!list||!Number.isSafeInteger(list.version)||list.version<1||!Array.isArray(list.devices)||!list.devices.length||list.devices.length>10)return false;
    try{return await impl.signature.verify(unb64(list.signer),enc.encode(listData(who,list)),unb64(list.signature));}catch{return false;}
  }
  function applyList(state,who,list){
    const before=state.lists[who]?.devices||[];
    for(const d of list.devices){if(before.length&&!before.some(old=>old.device===d.device)&&who!==address)alert(state,'مخاطب '+who+' دستگاه تازه‌ای به حساب خود افزوده است.');state.trusted[pairOf(who,d.device)]=d.key;}
    for(const d of before)if(!list.devices.some(next=>next.device===d.device)){delete state.trusted[pairOf(who,d.device)];for(const session of Object.values(state.sessions))if(session.peer===who&&session.peerDevice===d.device)session.archived=true;}
    state.lists[who]=list;
  }
  async function publishList(state,devices){
    const previous=Math.max(state.lists[address]?.version||0,state.seenListVersion||0),list={version:previous+1,devices,signer:state.device.key};
    list.signature=b64(await impl.signature.sign(unb64(state.device.private),enc.encode(listData(address,list))));
    await request('/api/secure/device-list','PUT',list);applyList(state,address,list);state.linked=true;await save(state);
  }
  // shortcut: the server can hide a newer list, which delays a removal until the list is seen. Showing a device its own removal needs signed list history.
  async function syncOwnList(state,force){
    if(!force&&state.linked&&Date.now()-(state.ownListAt||0)<60000)return;
    const {list}=await request('/api/secure/device-list','GET'),me=state.device,entry={device:me.id,key:me.key};state.ownListAt=Date.now();
    if(!list){await publishList(state,[entry]);return;}
    state.seenListVersion=list.version;
    if(!await listValid(address,list))return;
    const included=list.devices.some(d=>d.device===me.id&&d.key===me.key),known=state.lists[address];
    if(included&&known){
      if(list.version>known.version&&known.devices.some(d=>d.key===list.signer))applyList(state,address,list);
      state.linked=true;
    }else if(included){
      // The first list this device sees must be confirmed by a person, or the server could add its own device to it.
      if(list.signer===me.key){applyList(state,address,list);state.linked=true;}else state.pendingLink=list;
    }else{
      state.linked=false;
      const {devices}=await request('/api/secure/devices','GET');
      // Every listed device is gone, as after a recovery, so this device starts a new list and contacts must verify it again.
      if(!list.devices.some(d=>devices.some(active=>active.device===d.device)))await publishList(state,[entry]);
    }
    await save(state);
  }
  // shortcut: a signer added after this device last looked counts as a key change the person must accept. Following it silently needs the server to keep every version.
  async function refreshPeer(state,who){
    const {list}=await request('/api/secure/device-lists','POST',{address:who});if(!list)return;
    const known=state.lists[who];if(known&&list.version<=known.version)return;
    if(!await listValid(who,list))return;
    const signerTrusted=Object.entries(state.trusted).some(([pair,key])=>pair.startsWith(who+'|')&&key===list.signer);
    if(!signerTrusted){if(Object.keys(state.trusted).some(pair=>pair.startsWith(who+'|')))(state.keyChanges||={})[who]=list;return;}
    if(list.devices.some(d=>{const old=state.trusted[pairOf(who,d.device)];return old&&old!==d.key;})){(state.keyChanges||={})[who]=list;return;}
    applyList(state,who,list);
  }
  async function refreshPeers(state,force){
    if(!force&&Date.now()-(state.peersAt||0)<300000)return;state.peersAt=Date.now();
    for(const who of new Set(Object.values(state.threads).filter(t=>!t.archived).map(t=>t.peer)))try{await refreshPeer(state,who);}catch{/* Offline; the known list still applies. */}
  }
  const newestSession=(state,who,device)=>Object.values(state.sessions).filter(x=>x.peer===who&&x.peerDevice===device&&!x.archived&&x.state).at(-1);
  async function openSession(state,who,device,kp,conversation){
    const session={id:crypto.randomUUID(),conversation,peer:who,peerDevice:device.device,peerKey:device.identityKey,state:'',seen:[]};requireTrusted(state,session);
    const packageId=await fingerprint(device.keyPackage);state.spentPackages||=[];if(state.spentPackages.includes(packageId))fail('این بستهٔ کلید قبلاً مصرف شده است؛ دستگاه مخاطب را دوباره پیدا کنید.');
    const own=await makePackage(state.device),created=await createGroup(enc.encode(session.id),own.publicPackage,own.privatePackage,[],impl,config(state,session));
    const commit=await createCommit({state:created,cipherSuite:impl},{extraProposals:[{proposalType:'add',add:{keyPackage:kp}}],ratchetTreeExtension:true});
    session.state=packState(commit.newState);state.sessions[session.id]=session;state.spentPackages.push(packageId);
    state.outbox.push(await signedEnvelope(state,session,'welcome',b64(encodeMlsMessage({version:'mls10',wireformat:'mls_welcome',welcome:commit.welcome}))));commit.consumed.forEach(zeroOutUint8Array);
    return session;
  }
  // Seals one copy for one device. Old clients read id, thread, text and replyTo, and ignore the rest.
  async function seal(state,session,content){
    const id=crypto.randomUUID(),result=await createApplicationMessage(unpack(state,session),enc.encode(JSON.stringify({...content,id,thread:session.id})),impl);
    // The server learns only that this one should not notify anybody.
    const e=await signedEnvelope(state,session,content.op||content.hello||content.trusted?'control':'message',b64(encodeMlsMessage({version:'mls10',wireformat:'mls_private_message',privateMessage:result.privateMessage})),id);
    session.state=packState(result.newState);session.seen.push(id);result.consumed.forEach(zeroOutUint8Array);state.outbox.push(e);return e;
  }
  // A device with no session yet gets one, and a hello that names the conversation.
  // A new device has verified nobody, so your other devices pass on who you verified.
  async function shareTrust(state,trusted){
    const entries=Object.entries(trusted).filter(([pair])=>!pair.startsWith(address+'|')),sessions=await sessionsFor(state,address,null);
    for(let i=0;i<entries.length;i+=20)for(const session of sessions)await seal(state,session,{text:'',replyTo:null,trusted:Object.fromEntries(entries.slice(i,i+20))});
  }
  async function sessionsFor(state,who,thread){
    const targets=Object.entries(state.trusted).filter(([pair])=>pair.startsWith(who+'|')).map(([pair,key])=>({device:pair.slice(who.length+1),key})).filter(d=>!(who===address&&d.device===state.device.id));
    const missing=targets.filter(d=>!newestSession(state,who,d.device)),sessions=targets.map(d=>newestSession(state,who,d.device)).filter(Boolean);
    if(missing.length){
      let claimed=[];try{claimed=(await request('/api/secure/keys','POST',{address:who})).devices||[];}catch{/* Offline; the next message tries again. */}
      for(const d of missing){
        const device=claimed.find(c=>c.device===d.device&&c.identityKey===d.key);if(!device)continue;
        try{const session=await openSession(state,who,device,await checkDevice(who,device),thread?.id||'');await seal(state,session,thread?{hello:true,text:'',replyTo:null,conv:thread.id,peer:thread.peer}:{text:'',replyTo:null,trusted:{}});sessions.push(session);}catch(error){alert(state,error.message);}
      }
    }
    return sessions;
  }
  // Seals one message for the contact's devices and your own other devices.
  async function fanout(state,thread,content){
    if(thread.request)fail('ابتدا درخواست این گفتگو را بپذیرید.');
    try{await syncOwnList(state);await refreshPeers(state);}catch{/* Offline; the known lists still apply. */}
    const peers=await sessionsFor(state,thread.peer,thread);if(!peers.length)fail('ابتدا اثرانگشت این دستگاه را از راه دیگری با مخاطب تطبیق دهید.');
    const mine=state.linked?await sessionsFor(state,address,thread):[],sealed=[];
    for(const session of [...peers,...mine])sealed.push(await seal(state,session,{...content,conv:thread.id,peer:thread.peer}));
    return sealed;
  }
  // Only the author edits or deletes a message; a change to something unknown is dropped.
  function applyOp(thread,content,from){
    if(content.op==='read'){if(!Array.isArray(content.ids))return;for(const m of thread.messages)if(content.ids.includes(m.id)){if(from===address){if(m.from!==address)m.read=true;}else if(m.from===address)m.delivery='read';}return;}
    const target=thread.messages.find(m=>m.id===content.target);if(!target||target.deleted)return;
    if(content.op==='react'){if(typeof content.emoji!=='string'||content.emoji.length>16)return;target.reactions||={};if(content.emoji)target.reactions[from]=content.emoji;else delete target.reactions[from];return;}
    if(target.from!==from)return;
    if(content.op==='edit'&&content.text.trim()){target.text=content.text;target.edited=true;}
    if(content.op==='delete'){target.text='';target.deleted=true;target.replyTo=null;delete target.reactions;}
  }
  async function act(threadId,content,check){return exclusive(async()=>{const state=await load(),thread=state.threads[threadId];if(!thread)fail('گفتگوی امن پیدا نشد.');if(thread.archived)fail('این تاریخچه بازیابی‌شده فقط خواندنی است؛ گفتگوی امن تازه بسازید.');
    const full={text:'',replyTo:null,...content},target=thread.messages.find(m=>m.id===content.target);check?.(target);await fanout(state,thread,full);applyOp(thread,full,address);await save(state);await flush(state);});}
  const ownMessage=target=>{if(!target||target.deleted||target.from!==address)fail('فقط پیام خودتان را می‌توانید تغییر دهید.');};
  const contactKeys=(state,who)=>[state.device.key,...Object.entries(state.trusted).filter(([pair])=>pair.startsWith(who+'|')||pair.startsWith(address+'|')).map(([,key])=>key)];
  async function acceptPending(state){
    const waiting=[];
    state.pending.sort((a,b)=>Number(a.envelope.kind!=='welcome')-Number(b.envelope.kind!=='welcome'));
    for(const item of state.pending){
      const e=item.envelope;
      try{
        await verifiedEnvelope(state,e);
        // Someone new can only leave a request. A known contact's unknown device still waits, so the server cannot add one.
        const trustedSender=state.trusted[pairOf(e.from,e.fromDevice)]===e.senderKey;
        if(!trustedSender&&(e.from===address||Object.keys(state.trusted).some(pair=>pair.startsWith(e.from+'|')))){waiting.push(item);continue;}
        let session=state.sessions[e.thread];
        if(e.kind==='welcome'){
          if(session)continue;
          const welcome=mlsDecode(e.payload,'mls_welcome').welcome;let joined,consumedPackage;
          session={id:e.thread,conversation:'',peer:e.from,peerDevice:e.fromDevice,peerKey:e.senderKey,seen:[],state:''};
          for(const item of state.device.packages.filter(p=>!p.used&&welcome.secrets.some(s=>b64(s.newMember)===p.ref))){
            try{joined=await joinGroup(welcome,mlsDecode(item.encoded,'mls_key_package').keyPackage,Object.fromEntries(Object.entries(item.private).map(([k,v])=>[k,unb64(v)])),emptyPskIndex,impl,undefined,undefined,config(state,session));consumedPackage=item;break;}catch{}
          }
          if(!joined||!consumedPackage)fail('کلید دعوت موجود نیست، منقضی است یا قبلاً مصرف شده است.');
          const leaves=joined.ratchetTree.filter(n=>n?.nodeType==='leaf');
          if(dec.decode(joined.groupContext.groupId)!==e.thread||leaves.length!==2||!leaves.some(n=>b64(n.leaf.signaturePublicKey)===e.senderKey&&dec.decode(n.leaf.credential.identity)===credential(e.from,e.fromDevice)))fail('اعضای دعوت با دستگاه تأییدشده مطابقت ندارند.');
          session.state=packState(joined);session.seen.push(e.id);state.sessions[e.thread]=session;consumedPackage.used=true;delete consumedPackage.private;
        }else{
          if(!session){waiting.push(item);continue;}
          if(session.archived||session.peer!==e.from||session.peerDevice!==e.fromDevice||session.peerKey!==e.senderKey)fail('فرستنده با این گفتگوی امن مطابقت ندارد.');
          if(session.seen.includes(e.id))continue;
          const result=await processPrivateMessage(unpack(state,session),mlsDecode(e.payload,'mls_private_message').privateMessage,emptyPskIndex,impl);
          if(result.kind!=='applicationMessage')fail('تغییر عضویت خودکار مجاز نیست؛ گفتگوی تأییدشدهٔ تازه بسازید.');
          const content=JSON.parse(dec.decode(result.message));if(content.id!==e.id||content.thread!==e.thread||typeof content.text!=='string'||content.text.length>8000||content.replyTo!==null&&typeof content.replyTo!=='string')fail('محتوای رمزگشایی‌شده معتبر نیست.');
          session.state=packState(result.newState);session.seen.push(e.id);result.consumed.forEach(zeroOutUint8Array);
          if(e.from===address&&content.trusted&&typeof content.trusted==='object'){for(const [pair,key] of Object.entries(content.trusted))if(typeof key==='string'&&pair.includes('|')&&!pair.startsWith(address+'|'))state.trusted[pair]??=key;for(const t of Object.values(state.threads))if(t.request&&Object.keys(state.trusted).some(pair=>pair.startsWith(t.peer+'|')))t.request=false;continue;}
          // Only your own devices may say who a conversation is with; a contact is always the conversation itself.
          const own=e.from===address,other=own?content.peer:e.from,conversationKey=typeof content.conv==='string'&&/^[0-9a-f-]{36}$/.test(content.conv)?content.conv:e.thread;
          validateAddress(other);if(other===address)fail('مقصد گفتگوی امن معتبر نیست.');
          session.conversation=conversationKey;
          const thread=state.threads[conversationKey]||={id:conversationKey,peer:other,peerDevice:own?'':e.fromDevice,peerKey:own?'':e.senderKey,messages:[],seen:[],state:''};
          if(thread.peer!==other||thread.archived&&trustedSender)fail('فرستنده با این گفتگوی امن مطابقت ندارد.');
          if(!trustedSender){thread.archived=false;thread.request=true;}
          if(content.op){applyOp(thread,content,e.from);continue;}
          const messageId=typeof content.mid==='string'?content.mid:e.id;
          if(!content.hello&&!thread.messages.some(m=>m.id===messageId))thread.messages.push({id:messageId,text:content.text,replyTo:content.replyTo,from:e.from,createdAt:Date.now()});
        }
      }catch(error){state.alerts.push({id:e.id,message:error.message});}
    }
    state.pending=waiting;state.alerts=state.alerts.slice(-30);await save(state);
  }
  async function flush(state){
    const remaining=[];state.deliveryError='';state.serverQueue||=[];
    for(const e of state.outbox){
      const copy=state.copies?.[e.id];
      try{const result=await request('/api/secure/send','POST',e),message=copy&&e.to!==address?state.threads[copy.thread]?.messages.find(m=>m.id===copy.message):null;if(message&&!['delivered','read'].includes(message.delivery))message.delivery=result.queued?'server-queued':'delivered';if(result.queued&&!state.serverQueue.some(x=>x.id===e.id))state.serverQueue.push({id:e.id,thread:copy?.thread,message:copy?.message});if(copy)delete state.copies[e.id];}
      // A device removed since this was sealed will never take it, and must not hold up the rest.
      catch(error){if(error.status===404||error.message==='مقصد در دسترس نیست یا پیام را نمی‌پذیرد.')continue;remaining.push(e);state.deliveryError=error.message;}
    }
    state.outbox=remaining;await save(state);
    const pending=[];for(const item of state.serverQueue){try{const result=await request('/api/secure/delivery?id='+item.id,'GET');if(!result.deliveredAt){pending.push(item);continue;}const message=state.threads[item.thread]?.messages.find(m=>m.id===(item.message||item.id));if(message&&message.delivery!=='read')message.delivery='delivered';}catch{pending.push(item);}}
    state.serverQueue=pending;await save(state);
  }
  return {
    async init(){return exclusive(async()=>{const state=await load();if(state.address!==address)fail('این حافظه برای حساب دیگری است.');if(!state.device){state.device=await makeDevice();await save(state);}await replenish(state);await syncOwnList(state,true);return {device:state.device.id,key:state.device.key,fingerprint:await fingerprint(state.device.key)};});},
    async lookup(who){validateAddress(who);const result=await request('/api/secure/keys','POST',{address:who});if(result.address!==who||!Array.isArray(result.devices))fail('پاسخ مقصد معتبر نیست.');for(const device of result.devices){await checkDevice(who,device);device.fingerprint=await fingerprint(device.identityKey);}return result.devices;},
    async trust(who,device,key,confirmation){validateAddress(who);if(confirmation.replace(/\s/g,'').toUpperCase()!==await fingerprint(key))fail('اثر انگشت کامل با کلید نمایش‌داده‌شده مطابقت ندارد.');return exclusive(async()=>{const state=await load(),id=pairOf(who,device),previous=state.trusted[id];state.trusted[id]=key;if(previous&&previous!==key)for(const session of Object.values(state.sessions))if(session.peer===who&&session.peerDevice===device)session.archived=true;try{await refreshPeer(state,who);}catch{/* Offline; the next sync looks again. */}await acceptPending(state);if(state.linked&&who!==address){await shareTrust(state,{[id]:key});await save(state);await flush(state);}});},
    async start(who,device){return exclusive(async()=>{const state=await load(),kp=await checkDevice(who,device),conversation=await conversationId(address,who),thread=state.threads[conversation]||{id:conversation,peer:who,peerDevice:device.device,peerKey:device.identityKey,messages:[],seen:[],state:''};
      const session=await openSession(state,who,device,kp,conversation);state.threads[conversation]=thread;await seal(state,session,{hello:true,text:'',replyTo:null,conv:conversation,peer:who});await save(state);await flush(state);return conversation;});},
    // Works without any code: the first contact is trusted, as in WhatsApp and Signal, and later key changes are shown.
    async invite(who,text){validateAddress(who);if(who===address)fail('مقصد گفتگوی امن معتبر نیست.');if(typeof text!=='string'||!text.trim()||text.length>8000)fail('پیام باید بین یک تا ۸۰۰۰ حرف باشد.');return exclusive(async()=>{const state=await load(),id=await conversationId(address,who);let thread=state.threads[id];if(thread?.request)fail('ابتدا درخواست این گفتگو را بپذیرید.');
      if(!Object.keys(state.trusted).some(pair=>pair.startsWith(who+'|'))){
        const claimed=await request('/api/secure/keys','POST',{address:who});if(claimed.address!==who||!Array.isArray(claimed.devices))fail('پاسخ مقصد معتبر نیست.');
        const {list}=await request('/api/secure/device-lists','POST',{address:who}),listed=await listValid(who,list)?list.devices:null,devices=claimed.devices.filter(d=>!listed||listed.some(x=>x.device===d.device&&x.key===d.identityKey));
        if(!devices.length)fail('این مخاطب هنوز گفتگوی امن را باز نکرده است. از او بخواهید یک بار آن را باز کند.');
        thread=state.threads[id]={...thread,id,peer:who,peerDevice:devices[0].device,peerKey:devices[0].identityKey,messages:thread?.messages||[],seen:[],state:'',archived:false};
        if(listed)state.lists[who]=list;
        for(const device of devices){const kp=await checkDevice(who,device);state.trusted[pairOf(who,device.device)]=device.identityKey;await seal(state,await openSession(state,who,device,kp,id),{hello:true,text:'',replyTo:null,conv:id,peer:who});}
      }
      thread=state.threads[id]||={id,peer:who,peerDevice:'',peerKey:'',messages:[],seen:[],state:''};thread.archived=false;
      const message=crypto.randomUUID();state.copies||={};
      for(const e of await fanout(state,thread,{text,replyTo:null,mid:message}))state.copies[e.id]={thread:id,message};
      thread.messages.push({id:message,text,replyTo:null,from:address,createdAt:Date.now(),delivery:'local-queued'});await save(state);await flush(state);return id;});},
    async acceptRequest(threadId){return exclusive(async()=>{const state=await load(),thread=state.threads[threadId];if(!thread?.request)fail('درخواستی پیدا نشد.');
      for(const session of Object.values(state.sessions))if(session.peer===thread.peer&&!session.archived)state.trusted[pairOf(session.peer,session.peerDevice)]=session.peerKey;
      thread.request=false;try{await refreshPeer(state,thread.peer);}catch{/* Offline; the next sync looks again. */}
      await acceptPending(state);if(state.linked)await shareTrust(state,Object.fromEntries(Object.entries(state.trusted).filter(([pair])=>pair.startsWith(thread.peer+'|'))));await save(state);await flush(state);});},
    async rejectRequest(threadId){return exclusive(async()=>{const state=await load(),thread=state.threads[threadId];if(!thread?.request)fail('درخواستی پیدا نشد.');
      await request('/api/secure/blocks','POST',{address:thread.peer});
      for(const session of Object.values(state.sessions))if(session.peer===thread.peer)delete state.sessions[session.id];
      delete state.threads[threadId];state.pending=state.pending.filter(item=>item.envelope.from!==thread.peer);await save(state);});},
    async contactCode(who){const state=await load();return safetyCode(contactKeys(state,who));},
    async verifyContact(who){return exclusive(async()=>{const state=await load();(state.verified||={})[who]=await safetyCode(contactKeys(state,who));await save(state);});},
    async acceptKeyChange(who){return exclusive(async()=>{const state=await load(),list=state.keyChanges?.[who];if(!list)fail('تغییری در انتظار نیست.');
      for(const pair of Object.keys(state.trusted))if(pair.startsWith(who+'|'))delete state.trusted[pair];
      for(const session of Object.values(state.sessions))if(session.peer===who)session.archived=true;
      delete state.lists[who];applyList(state,who,list);delete state.keyChanges[who];await acceptPending(state);await save(state);});},
    async send(threadId,text,replyTo=null){if(typeof text!=='string'||!text.trim()||text.length>8000||replyTo!==null&&typeof replyTo!=='string')fail('پیام باید بین یک تا ۸۰۰۰ حرف باشد.');return exclusive(async()=>{const state=await load(),thread=state.threads[threadId];if(!thread)fail('گفتگوی امن پیدا نشد.');if(thread.archived)fail('این تاریخچه بازیابی‌شده فقط خواندنی است؛ گفتگوی امن تازه بسازید.');
      const message=crypto.randomUUID();state.copies||={};
      for(const e of await fanout(state,thread,{text,replyTo,mid:message}))state.copies[e.id]={thread:threadId,message};
      thread.messages.push({id:message,text,replyTo,from:address,createdAt:Date.now(),delivery:'local-queued'});await save(state);await flush(state);return message;});},
    edit(threadId,target,text){if(typeof text!=='string'||!text.trim()||text.length>8000)fail('پیام باید بین یک تا ۸۰۰۰ حرف باشد.');return act(threadId,{op:'edit',target,text},ownMessage);},
    remove(threadId,target){return act(threadId,{op:'delete',target},ownMessage);},
    react(threadId,target,emoji){return act(threadId,{op:'react',target,emoji},m=>{if(!m||m.deleted)fail('پیام پیدا نشد.');});},
    markRead(threadId){return exclusive(async()=>{const state=await load(),thread=state.threads[threadId];if(!thread||thread.archived||thread.request)return;
      const unread=thread.messages.filter(m=>m.from!==address&&!m.read&&!m.deleted);if(!unread.length)return;
      for(const m of unread)m.read=true;
      // shortcut: only the newest 100 are reported, and older ones stay unread for the sender; send batches if chats ever come back after that long.
      await save(state);await fanout(state,thread,{text:'',replyTo:null,op:'read',ids:unread.slice(-100).map(m=>m.id)});await save(state);await flush(state);});},
    async sync(){return exclusive(async()=>{const state=await load();if(!state.device)fail('دستگاه امن را فعال کنید.');await syncOwnList(state);await refreshPeers(state);await flush(state);const result=await request('/api/secure/inbox?device='+state.device.id+'&after='+state.cursor,'GET');for(const item of result.events){if(!Number.isSafeInteger(item.sequence)||item.sequence<=state.cursor)continue;state.pending.push(item);state.cursor=item.sequence;}await save(state);await acceptPending(state);await replenish(state);return {pending:state.pending.length,queued:state.outbox.length};});},
    async view(){return exclusive(async()=>{const state=await load();const threads=await Promise.all(Object.values(state.threads).map(async({state:_,seen,...thread})=>({...thread,verified:!!state.device&&state.verified?.[thread.peer]===await safetyCode(contactKeys(state,thread.peer))})));return {device:state.device?.id,key:state.device?.key,linked:!!state.linked,pendingLink:state.pendingLink?await fingerprint(state.pendingLink.signer):'',pendingLinkCode:state.pendingLink?await safetyCode([state.pendingLink.signer]):'',keyChanges:Object.keys(state.keyChanges||{}),threadOfSession:Object.fromEntries(Object.values(state.sessions).map(x=>[x.id,x.conversation])),threads,pending:state.pending.map(x=>x.envelope),queued:state.outbox.length,serverQueued:state.serverQueue?.length||0,deliveryError:state.deliveryError||'',alerts:state.alerts,trusted:Object.fromEntries(Object.entries(state.trusted).filter(([pair])=>!pair.startsWith(address+'|')))};});},
    async exportRecovery(password){if(typeof password!=='string'||password.length<12)fail('رمز فایل بازیابی باید حداقل ۱۲ نویسه باشد.');return exclusive(async()=>{const state=await load(),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await recoveryKey(password,salt);
      // Recovery archives history and rotates the device on import, preventing ratchet rollback.
      const content={version:1,address,oldDevice:state.device.id,threads:Object.values(state.threads).map(({state,seen,...thread})=>({...thread,archived:true}))};
      return JSON.stringify({format:'wihm-secure-recovery/1',salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(address)},key,enc.encode(JSON.stringify(content)))))});});},
    async importRecovery(text,password){if(text.length>5000000)fail('فایل بازیابی بیش از حد بزرگ است.');const file=JSON.parse(text);if(file.format!=='wihm-secure-recovery/1'||unb64(file.salt).length!==16||unb64(file.iv).length!==12)fail('فایل بازیابی معتبر نیست.');let content;try{content=JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(file.iv),additionalData:enc.encode(address)},await recoveryKey(password,unb64(file.salt)),unb64(file.ciphertext))));}catch{fail('رمز، حساب یا فایل بازیابی درست نیست.');}
      if(content.version!==1||content.address!==address||!Array.isArray(content.threads)||content.threads.some(t=>!t||typeof t.id!=='string'||!/^[0-9a-f-]{36}$/.test(t.id)||!Array.isArray(t.messages)||typeof t.peer!=='string'||typeof t.peerDevice!=='string'||t.messages.some(m=>!m||typeof m.id!=='string'||typeof m.text!=='string'||typeof m.from!=='string'||m.replyTo!==null&&typeof m.replyTo!=='string')))fail('محتوای بازیابی معتبر نیست.');
      return exclusive(async()=>{const state=await load();if(state.outbox.length)fail('ابتدا پیام‌های صف فعلی را تحویل دهید.');await request('/api/secure/devices','DELETE',{device:content.oldDevice});for(const thread of Object.values(state.threads))thread.archived=true;for(const thread of content.threads)state.threads[thread.id]={...thread,archived:true,state:'',seen:[]};if(state.device)await request('/api/secure/devices','DELETE',{device:state.device.id});state.device=await makeDevice();state.cursor=0;state.pending=[];state.trusted={};state.sessions={};state.lists={};state.linked=false;state.verified={};state.keyChanges={};delete state.pendingLink;await save(state);await replenish(state);await syncOwnList(state,true);});},
    // Your own devices: what is listed, and what still waits to be approved from a listed device.
    async devices(){return exclusive(async()=>{const state=await load();await syncOwnList(state,true);const {devices}=await request('/api/secure/devices','GET'),list=state.lists[address]?.devices||[];
      return Promise.all(devices.map(async d=>({device:d.device,key:d.identityKey,fingerprint:await fingerprint(d.identityKey),current:d.device===state.device?.id,linked:list.some(x=>x.device===d.device&&x.key===d.identityKey)})));});},
    async link(device,key,confirmation){if(confirmation.replace(/\s/g,'').toUpperCase()!==await fingerprint(key))fail('اثر انگشت کامل با کلید نمایش‌داده‌شده مطابقت ندارد.');return exclusive(async()=>{const state=await load();await syncOwnList(state,true);if(!state.linked)fail('این دستگاه هنوز خودش تأیید نشده است؛ از یک دستگاه تأییدشده استفاده کنید.');const list=state.lists[address].devices;if(!list.some(d=>d.device===device))await publishList(state,[...list,{device,key}]);await shareTrust(state,state.trusted);await save(state);await flush(state);});},
    // The new device checks who approved it, so the server cannot approve it on another device's behalf.
    async confirmLink(confirmation){return exclusive(async()=>{const state=await load(),list=state.pendingLink;if(!list)fail('تأییدی در انتظار نیست.');if(confirmation.replace(/\s/g,'').toUpperCase()!==await fingerprint(list.signer))fail('اثر انگشت کامل با دستگاه تأییدکننده مطابقت ندارد.');applyList(state,address,list);state.linked=true;delete state.pendingLink;await acceptPending(state);await save(state);});},
    async revoke(device){return exclusive(async()=>{const state=await load();if(state.device?.id===device&&state.outbox.length)fail('ابتدا پیام‌های صف محلی را تحویل دهید.');await syncOwnList(state,true);
      const list=state.lists[address]?.devices||[],rest=list.filter(d=>d.device!==device);
      // The list goes first: a contact must stop trusting the device before the server stops knowing it.
      if(rest.length&&rest.length<list.length&&state.linked)await publishList(state,rest);
      await request('/api/secure/devices','DELETE',{device});
      if(state.device?.id===device){for(const session of Object.values(state.sessions)){session.archived=true;session.state='';}for(const thread of Object.values(state.threads))thread.archived=true;state.device=null;state.pending=[];state.cursor=0;state.trusted={};state.lists={};state.linked=false;}
      await save(state);});},
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
if(typeof window!=='undefined')window.WihmSecure={connect:connectBrowser,safetyCode,fingerprint,reset(){browserAccount='';browserClient=null;browserEpoch++;},async open({api,show,error,escape:esc,user}){
  if(!navigator.locks||!crypto.subtle){show('دستگاه‌های گفتگوی امن','<p>این مرورگر از ذخیرهٔ امن همزمان و رمزنگاری لازم پشتیبانی نمی‌کند. مرورگر را به‌روز کنید.</p>');return;}
  const {client}=await connectBrowser(api,user);
  let busy=false;
  const by=id=>document.getElementById(id),status=message=>{const e=by('feature-status');if(e)e.textContent=message;};
  const bind=(id,fn,event='click')=>{const e=by(id);if(e)e.addEventListener(event,async ev=>{ev.preventDefault();if(busy)return;busy=true;try{await fn();}catch(x){status(x.message);}finally{busy=false;}});};
  function compare(title,help,code,same){
    show(title,`<p class="session-help">${help}</p><code class="secure-code" dir="ltr">${esc(code)}</code><div class="button-row"><button id="secure-same" class="btn-primary">یکسان است</button><button id="secure-differs" class="quiet-button">یکسان نیست</button></div>`);
    bind('secure-same',same);bind('secure-differs',async()=>{await render();status('تأیید نشد. تا روشن‌شدن موضوع به این دستگاه اعتماد نکنید.');});
  }
  async function render(){
    const view=await client.view(),ownCode=view.key?await safetyCode([view.key]):'',list=await client.devices(),codes=await Promise.all(list.map(d=>safetyCode([d.key])));
    show('دستگاه‌های گفتگوی امن',`<p class="session-help">دستگاه تأییدشده پیام‌های امن تازهٔ شما را هم می‌خواند، پس فقط دستگاه خودتان را تأیید کنید. پیام‌های قبلی به دستگاه تازه نمی‌آیند و حذف دستگاه، چیزهایی را که قبلاً روی آن ذخیره شده پاک نمی‌کند.</p>${view.pendingLink?`<section class="feature-section"><h4>تأیید این دستگاه</h4><p class="session-help">این کد را با کد «این دستگاه» روی دستگاه قبلی‌تان مقایسه کنید.</p><code class="secure-code" dir="ltr">${esc(view.pendingLinkCode)}</code><div class="button-row"><button id="secure-confirm-link" class="btn-primary">یکسان است</button></div></section>`:view.linked?'':`<section class="feature-section"><h4>این دستگاه هنوز تأیید نشده است</h4><p class="session-help">روی دستگاه قبلی‌تان همین صفحه را باز کنید و این کد را تأیید کنید. تا آن زمان، گفتگوهای امن این دستگاه از دستگاه‌های دیگرتان جدا هستند.</p><code class="secure-code" dir="ltr">${esc(ownCode)}</code></section>`}<div class="settings-list">${list.map((d,i)=>`<div class="member-row"><div class="member-name"><strong>${d.current?'این دستگاه':d.linked?'دستگاه تأییدشده':'در انتظار تأیید'}</strong><small dir="ltr">${esc(codes[i])}</small></div><div class="member-actions">${d.linked||d.current?'':`<button id="secure-link-${i}" class="quiet-button">تأیید این دستگاه</button>`}<button id="secure-revoke-${i}" class="quiet-button danger-text">حذف</button></div></div>`).join('')}</div><details class="feature-section"><summary>فایل بازیابی</summary><p class="session-help">بازیابی فقط تاریخچهٔ این دستگاه را برمی‌گرداند و کلید تازه می‌سازد. پاک‌کردن حافظهٔ مرورگر بدون این فایل، تاریخچهٔ امن را از بین می‌برد. فایل و رمز را جدا نگه دارید.</p><label>رمز فایل<input id="secure-password" class="form-input" type="password" minlength="12" autocomplete="new-password"></label><div class="button-row"><button id="secure-export" class="quiet-button">دریافت فایل بازیابی</button><label class="quiet-button">بازیابی فایل<input id="secure-import" type="file" accept="application/json" hidden></label></div></details>`);
    bind('secure-confirm-link',async()=>{await client.confirmLink(view.pendingLink);await client.sync();await render();});
    list.forEach((d,i)=>{
      bind('secure-revoke-'+i,async()=>{if(!confirm('این دستگاه حذف شود؟'))return;await client.revoke(d.device);if(d.current){status('دستگاه حذف شد؛ برای ساخت دستگاه تازه این صفحه را دوباره باز کنید.');return;}await render();});
      bind('secure-link-'+i,async()=>compare('تأیید دستگاه تازه','آیا همین کد روی دستگاه تازهٔ شما نوشته شده است؟',codes[i],async()=>{await client.link(d.device,d.key,d.fingerprint);await render();status('حالا روی دستگاه تازه «یکسان است» را بزنید. کد این دستگاه: '+ownCode);}));
    });
    bind('secure-export',async()=>{const text=await client.exportRecovery(by('secure-password').value),link=document.createElement('a');link.href=URL.createObjectURL(new Blob([text],{type:'application/json'}));link.download='wihm-secure-recovery.json';link.click();URL.revokeObjectURL(link.href);status('فایل بازیابی را بیرون از این دستگاه نگه دارید.');});
    bind('secure-import',async()=>{const file=by('secure-import').files?.[0];if(!file)return;await client.importRecovery(await file.text(),by('secure-password').value);await render();},'change');
  }
  show('دستگاه‌های گفتگوی امن','<p>در حال آماده‌سازی…</p>');
  try{await client.sync();await render();}catch(e){error(e.message);}
}};
