const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {randomBytes}=require('node:crypto');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions,Response}=require('miniflare');
let mf,db,owner,other,channelId,connector,hookSecret,webhook='',providerFailure=false;
const botToken='123456789:'+('testBotCredential_'.repeat(3));
const requests=[];
const preview=`<html><div class="tgme_channel_info_header_title"><span>کانال آزمایشی</span></div>
 <div class="tgme_widget_message" data-post="sample_channel/12"><div class="tgme_widget_message_text">سلام &amp; دنیا<br>خط دوم <b>فارسی</b><a href="javascript:alert(1)">پیوند</a></div><a class="tgme_widget_message_photo_wrap"></a><a class="tgme_widget_message_date"><time datetime="2026-10-29T01:00:00Z"></time></a></div>
 <div class="tgme_widget_message" data-post="sample_channel/13"><div class="tgme_widget_message_text">پست دوم</div><a class="tgme_widget_message_date"><time datetime="2026-10-29T02:00:00Z"></time></a></div></html>`;
async function api(path,{method='GET',body,user=owner,headers={}}={}){const response=await mf.dispatchFetch('https://app.test'+path,{method:body===undefined?method:method==='GET'?'POST':method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
before(async()=>{
 const compiled=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral', mainFields:['browser','module','main'],external:['cloudflare:workers']});
 mf=new Miniflare(convertV4MiniflareOptions({name:'telegram-test',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'telegram-db'},durableObjects:{CHAT_ROOM:{className:'ChatRoom',useSQLite:true}},bindings:{JWT_SECRET:randomBytes(32).toString('hex'),TELEGRAM_KEY:randomBytes(32).toString('hex')},outboundService:async request=>{
   const url=new URL(request.url);requests.push({host:url.hostname,path:url.pathname});
   if(url.hostname==='t.me'){assert.equal(url.pathname,'/s/sample_channel');return new Response(preview,{headers:{'Content-Type':'text/html'}});}
   assert.equal(url.hostname,'api.telegram.org');assert.ok(url.pathname.startsWith('/bot'+botToken+'/'));
   if(providerFailure)return Response.json({ok:false,description:'Secret echo: '+botToken},{status:401});
   const method=url.pathname.split('/').at(-1),body=await request.json();
   if(method==='getMe')return Response.json({ok:true,result:{id:123456789,is_bot:true,username:'reader_test_bot'}});
   if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator'}});
   if(method==='getWebhookInfo')return Response.json({ok:true,result:{url:webhook}});
   if(method==='setWebhook'){webhook=body.url;hookSecret=body.secret_token;assert.deepEqual(body.allowed_updates,['channel_post','edited_channel_post','my_chat_member']);assert.equal(body.drop_pending_updates,false);return Response.json({ok:true,result:true});}
   if(method==='deleteWebhook'){webhook='';return Response.json({ok:true,result:true});}
   throw Error('Unexpected Telegram method '+method);
 }}));
 db=await mf.getD1Database('DB');for(const sql of readFileSync('schema.sql','utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 owner=(await api('/api/auth/register',{user:null,body:{username:'tgowner',password:'testpass123'},headers:{'CF-Connecting-IP':'198.51.100.1'}})).data;
 other=(await api('/api/auth/register',{user:null,body:{username:'tgother',password:'testpass123'},headers:{'CF-Connecting-IP':'198.51.100.2'}})).data;
});
after(async()=>mf?.dispose());
test('public preview is fetched only from the fixed Telegram host, parsed as text, cached and private subscriptions remain separate',async()=>{
 const before=requests.length;
 for(const channel of ['http://127.0.0.1/secret','https://t.me@127.0.0.1/channel','https://example.com/channel','https://t.me/+invite','https://t.me/sample_channel?x=1','../sample_channel'])assert.equal((await api('/api/telegram/sources',{body:{channel}})).status,400);
 assert.equal(requests.length,before);
 const added=await api('/api/telegram/sources',{body:{channel:'https://t.me/sample_channel'}});assert.equal(added.status,201,JSON.stringify(added));channelId=added.data.id;
 const posts=await api(`/api/telegram/sources/${channelId}/posts`);assert.equal(posts.status,200);assert.equal(posts.data.posts.length,2);assert.equal(posts.data.posts[0].id,13);assert.match(posts.data.posts[1].text,/سلام & دنیا\nخط دوم فارسی/);assert.ok(!posts.data.posts[1].text.includes('<a'));assert.equal(posts.data.posts[1].media,true);assert.equal(posts.data.posts[1].url,'https://t.me/sample_channel/12');
 assert.equal((await api(`/api/telegram/sources/${channelId}/posts`,{user:other})).status,404);
 const calls=requests.length;await api('/api/telegram/sources',{user:other,body:{channel:'@sample_channel'}});assert.equal(requests.length,calls,'A recent public preview is reused');
 const read=await api(`/api/telegram/sources/${channelId}/read`,{body:{messageId:13}});assert.equal(read.status,200);assert.equal((await api('/api/telegram/sources')).data.sources[0].unreadCount,0);
});
test('connecting a bot encrypts its token and does not replace another application webhook',async()=>{
 webhook='https://another-app.test/hook';const conflict=await api('/api/telegram/bot',{body:{token:botToken}});assert.equal(conflict.status,409);assert.equal(webhook,'https://another-app.test/hook');assert.ok(!JSON.stringify(conflict.data).includes(botToken));
 webhook='';const connected=await api('/api/telegram/bot',{body:{token:botToken}});assert.equal(connected.status,200,JSON.stringify(connected));connector=connected.data.id;assert.ok(hookSecret);assert.equal(webhook,'https://app.test/api/telegram/webhook/'+connector);
 const stored=await db.prepare('SELECT * FROM telegram_bots WHERE id=?').bind(connector).first();assert.ok(!JSON.stringify(stored).includes(botToken));assert.notEqual(stored.secret_hash,hookSecret);assert.equal(JSON.parse(stored.token_cipher).v,1);
 const listed=await api('/api/telegram/bot');assert.ok(!JSON.stringify(listed).includes('token_cipher'));assert.ok(!JSON.stringify(listed).includes(hookSecret));assert.equal((await api('/api/telegram/bot',{user:other})).data.bot,null);
});
const update=(id,text,edit=false)=>({update_id:id,[edit?'edited_channel_post':'channel_post']:{message_id:7,chat:{id:-100123456789,type:'channel',title:'کانال خصوصی',username:undefined},date:100,...(edit?{edit_date:120}:{}),text}});
async function deliver(body,secret=hookSecret){return api('/api/telegram/webhook/'+connector,{user:null,body,headers:{'X-Telegram-Bot-Api-Secret-Token':secret}});}
test('private bot posts require the webhook secret, deduplicate edits, and never leak to a different account',async()=>{
 assert.equal((await deliver(update(1,'متن خصوصی'),'wrong')).status,403);assert.equal((await deliver(update(1,'متن خصوصی'))).status,200);await deliver(update(1,'متن خصوصی'));
 const listed=await api('/api/telegram/sources'),source=listed.data.sources.find(s=>s.kind==='bot');assert.ok(source);const id=source.id;
 assert.equal((await api('/api/telegram/sources',{user:other})).data.sources.some(s=>s.id===id),false);
 assert.equal((await api(`/api/telegram/sources/${id}/posts`,{user:other})).status,404);
 assert.equal((await api('/api/telegram/sources',{user:other,body:{sourceId:id}})).status,404);
 await deliver(update(3,'متن ویرایش‌شده',true));await deliver(update(2,'قدیمی'));const posts=await api(`/api/telegram/sources/${id}/posts`);assert.equal(posts.data.posts.length,1);assert.equal(posts.data.posts[0].text,'متن ویرایش‌شده');assert.equal(posts.data.posts[0].url,'https://t.me/c/123456789/7');
 await api(`/api/telegram/sources/${id}`,{method:'DELETE'});await deliver({...update(4,'نباید دوباره دنبال شود'),channel_post:{...update(4,'').channel_post,message_id:8,text:'تازه'}});assert.equal((await api('/api/telegram/sources')).data.sources.some(s=>s.id===id),false);
 await api('/api/telegram/sources',{body:{sourceId:id}});assert.equal((await api('/api/telegram/sources')).data.sources.some(s=>s.id===id),true);
});
test('provider error text is redacted and disconnecting revokes local webhook access while keeping cached private posts',async()=>{
 providerFailure=true;const failed=await api('/api/telegram/bot',{body:{token:botToken}});assert.equal(failed.status,422);assert.ok(!JSON.stringify(failed).includes(botToken));
 const privateSource=(await api('/api/telegram/sources')).data.sources.find(s=>s.kind==='bot');
 assert.equal((await api('/api/telegram/bot',{method:'DELETE'})).status,200);assert.equal((await deliver(update(10,'متن بعد از قطع'))).status,403);assert.equal((await api(`/api/telegram/sources/${privateSource.id}/posts`)).data.posts.length,1);assert.equal((await db.prepare('SELECT count(*) AS n FROM telegram_bots').first()).n,0);providerFailure=false;
});
