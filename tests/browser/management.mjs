const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
const directory='.wrangler/management-qa';await mkdir(directory,{recursive:true});
const fixture=await createNavigationFixture(),db=await fixture.mf.getD1Database('DB');
await db.prepare('INSERT INTO service_admins VALUES (1,?)').bind(fixture.owner.user.id).run();
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})}),errors=[],results=[];
try{
 for(const width of [320,375,768,1280]){
  const context=await browser.newContext({viewport:{width,height:820},locale:'fa-IR'});await context.addInitScript(owner=>{localStorage.setItem('cf_msg_token',owner.token);localStorage.setItem('cf_msg_user',JSON.stringify(owner.user));},fixture.owner);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(fixture.origin);await page.locator('[data-chat-id="design-team"]').waitFor();
  await page.locator('#btn-main-menu').click();await page.locator('#btn-menu-settings').click();await page.locator('#settings-admin').click();await page.locator('#service-overview').click();await page.locator('.service-metrics').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${directory}/overview-${width}.png`});
  await page.locator('#management-users').click();await page.locator('#management-query').fill('sara');await page.locator('#management-search button').click();await page.locator('#management-user-0').waitFor();await page.screenshot({path:`${directory}/users-${width}.png`});
  await page.locator('#management-user-0').click();await page.locator('#management-reason').fill('آزمون رابط مدیر');await page.locator('#management-action button[type="submit"], #management-action button:not([type])').first().click();await page.waitForFunction(()=>document.getElementById('feature-content').textContent.includes('غیرفعال'));
  await page.locator('#management-user-0').click();await page.locator('#management-action button:not([type])').first().click();await page.locator('#management-home').waitFor();
  await page.locator('#btn-close-feature').click();await page.locator('#btn-main-menu').click();await page.locator('#btn-menu-settings').click();await page.locator('#settings-discovery').click();await page.locator('#discovery-address').waitFor();await page.locator('#discovery-enabled').check();await page.locator('#discovery-privacy button').click();await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('ذخیره شد'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${directory}/discovery-${width}.png`});results.push({width,overview:true,userDisableEnable:true,discoveryPrivacy:true});await context.close();
 }
 assert.deepEqual(errors,[]);await writeFile(directory+'/results.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({passed:true,results,errors}));
}finally{await browser.close();await fixture.close();}
