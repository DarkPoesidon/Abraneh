(() => {
  const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);};
  const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  async function key(password,salt,usage){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:310000},material,{name:'AES-GCM',length:256},false,usage);}
  async function encrypt(backup,password){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),data=new TextEncoder().encode(JSON.stringify(backup));if(data.length>32*1024*1024)throw Error('پشتیبان از سقف ۳۲ مگابایت این نسخه بیشتر است.');return {format:'wihm-encrypted-backup-v1',salt:encode(salt),iv:encode(iv),ciphertext:encode(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(password,salt,['encrypt']),data)))};}
  async function decrypt(file,password){
    if(typeof file!=='string'||file.length>46*1024*1024)throw Error('حجم فایل پشتیبان معتبر نیست.');
    try{const value=JSON.parse(file);if(value.format!=='wihm-encrypted-backup-v1'||typeof value.ciphertext!=='string'||decode(value.salt).length!==16||decode(value.iv).length!==12)throw Error();return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(value.iv)},await key(password,decode(value.salt),['decrypt']),decode(value.ciphertext))));}catch{throw Error('رمز پشتیبان اشتباه است یا فایل ناقص/نامعتبر است.');}
  }
  async function open({api,post,show,error,escape:esc,generation}){
    const view=show('پشتیبان رمز‌شده',`<p class="session-help">همهٔ کاربران، جدول‌ها و تاریخچهٔ اصلی گفتگوها پشتیبان می‌شوند؛ رمز ورود کاربران و کلیدهای سرویس هم داخل فایل رمز‌شده قرار می‌گیرند. رمز فایل فقط روی دستگاه شما استفاده می‌شود. کلیدهای خصوصی گفتگوی امنِ دستگاه جداگانه از بخش گفتگوی امن ذخیره می‌شوند.</p><p class="session-help">ارسال پیام‌ها هنگام دریافت موقتاً متوقف می‌شود و حداکثر پس از ۱۵ دقیقه باز می‌شود. سقف این نسخه ۲۰۰ گفتگو و ۳۲ مگابایت داده است. فایل را با آخرین نصب‌کنندهٔ همین نسخه فقط روی نصب تازه بازیابی کنید؛ سرویس فعلی پاک نمی‌شود.</p><form id="backup-form" class="feature-form"><label>رمز فعلی حساب مدیر<input id="backup-account-password" class="form-input" type="password" autocomplete="current-password" required></label><label>کد دومرحله‌ای؛ اگر فعال است<input id="backup-account-otp" class="form-input" dir="ltr" autocomplete="one-time-code"></label><label>رمز تازه برای فایل؛ حداقل ۱۲ کاراکتر<input id="backup-file-password" class="form-input" type="password" minlength="12" maxlength="1024" required></label><label>تکرار رمز فایل<input id="backup-file-confirm" class="form-input" type="password" required></label><button class="btn-primary">شروع و دریافت پشتیبان</button></form><p id="backup-progress" class="session-help" role="status"></p>`);
    document.getElementById('backup-form').addEventListener('submit',async event=>{
      event.preventDefault();const button=event.target.querySelector('button'),progress=document.getElementById('backup-progress');let id='',finished=false;
      try{
        const password=document.getElementById('backup-file-password').value;
        if(password.length<12||password!==document.getElementById('backup-file-confirm').value)throw Error('رمز فایل باید حداقل ۱۲ کاراکتر باشد و تکرارش برابر باشد.');
        if(!confirm('ارسال پیام‌ها موقتاً برای گرفتن پشتیبان متوقف شود؟'))return;
        button.disabled=true;
        const accountPassword=document.getElementById('backup-account-password').value,otp=document.getElementById('backup-account-otp').value;document.getElementById('backup-account-password').value='';document.getElementById('backup-account-otp').value='';
        id=(await post('/api/service/backup/start',{password:accountPassword,otp})).id;
        let ready=false;for(let attempt=0;attempt<30;attempt++){const status=await api('/api/service/backup/status?id='+id);if(!status.active)throw Error('زمان دریافت تمام شد.');if(status.ready){ready=true;break;}progress.textContent='منتظر پایان عملیات در حال اجرا…';await new Promise(resolve=>setTimeout(resolve,1000));}
        if(!ready)throw Error('عملیات قبلی هنوز تمام نشده است؛ دریافت لغو شد. بعداً دوباره تلاش کنید.');
        if(generation&&generation()!==view)throw Error('صفحهٔ پشتیبان بسته شده است.');
        const manifest=await api('/api/service/backup/manifest?id='+id),backup={format:1,appVersion:manifest.appVersion,tables:{},rooms:{},secrets:manifest.secrets};let size=0;
        async function read(table,room){const data={columns:[],rows:[]};let offset=0;while(true){progress.textContent='دریافت '+(room?'تاریخچهٔ گفتگو':'داده‌های سرویس')+'…';if(generation&&generation()!==view)throw Error('دریافت لغو شد.');const page=await api('/api/service/backup/page?id='+id+'&table='+encodeURIComponent(table)+'&offset='+offset+(room?'&room='+encodeURIComponent(room):''));if(offset&&JSON.stringify(data.columns)!==JSON.stringify(page.columns))throw Error('ساختار داده حین دریافت تغییر کرد.');data.columns=page.columns;data.rows.push(...page.rows);size+=new TextEncoder().encode(JSON.stringify(page.rows)).length;if(size>32*1024*1024)throw Error('حجم پشتیبان از ظرفیت این نسخه بیشتر است.');offset+=Number(page.scanned);if(offset>=page.total)break;if(!page.scanned)throw Error('صفحهٔ پشتیبان ناقص است.');}return data;}
        for(const table of manifest.tables)backup.tables[table]=await read(table);
        for(const room of manifest.rooms){backup.rooms[room]={};for(const table of manifest.roomTables)backup.rooms[room][table]=await read(table,room);}
        await post('/api/service/backup/end?id='+id,{});finished=true;
        progress.textContent='رمزکردن فایل روی همین دستگاه…';const encrypted=await encrypt(backup,password),url=URL.createObjectURL(new Blob([JSON.stringify(encrypted)],{type:'application/json'})),link=document.createElement('a');if(generation&&generation()!==view){URL.revokeObjectURL(url);throw Error('دریافت لغو شد.');}link.href=url;link.download='WIHM-backup-'+backup.appVersion+'-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);progress.textContent='فایل دریافت شد و سرویس فعال است. رمز فایل را جدا نگه دارید؛ بدون آن بازیابی ممکن نیست.';document.getElementById('backup-file-password').value='';document.getElementById('backup-file-confirm').value='';
      }catch(reason){error(reason);}finally{if(id&&!finished)try{await post('/api/service/backup/cancel?id='+id,{});}catch{}button.disabled=false;}
    });
  }
  window.WihmBackup={open,encrypt,decrypt};
})();
