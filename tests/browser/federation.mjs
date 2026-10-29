// Two isolated databases and browsers. No real Cloudflare account is contacted.
const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import {Response} from 'miniflare';
import {createNavigationFixture} from './fixture.mjs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origins=['https://alpha.network.workers.dev','https://beta.network.workers.dev'],fixtures=[],contexts=[],errors=[];
const directory='.wrangler/federation-browser-qa';await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})});
try{
 for(let i=0;i<2;i++)fixtures.push(await createNavigationFixture({outboundService:async r=>{const index=origins.indexOf(new URL(r.url).origin);assert.ok(index>=0,'Only the two test servers may be contacted');return fixtures[index].mf.dispatchFetch(r.url,{method:r.method,headers:r.headers,...(r.method==='GET'?{}:{body:await r.text()})});}}));
 const pages=[];
 for(let i=0;i<2;i++){
  const fixture=fixtures[i],account=i?fixture.peer:fixture.owner,db=await fixture.mf.getD1Database('DB');
  await db.prepare('INSERT INTO discovery_profiles VALUES (?,1)').bind(account.user.id).run();
  const context=await browser.newContext({viewport:{width:i?375:1280,height:900},locale:'fa-IR',serviceWorkers:'block'});contexts.push(context);
  await context.routeWebSocket('**',socket=>socket.close());
  if(i)await context.addInitScript(()=>{window.Android={saveAuthToken(){},clearAuthToken(){},isKeepAliveEnabled:()=>false,isBatteryOptimizationIgnored:()=>false};});
  await context.addInitScript(account=>{localStorage.setItem('cf_msg_token',account.token);localStorage.setItem('cf_msg_user',JSON.stringify(account.user));},account);
  await context.route(origins[i]+'/**',async route=>{
   const r=route.request(),url=new URL(r.url());
   if(!url.pathname.startsWith('/api/')&&url.pathname!=='/.well-known/wihm'){
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);assert.ok(!name.includes('..'));
    try{const body=await readFile('public/'+name);await route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.woff2')?'font/woff2':'image/svg+xml',body});}catch{await route.fulfill({status:404,body:''});}return;
   }
   const response=await fixture.mf.dispatchFetch(r.url(),{method:r.method(),headers:r.headers(),...(r.postData()===null?{}:{body:r.postData()})});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='warning'&&msg.text().startsWith('Secure sync:'))console.log(msg.text());});await page.goto(origins[i]);
  await page.waitForFunction(async()=>{const view=await WihmSecure.connect(async(path,options={})=>{const r=await fetch(path,{...options,headers:{Authorization:'Bearer '+localStorage.cf_msg_token,'Content-Type':'application/json'}});if(!r.ok)throw Error('API');return r.json();},JSON.parse(localStorage.cf_msg_user));return (await view.client.view()).device;},{},{timeout:30000});
 }
 const [a,b]=pages;
 await a.locator('#btn-open-search').click();await a.locator('#modal-search-input').fill('sara@beta.network.workers.dev');await a.locator('#remote-start-chat').click();await a.locator('#secure-choice-0').waitFor();
 await b.locator('#btn-main-menu').click();await b.locator('#btn-menu-settings').click();await b.locator('#settings-notifications').click();await b.locator('#android-power-status').waitFor();await b.locator('#btn-settings-back').click();await b.locator('#settings-secure').click();await b.locator('#secure-lookup').waitFor();
 const bKey=(await b.locator('details code').textContent()).trim(),aKey=(await a.locator('details code').textContent()).trim();
 await a.locator('#secure-choice-0').click();await a.locator('#secure-fp').fill(bKey);await a.locator('#secure-verify button').click();await a.locator('#secure-compose').waitFor();
 const text='گفتگوی یکپارچه بین دو سرور مستقل';await a.locator('#secure-text').fill(text);await a.locator('#secure-compose button').click();await a.locator('#secure-text').waitFor();
 await b.locator('#secure-sync').click();await b.locator('#secure-invite-0').click();await b.locator('#secure-fp').fill(aKey);await b.locator('#secure-verify button').click();await b.locator('#secure-history').getByText(text,{exact:true}).waitFor();
 const reply='پاسخ از سرور دوم';await b.locator('#secure-text').fill(reply);await b.locator('#secure-compose button').click();
 // The open conversation updates through the ordinary app poll, without a manual sync.
 await a.bringToFront();
 await a.locator('#secure-history').getByText(reply,{exact:true}).waitFor({timeout:25000});
 await b.locator('#btn-close-feature').click();await b.locator('.chat-item').filter({hasText:'nila@alpha.network.workers.dev'}).waitFor({timeout:25000});
 await a.locator('#secure-text').fill('پیش‌نویس حفظ شود');await a.waitForTimeout(16000);assert.equal(await a.locator('#secure-text').inputValue(),'پیش‌نویس حفظ شود');
 for(const [i,page] of pages.entries()){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:directory+'/server-'+i+'.png',fullPage:true});}
 assert.deepEqual(errors,[]);await writeFile(directory+'/results.json',JSON.stringify({passed:true,servers:2,separateDatabases:true,automaticPairing:true,ordinarySearch:true,sharedChatList:true,verifiedDevices:true,bidirectionalMLS:true,automaticRefresh:true,draftPreserved:true,androidBridgeSettingsStub:true,widths:[1280,375],errors},null,2));console.log('Two-server browser scenario passed.');
}catch(e){for(const [i,context]of contexts.entries()){const page=context.pages()[0];if(page){await writeFile(directory+'/failure-'+i+'.txt',await page.locator('body').innerText());await page.screenshot({path:directory+'/failure-'+i+'.png',fullPage:true});}}throw e;}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();await Promise.all(fixtures.map(f=>f.close()));}
