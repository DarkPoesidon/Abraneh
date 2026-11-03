const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
import {Response} from 'miniflare';
const directory='.wrangler/new-features-qa';await mkdir(directory,{recursive:true});
const updater={mode:'notify',latest:{version:'9.9.9',notes:'نسخهٔ آزمایشی برای بررسی دکمه‌ها'},job:null};
let applied=false,checkCount=0;
const fixture=await createNavigationFixture({bindings:{TELEGRAM_KEY:'a'.repeat(64),UPDATER_AUTH:'fixture-only-auth'},serviceBindings:{UPDATER:async request=>{const path=new URL(request.url).pathname;if(path==='/check')checkCount++;if(path==='/mode')updater.mode=(await request.json()).mode;if(path==='/apply'){assert.equal((await request.json()).version,'9.9.9');applied=true;updater.latest=null;updater.job={state:'done',version:'9.9.9',phase:'updater'};}return Response.json({configured:true,...updater});}}}),db=await fixture.mf.getD1Database('DB');
await db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(fixture.owner.user.id).run();
const source='aa000000-0000-4000-8000-000000000001',now=Date.now();
await db.batch([
 db.prepare("INSERT INTO telegram_sources(id,source_key,kind,username,title,last_checked) VALUES (?,?,'public',?,?,?)").bind(source,'public:fixture_channel','fixture_channel','کانال کتاب و فناوری',now),
 db.prepare('INSERT INTO telegram_subscriptions(user_id,source_id) VALUES (?,?)').bind(fixture.owner.user.id,source),
 db.prepare('INSERT INTO telegram_posts VALUES (?,?,?,?,?,?,?)').bind(source,10,'یک یادداشت فارسی برای خواندن در کانال.\nاین متن آزمایشی است. <img src=x onerror=alert(1)>',0,now,now,1),
 db.prepare('INSERT INTO telegram_posts VALUES (?,?,?,?,?,?,?)').bind(source,11,'کپشن یک پست رسانه‌ای؛ فایل اصلی از لینک تلگرام باز می‌شود.',1,now,now,2),
]);
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})}),errors=[],results=[];
try{
 for(const width of [320,375,768,1280]){
  const context=await browser.newContext({viewport:{width,height:820},locale:'fa-IR'});await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));},fixture.owner);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(fixture.origin);await page.locator('[data-chat-id="design-team"]').waitFor();
  await page.locator('#btn-main-menu').click();await page.locator('#btn-menu-settings').click();await page.locator('#settings-updates').click();await page.locator('#server-update-mode').waitFor();await page.waitForFunction(()=>!WihmUpdates.state().checking);
  assert.equal(await page.locator('#client-update-mode').inputValue(),'notify');assert.ok(await page.locator('#client-update-check').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${directory}/updates-${width}.png`});
  if(width===320){await page.locator('#client-update-check').click();await page.waitForFunction(()=>!WihmUpdates.state().checking);await page.waitForTimeout(300);assert.ok(checkCount>0,'Top check must check server releases for the owner');page.once('dialog',dialog=>dialog.accept());await page.locator('#server-update-apply').click();await page.waitForFunction(()=>document.getElementById('server-update-panel').textContent.includes('به‌روزرسانی سرور به این نسخه کامل شد'));assert.ok(applied);}
  await page.locator('#btn-close-feature').click();await page.locator('#btn-main-menu').click();await page.locator('#btn-channels').click();await page.locator('.channel-row').click();await page.locator('.channel-post').first().waitFor();assert.equal(await page.locator('.channel-post').count(),2);assert.equal(await page.locator('.channel-post img').count(),0);assert.match(await page.locator('.channel-post-text').last().innerText(),/<img src=x onerror=alert\(1\)>/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${directory}/channels-${width}.png`});
  await page.locator('#channels-back').click();await page.locator('#channel-bot-settings').click();await page.locator('#feature-content .telegram-steps').waitFor();assert.match(await page.locator('#feature-content').innerText(),/تاریخچهٔ پیش از اتصال/);assert.ok(await page.locator('#telegram-bot-token').isVisible());await page.screenshot({path:`${directory}/bot-${width}.png`});results.push({width,updates:true,channelText:true,htmlEscaped:true,botGuide:true});await context.close();
 }
 assert.deepEqual(errors,[]);await writeFile(directory+'/results.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({passed:true,results,errors}));
}finally{await browser.close();await fixture.close();}
