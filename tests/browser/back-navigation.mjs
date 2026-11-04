// The Android back key calls window.wihmBack: each press closes one layer, and false means leave the app.
const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
const fixture=await createNavigationFixture(),errors=[];
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})});
try{
 const context=await browser.newContext({viewport:{width:375,height:820},locale:'fa-IR',serviceWorkers:'block'});
 await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));window.wihmNativeBack=true;},fixture.owner);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(fixture.origin);const row=page.locator('[data-chat-id="design-team"]');await row.waitFor();
 const back=()=>page.evaluate(()=>window.wihmBack());
 const shown=id=>page.locator(id).isVisible();
 // The list is the end: back leaves the app, and nothing opens by itself.
 assert.equal(await back(),false,'the list leaves the app');assert.equal(await shown('#feature-modal'),false,'settings must not open');
 // A chat closes to the list.
 await row.click();await page.locator('#message-input').waitFor();
 assert.equal(await back(),true);await page.locator('#btn-main-menu').waitFor();assert.equal(await shown('#active-chat-wrapper'),false);
 assert.equal(await back(),false);
 // A settings page goes to settings, then to the list, and never sticks.
 await page.locator('#nav-settings').click();await page.locator('#settings-profile').waitFor();
 await page.locator('#settings-profile').click();await page.locator('#btn-settings-back').waitFor();
 assert.equal(await back(),true);await page.locator('#settings-profile').waitFor();
 assert.equal(await shown('#btn-settings-back'),false);
 assert.equal(await back(),true);await page.locator('#feature-modal').waitFor({state:'hidden'});
 assert.equal(await back(),false);
 // Other layers, in order.
 await page.locator('#btn-open-search').click();await page.locator('#search-modal').waitFor();assert.equal(await back(),true);await page.locator('#search-modal').waitFor({state:'hidden'});
 await page.locator('#btn-main-menu').click();await page.locator('#main-menu').waitFor();assert.equal(await back(),true);await page.locator('#main-menu').waitFor({state:'hidden'});
 // A long press opens the chat's menu without opening the chat, and back closes only the menu.
 await row.dispatchEvent('contextmenu');await page.locator('#menu-pin').waitFor();assert.equal(await shown('#active-chat-wrapper'),false);
 assert.equal(await back(),true);await page.locator('#menu-pin').waitFor({state:'hidden'});assert.equal(await back(),false);
 // Inside a chat: the three dots open the menu, and the name opens the profile.
 await row.click();await page.locator('#btn-chat-details').click();await page.locator('#menu-mute').waitFor();assert.equal(await back(),true);await page.locator('#menu-mute').waitFor({state:'hidden'});
 assert.equal(await shown('#message-input'),true,'closing a menu keeps the chat open');
 await page.locator('#active-chat-title').click();await page.locator('#feature-modal').waitFor();assert.equal(await back(),true);assert.equal(await shown('#message-input'),true);
 assert.equal(await back(),true);assert.equal(await shown('#active-chat-wrapper'),false);
 // Screens to look at.
 const dmRow=page.locator('.chat-item').filter({hasText:'مریم'}).first();
 await dmRow.click();await page.locator('#active-chat-title').click();await page.locator('#profile-message').waitFor();await page.waitForTimeout(300);await page.screenshot({path:'.wrangler/back-profile.png'});assert.equal(await back(),true);assert.equal(await back(),true);
 await dmRow.dispatchEvent('contextmenu');await page.locator('#menu-pin').waitFor();await page.waitForTimeout(300);await page.screenshot({path:'.wrangler/back-menu.png'});assert.equal(await back(),true);
 // Pinning from the menu reaches the top of the list.
 const dm=page.locator('.chat-item').filter({hasText:'مریم'}).first();
 if(await dm.count()){await dm.dispatchEvent('contextmenu');await page.locator('#menu-pin').click();await page.locator('#feature-modal').waitFor({state:'hidden'});await page.locator('.chat-item').first().filter({hasText:'مریم'}).waitFor();}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true}));
}finally{await browser.close();await fixture.close();}
