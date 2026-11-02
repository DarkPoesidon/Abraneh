const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createNavigationFixture} from './fixture.mjs';
const fixture=await createNavigationFixture(),browser=await chromium.launch({headless:true,executablePath:process.env.WIHM_CHROME_PATH}),results=[];
await mkdir('.wrangler/keyboard-qa',{recursive:true});
try{
 for(const width of [360,390,768]){
  const context=await browser.newContext({viewport:{width,height:844}});
  await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));const viewport=new EventTarget();Object.assign(viewport,{height:844,offsetTop:0,scale:1});Object.defineProperty(window,'visualViewport',{value:viewport});},fixture.owner);
  const page=await context.newPage();await page.goto(fixture.origin);await page.locator('[data-chat-id="design-team"]').click();await page.locator('.message-bubble').last().waitFor();await page.waitForTimeout(250);await page.locator('#message-input').fill('پیش‌نویس هنگام باز بودن کیبورد');
  await page.evaluate(()=>{const list=document.getElementById('messages-container');document.head.append(Object.assign(document.createElement('style'),{textContent:"#messages-container::before{content:'';display:block;flex:none;height:1500px}"}));list.scrollTop=list.scrollHeight;visualViewport.height=420;visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForTimeout(150);
  const bounds=await page.evaluate(()=>({composer:document.querySelector('.chat-input-area').getBoundingClientRect().bottom,header:document.querySelector('.chat-header').getBoundingClientRect().top,bottom:document.getElementById('messages-container').scrollHeight-document.getElementById('messages-container').scrollTop-document.getElementById('messages-container').clientHeight}));
  assert.ok(bounds.composer<=421,JSON.stringify(bounds));assert.ok(bounds.header>=-1,JSON.stringify(bounds));assert.ok(bounds.bottom<=2,JSON.stringify(bounds));assert.equal(await page.locator('#message-input').inputValue(),'پیش‌نویس هنگام باز بودن کیبورد');
  await page.screenshot({path:`.wrangler/keyboard-qa/keyboard-${width}.png`});
  await page.evaluate(()=>{document.getElementById('messages-container').scrollTop=0;visualViewport.height=340;visualViewport.offsetTop=24;visualViewport.dispatchEvent(new Event('resize'));});await page.waitForTimeout(150);
  assert.equal(await page.locator('#messages-container').evaluate(el=>el.scrollTop),0,'Reading history must not jump to the newest message');
  assert.ok(await page.locator('.chat-input-area').evaluate(el=>el.getBoundingClientRect().bottom<=365));
  await page.evaluate(()=>{visualViewport.height=844;visualViewport.offsetTop=0;visualViewport.dispatchEvent(new Event('resize'));});await page.waitForTimeout(150);assert.ok(await page.locator('.chat-input-area').evaluate(el=>el.getBoundingClientRect().bottom<=845));results.push({width,composerAboveKeyboard:true,draftPreserved:true,historyPositionPreserved:true});await context.close();
 }
 await writeFile('.wrangler/keyboard-qa/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({passed:true,results}));
}finally{await browser.close();await fixture.close();}
