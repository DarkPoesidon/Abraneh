// The browser shell waits for consent; server deployment is controlled separately.
(() => {
  const read=(key,fallback)=>{try{return localStorage.getItem(key)||fallback;}catch{return fallback;}};
  const version=document.querySelector('meta[name="wihm-version"]')?.content||'1.4.2';
  const state={version,available:null,mode:read('cf_msg_update_mode','notify'),checking:false,message:'',supported:'serviceWorker' in navigator};
  if(!['notify','automatic','manual'].includes(state.mode))state.mode='notify';
  let registration=null,waiting=null,changed=false,applying=false,options={},started=false,automaticTimer=null;
  const listeners=new Set();
  async function policy(patch){return new Promise((resolve,reject)=>{const request=indexedDB.open('wihm-update-policy',1);request.onupgradeneeded=()=>request.result.createObjectStore('policy');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,transaction=db.transaction('policy',patch?'readwrite':'readonly'),store=transaction.objectStore('policy'),read=store.get('current');let value;read.onsuccess=()=>{value={...(read.result||{}),...(patch||{})};if(patch)store.put(value,'current');};transaction.oncomplete=()=>{db.close();resolve(value||{});};transaction.onerror=()=>{db.close();reject(transaction.error);};};});}
  const emit=()=>{for(const callback of listeners)callback({...state});renderBanner();};
  function renderBanner(){const banner=document.getElementById('update-banner');if(!banner)return;const dismissed=read('cf_msg_update_later','');banner.hidden=!state.available||state.mode==='manual'||(state.mode==='notify'&&dismissed===state.available);const label=document.getElementById('update-banner-text');if(label)label.textContent=`نسخهٔ ${state.available||''} برای این دستگاه آماده است. دریافت شود؟`;}
  function automatic(){clearTimeout(automaticTimer);if(state.mode!=='automatic'||!state.available)return;automaticTimer=setTimeout(()=>{if(!options.canReload||options.canReload())apply().catch(()=>{});else automatic();},10_000);}
  async function inspectWaiting(){
    waiting=registration?.waiting||null;if(!waiting)return;
    let target='';
    if(typeof MessageChannel!=='undefined')target=await new Promise(resolve=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve('');},1500);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(typeof e.data?.version==='string'?e.data.version:'');};waiting.postMessage({type:'GET_VERSION'},[channel.port2]);});
    if(!target)try{target=(await(await fetch('/api/app/version',{cache:'no-store'})).json()).version;}catch{/* Remain ready when offline. */}
    state.available=target||'تازه';state.message='نسخهٔ جدید آماده است.';emit();automatic();
  }
  async function check(){
    if(!state.supported){state.message='این مرورگر نصب و به‌روزرسانی برنامه را پشتیبانی نمی‌کند.';emit();return;}
    state.checking=true;state.message='در حال بررسی…';emit();
    try{const response=await fetch('/api/app/version',{cache:'no-store'}),data=await response.json();if(response.ok&&/^\d+\.\d+\.\d+$/.test(data.version)&&data.version!==version)state.available=data.version;registration ||= await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});await registration.update().catch(()=>{});await inspectWaiting();state.message=state.available?'نسخهٔ جدید آماده است.':'نسخهٔ دستگاه با سرور فعلی یکسان است؛ دریافت ریلیز تازه نیاز به به‌روزرسانی سرور توسط مدیر دارد.';automatic();}
    catch{state.message='بررسی کامل نشد؛ اتصال اینترنت را بررسی و دوباره تلاش کنید.';}
    finally{state.checking=false;emit();}
  }
  async function apply(){
    if(options.prepareReload&&!options.prepareReload()){state.message='ابتدا متنِ داخل کادر را ارسال یا کپی کنید؛ سپس دوباره دریافت نسخه را بزنید.';emit();return false;}
    applying=true;
    try {
      if(changed){location.reload();return true;}
      if(!state.available){applying=false;return false;}
      await policy({approvedVersion:state.available,mode:state.mode});
      if(waiting)waiting.postMessage({type:'ACTIVATE_UPDATE'});
      else{registration ||= await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});await registration.update();await inspectWaiting();waiting?.postMessage({type:'ACTIVATE_UPDATE'});}
      return true;
    } catch {applying=false;state.message='به‌روزرسانی کامل نشد؛ اجازهٔ ذخیره‌سازی مرورگر و اتصال اینترنت را بررسی کنید.';emit();return false;}
  }
  function init(config={}){
    options=config;if(started)return;started=true;
    document.getElementById('btn-apply-update')?.addEventListener('click',()=>apply().catch(()=>{}));
    document.getElementById('btn-later-update')?.addEventListener('click',()=>{try{localStorage.setItem('cf_msg_update_later',state.available||'');}catch{}renderBanner();});
    if(!state.supported)return;
    const controlled=!!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(applying&&(!options.prepareReload||options.prepareReload())){location.reload();return;}applying=false;if(controlled){changed=true;state.available=state.available||'تازه';emit();automatic();}});
    policy({mode:state.mode}).catch(()=>{});
    navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(reg=>{registration=reg;inspectWaiting();reg.addEventListener('updatefound',()=>{const installing=reg.installing;installing?.addEventListener('statechange',()=>{if(installing.state==='installed'&&navigator.serviceWorker.controller)inspectWaiting();});});}).catch(()=>{});
    if(state.mode!=='manual')check();
    window.addEventListener('storage',event=>{if(event.key==='cf_msg_update_mode'&&['notify','automatic','manual'].includes(event.newValue)){state.mode=event.newValue;emit();automatic();}if(event.key==='cf_msg_update_later')renderBanner();});
    let last=Date.now();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&Date.now()-last>3600_000){last=Date.now();check();}automatic();});
  }
  window.WihmUpdates={init,check,apply,state:()=>({...state}),subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);},async setMode(mode){if(!['notify','automatic','manual'].includes(mode))return;await policy({mode});state.mode=mode;try{localStorage.setItem('cf_msg_update_mode',mode);localStorage.removeItem('cf_msg_update_later');}catch{}emit();automatic();}};
})();
