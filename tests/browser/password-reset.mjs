const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
const fixture=await createNavigationFixture(),db=await fixture.mf.getD1Database('DB');
await db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(fixture.owner.user.id).run();
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})}),errors=[];
try{
 // Signing up has no second factor to enter.
 const visitor=await (await browser.newContext({viewport:{width:375,height:820},locale:'fa-IR'})).newPage();visitor.on('pageerror',e=>errors.push(e.message));
 await visitor.goto(fixture.origin);await visitor.locator('#tab-register').click();
 for(const id of ['#otp-group','#btn-passkey-login','#auth-help'])assert.equal(await visitor.locator(id).isVisible(),false,id);
 await visitor.locator('#tab-login').click();
 for(const id of ['#otp-group','#btn-passkey-login','#auth-help'])assert.equal(await visitor.locator(id).isVisible(),true,id);
 // The owner creates the link.
 const context=await browser.newContext({viewport:{width:1280,height:820},locale:'fa-IR'});
 await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));},fixture.owner);
 const owner=await context.newPage();owner.on('pageerror',e=>errors.push(e.message));owner.on('dialog',d=>d.accept());
 await owner.goto(fixture.origin);await owner.locator('[data-chat-id="design-team"]').waitFor();
 await owner.locator('#btn-main-menu').click();await owner.locator('#btn-menu-settings').click();await owner.locator('#settings-admin').click();await owner.locator('#service-overview').click();
 await owner.locator('#management-users').click();await owner.locator('#management-query').fill('sara');await owner.locator('#management-search button').click();
 await owner.locator('#management-reset-0').click();
 const link=await owner.locator('input[readonly]').inputValue();assert.match(link,/\/#reset=[a-f0-9]{64}$/);
 // The member uses it, and the address no longer holds the token.
 const member=await (await browser.newContext({viewport:{width:375,height:820},locale:'fa-IR'})).newPage();member.on('pageerror',e=>errors.push(e.message));
 await member.goto(link);await member.locator('#reset-form').waitFor();assert.equal(await member.locator('#auth-form').isVisible(),false);
 await member.locator('#reset-password').fill('brand-new-pass-1');await member.locator('#reset-form button').click();
 await member.locator('#auth-form').waitFor();assert.ok(!member.url().includes('reset='));
 await member.locator('#input-username').fill('sara');await member.locator('#input-password').fill('brand-new-pass-1');await member.locator('#auth-submit-btn, #auth-form button[type=submit]').first().click();
 await member.locator('#auth-form').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true}));
}finally{await browser.close();await fixture.mf.dispose();}
