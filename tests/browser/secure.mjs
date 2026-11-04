// Two people use secure chat in the real app, from the plus button to deleting a message.
const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import {mkdir,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
const directory='.wrangler/secure-qa';await mkdir(directory,{recursive:true});
const origin='https://alpha.network.workers.dev',fixture=await createNavigationFixture(),db=await fixture.mf.getD1Database('DB');
for(const sql of (await readFile('migrations/0007_secure_federation.sql','utf8')).replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})}),errors=[],results=[];
async function open(account,width){
 const context=await browser.newContext({viewport:{width,height:820},locale:'fa-IR',serviceWorkers:'block'});
 // Secure addresses refuse localhost, so the app is served under a real looking name.
 await context.route(origin+'/**',async route=>{const request=route.request(),response=await fixture.mf.dispatchFetch(request.url(),{method:request.method(),headers:request.headers(),...(request.postData()===null?{}:{body:request.postData()})});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});});
 await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));},account);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(origin);await page.locator('[data-chat-id="design-team"]').waitFor();
 return page;
}
const bubble=(page,text)=>page.locator('#messages-container .message-bubble').filter({hasText:text});
const sync=page=>page.evaluate(()=>new Promise(r=>setTimeout(r,50))).then(()=>page.reload()).then(()=>page.locator('[data-chat-id="design-team"]').waitFor());
try{
 for(const width of [375,1280]){
  await db.prepare('DELETE FROM secure_device_lists').run();await db.prepare('UPDATE secure_devices SET revoked_at=?').bind(Date.now()).run();
  const a=await open(fixture.owner,width),b=await open(fixture.peer,width);
  await a.waitForFunction(()=>window.WihmSecure);await b.waitForFunction(()=>window.WihmSecure);
  // Both devices publish their keys on their own, without opening anything.
  await a.waitForTimeout(1500);
  await a.locator('#btn-open-search').click();await a.locator('#btn-secure-mode').click();await a.locator('#modal-search-input').fill('sara');await a.locator('.user-search-result').click();
  await a.locator('.secure-intro').waitFor();assert.equal(await a.locator('#active-chat-title').innerText(),'sara');assert.equal(await a.locator('#btn-attach-file').isVisible(),false,'files are not encrypted yet');
  const secret='پیام خصوصی '+width;await a.locator('#message-input').fill(secret);await a.locator('#btn-send-message').click();await Promise.race([bubble(a,secret).waitFor(),a.locator('#chat-error:not(:empty)').waitFor()]);assert.equal(await a.locator('#chat-error').innerText(),'');
  assert.equal(await a.locator('#secure-bar').isVisible(),false);
  const stored=await db.prepare('SELECT envelope FROM secure_events').all();assert.ok(!JSON.stringify(stored).includes(secret),'the server stores no readable text');
  await sync(b);await b.locator('.chat-item').filter({hasText:'nila'}).first().click();await bubble(b,secret).waitFor();
  assert.equal(await b.locator('.chat-input-area').isVisible(),false,'nothing can be sent before accepting');
  await b.waitForTimeout(500);await b.screenshot({path:directory+'/request-'+width+'.png'});
  await b.locator('#secure-accept').click();await b.locator('#message-input').waitFor();
  await b.locator('#message-input').fill('پاسخ من');await b.locator('#btn-send-message').click();await bubble(b,'پاسخ من').waitFor();
  await sync(a);await a.locator('.chat-item').filter({hasText:'sara'}).first().click();await bubble(a,'پاسخ من').waitFor();await a.locator('.chat-item').filter({hasText:'sara'}).locator('.rail-unread').waitFor({state:'detached'});await a.waitForTimeout(500);await a.screenshot({path:directory+'/chat-'+width+'.png'});
  // The normal message menu drives edit, reaction and delete.
  await bubble(a,secret).locator('.message-more').click({force:true});await a.locator('#action-edit').click();await a.locator('#message-input').fill('متن تازه');await a.locator('#btn-send-message').click();await bubble(a,'متن تازه').waitFor();
  await bubble(a,'پاسخ من').locator('.message-more').click({force:true});assert.equal(await a.locator('#action-edit').count(),0,'only the author edits');await a.locator('#react-0').click();await bubble(a,'پاسخ من').locator('.reaction-chip').waitFor();
  await sync(b);await b.locator('.chat-item').filter({hasText:'nila'}).first().click();await bubble(b,'متن تازه').waitFor();await bubble(b,'پاسخ من').locator('.reaction-chip').waitFor();
  await bubble(a,'متن تازه').locator('.message-more').click({force:true});await a.locator('#action-delete').click();await bubble(a,'این پیام حذف شده است').waitFor();
  // An offline send stays queued and goes out later.
  await a.route('**/api/secure/send',route=>route.abort());await a.locator('#message-input').fill('بدون اینترنت');await a.locator('#btn-send-message').click();await bubble(a,'بدون اینترنت').waitFor();await a.unroute('**/api/secure/send');
  // Details and settings.
  await a.locator('#btn-chat-details').click();await a.locator('#secure-safety').click();const code=await a.locator('.secure-code').innerText();assert.match(code,/^\d{4}( \d{4}){5}$/);await a.locator('#secure-same').click();await a.locator('#btn-close-feature').waitFor();
  for(const page of [a,b])assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll');
  await a.context().close();await b.context().close();results.push({width,passed:true});
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,results}));
}finally{await browser.close();await fixture.close();}
