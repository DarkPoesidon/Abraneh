// A person reaches secure chat from the plus button and from a private chat's info.
const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
const fixture=await createNavigationFixture(),errors=[];
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})});
try{
 for(const width of [375,1280]){
  const context=await browser.newContext({viewport:{width,height:820},locale:'fa-IR'});
  await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));},fixture.owner);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
  await page.goto(fixture.origin);await page.locator('[data-chat-id="design-team"]').waitFor();
  // The plus button.
  await page.locator('#btn-open-search').click();await page.locator('#btn-secure-mode').click();
  assert.equal(await page.locator('#search-modal-title').innerText(),'گفتگوی امن جدید');
  await page.locator('#modal-search-input').fill('sara');await page.locator('.user-search-result').click();
  await page.locator('#secure-address').waitFor();
  assert.ok(dialogs.some(text=>text.includes('@sara')),'it asks first, as Telegram does');
  assert.match(await page.locator('#secure-address').inputValue(),/^sara@/);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'secure-first');
  await page.locator('#btn-close-feature').click();
  // A private chat's info.
  await page.locator('#btn-open-search').click();await page.locator('#modal-search-input').fill('sara');await page.locator('.user-search-result').click();
  await page.locator('#active-chat-title').waitFor();await page.locator('#btn-chat-details').click();
  await page.locator('#secure-user').click();
  await page.locator('#secure-address').waitFor();assert.match(await page.locator('#secure-address').inputValue(),/^sara@/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true}));
}finally{await browser.close();await fixture.close();}
