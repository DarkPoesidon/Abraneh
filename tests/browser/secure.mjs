const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createNavigationFixture} from './fixture.mjs';
const external=['@noble/*','@hpke/chacha20poly1305','@hpke/dhkem-x448','@hpke/hybridkem-x-wing','@hpke/ml-kem'];
const bundle=(await build({entryPoints:['public/secure.js'],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',external})).outputFiles[0].text;
const fixture=await createNavigationFixture(),origin='https://alpha.network.workers.dev',directory='.wrangler/secure-browser-qa';await mkdir(directory,{recursive:true});
const secureDB=await fixture.mf.getD1Database('DB');for(const sql of (await readFile('migrations/0007_secure_federation.sql','utf8')).replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await secureDB.prepare(sql).run();
const browser=await chromium.launch({headless:true,...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})}),errors=[],results=[];
let offline=false;
try{
 for(const width of [320,1280]){
  const contexts=[],pages=[];
  for(const account of [fixture.owner,fixture.peer]){
   const context=await browser.newContext({viewport:{width,height:900},locale:'fa-IR'});contexts.push(context);
   await context.route(origin+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="fa" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><main style="max-width:700px;margin:auto;padding:12px;height:100dvh;overflow:auto;box-sizing:border-box"><h2 id="title"></h2><div id="feature-content"></div><p id="feature-status" role="status"></p></main><script src="/secure.bundle.js"></script></body></html>'});return;}
    if(url.pathname==='/secure.bundle.js'){await route.fulfill({contentType:'text/javascript',body:bundle});return;}
    if(url.pathname==='/style.css'){await route.fulfill({contentType:'text/css',body:await readFile('public/style.css','utf8')});return;}
    if(offline&&url.pathname==='/api/secure/send'){await route.abort();return;}
    const response=await fixture.mf.dispatchFetch(request.url(),{method:request.method(),headers:request.headers(),...(request.postData()===null?{}:{body:request.postData()})});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
   });
   const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
   await page.evaluate(async account=>{
    const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+account.token,'Content-Type':'application/json'}}),data=await response.json();if(!response.ok)throw Error(data.error);return data;};
    await WihmSecure.open({user:account.user,api,show:(title,html)=>{document.getElementById('title').textContent=title;document.getElementById('feature-content').innerHTML=html;},escape:text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),error:error=>{document.getElementById('feature-status').textContent=error.message||error;}});
   },account);
   await page.locator('#secure-lookup').waitFor({timeout:30000});
  }
  const [a,b]=pages;
  const aKey=(await a.locator('details code').textContent()).trim(),bKey=(await b.locator('details code').textContent()).trim(),bDevice=(await b.locator('details p[dir=ltr]').textContent()).slice(-36);
  await a.locator('#secure-address').fill('sara@alpha.network.workers.dev');await a.locator('#secure-lookup button').click();await a.locator('#secure-choices button').filter({hasText:bDevice}).click();await a.locator('#secure-verify').waitFor();assert.equal(await a.locator('#feature-content code').innerText(),bKey);await a.locator('#secure-fp').fill(bKey);await a.locator('#secure-verify button').click();await a.locator('#secure-compose').waitFor();
  await b.locator('#secure-sync').click();await b.locator('#secure-invite-0').click();await b.locator('#secure-verify').waitFor();assert.equal(await b.locator('#feature-content code').innerText(),aKey);await b.locator('#secure-fp').fill(aKey);await b.locator('#secure-verify button').click();await b.locator('#secure-compose').waitFor();
  const marker='پیام خصوصی واقعی از مرورگر '+width;offline=true;await a.locator('#secure-text').fill(marker);await a.locator('#secure-compose button').click();await a.waitForFunction(()=>document.getElementById('feature-content').textContent.includes('1 پیام در صف محلی'));offline=false;await a.locator('#secure-sync').click();await a.waitForFunction(()=>document.getElementById('feature-content').textContent.includes('0 پیام در صف محلی'));await b.locator('#secure-sync').click();await b.locator('#secure-history').getByText(marker,{exact:true}).waitFor();
  await b.locator('#secure-search').fill('پیدا نمی‌شود');assert.equal(await b.locator('#secure-history article').count(),0);await b.locator('#secure-search').fill('خصوصی');assert.equal(await b.locator('#secure-history article').count(),1);
  await b.locator('#secure-search').fill('');
  await a.locator('#secure-sync').click();await a.locator('#secure-history').getByText('خوانده شد').waitFor();
  await b.locator('[data-secure-action=react]').first().click();await b.locator('#secure-history article > p').filter({hasText:'👍'}).waitFor();await a.locator('#secure-sync').click();await a.locator('#secure-history article > p').filter({hasText:'👍'}).waitFor();
  await a.locator('[data-secure-action=edit]').click();await a.locator('#secure-text').fill('متن ویرایش‌شده');await a.locator('#secure-compose button').click();await a.locator('#secure-history').getByText('متن ویرایش‌شده',{exact:true}).waitFor();await b.locator('#secure-sync').click();await b.locator('#secure-history').getByText('متن ویرایش‌شده',{exact:true}).waitFor();assert.equal(await b.locator('[data-secure-action=edit]').count(),0);
  await b.locator('[data-secure-action=reply]').click();await b.locator('#secure-text').fill('پاسخ رمزشده');await b.locator('#secure-compose button').click();await a.locator('#secure-sync').click();await a.locator('#secure-history blockquote').getByText('متن ویرایش‌شده').waitFor();
  a.once('dialog',dialog=>dialog.accept());await a.locator('[data-secure-action=delete]').first().click();await a.locator('#secure-history').getByText('این پیام حذف شد').waitFor();await b.locator('#secure-sync').click();await b.locator('#secure-history').getByText('این پیام حذف شد').waitFor();
  await b.locator('details summary').click();await b.locator('#secure-password').fill('browser recovery passphrase');const downloadPromise=b.waitForEvent('download');await b.locator('#secure-export').click();const download=await downloadPromise,path=directory+'/recovery-'+width+'.json';await download.saveAs(path);assert.ok(!(await readFile(path,'utf8')).includes(marker));
  assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await b.screenshot({path:directory+'/secure-'+width+'.png',fullPage:true});results.push({width,indexedDB:true,mls:true,manualFingerprints:true,offlineRetry:true,localSearch:true,encryptedRecovery:true});
  await Promise.all(contexts.map(c=>c.close()));
 }
 assert.deepEqual(errors,[]);await writeFile(directory+'/results.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({passed:true,results,errors}));
}finally{await browser.close();await fixture.close();}
