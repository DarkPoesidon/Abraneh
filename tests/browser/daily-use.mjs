// Run from the repository root with playwright-core installed, or set WIHM_PLAYWRIGHT_MODULE to its file URL.
const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', write: false, platform:'neutral', mainFields:['browser','module','main'], external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'browser-qa', modules: true, script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'], bindings: { JWT_SECRET: randomBytes(48).toString('hex'), ADMIN_SETUP_TOKEN: 'qa-only-owner-claim-code' },
  d1Databases: { DB: 'browser-qa-db' }, durableObjects: { CHAT_ROOM: { className: 'ChatRoom', useSQLite: true } },
  assets: { directory: resolve('public'), binding: 'ASSETS', routerConfig: { has_user_worker: true } },
}));
const browser = await chromium.launch({ ...(process.env.WIHM_CHROME_PATH ? {executablePath:process.env.WIHM_CHROME_PATH} : {}), headless: true });
const errors = [], contexts = [];
await mkdir('.wrangler/phase2-qa', { recursive: true });
try {
  const db = await mf.getD1Database('DB');
  for (const sql of (await readFile('schema.sql', 'utf8')).replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  const origin = (await mf.ready).origin;
  async function api(path, body, token) {
    const response = await mf.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const a = await api('/api/auth/register', { username: 'nila', displayName: 'نیلوفر', password: 'testpass123' });
  const b = await api('/api/auth/register', { username: 'sara', displayName: 'سارا', password: 'testpass123' });
  const { id: chatId } = await api('/api/chats', { targetUserId: b.user.id }, a.token);
  async function pageFor(account, viewport) {
    const context = await browser.newContext({ viewport }); contexts.push(context);
    await context.addInitScript(({ account }) => {
      if (!localStorage.getItem('qa-seeded')) {
        localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); localStorage.setItem('qa-seeded', '1');
      }
    }, { account });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.locator('.chat-item').first().waitFor();
    return { context, page };
  }
  const first=await pageFor(a,{width:1280,height:900}),peer=await pageFor(b,{width:375,height:820});
  const page=first.page,other=peer.page;
  const dialogErrors=[];page.on('console',msg=>{if(msg.type()==='error')dialogErrors.push(msg.text());});
  page.on('dialog',dialog=>dialog.accept());other.on('dialog',dialog=>dialog.accept());
  await page.locator('.chat-item').first().click();await other.locator('.chat-item').first().click();
  await page.waitForFunction(()=>/متصل|آنلاین/.test(document.getElementById('status-text').textContent));
  const send=async(p,text)=>{await p.locator('#message-input').fill(text);await p.locator('#btn-send-message').click();await p.locator('.message-text').filter({hasText:text}).last().waitFor();};
  const actions=async(p,text)=>{const bubble=p.locator('.message-bubble').filter({has:p.locator('.message-text').filter({hasText:text})}).last();await bubble.locator('.message-more').click();await p.locator('#feature-modal').waitFor({state:'visible'});};
  await send(page,'كيكِ می‌روم؛ پیام آزمایشی');await other.locator('.message-text').filter({hasText:'كيكِ می‌روم'}).waitFor();
  await actions(other,'كيكِ می‌روم');await other.locator('#action-reply').click();await other.locator('#composer-context').waitFor({state:'visible'});await send(other,'این پاسخ به پیام شماست.');await page.locator('.reply-quote').waitFor();
  await actions(page,'كيكِ می‌روم');await page.locator('#action-edit').click();await page.locator('#message-input').fill('کیک تازه؛ پیام ویرایش‌شده');await page.locator('#btn-send-message').click();
  await other.locator('.message-text').filter({hasText:'کیک تازه'}).waitFor();assert.ok((await other.locator('.reply-quote').textContent()).includes('کیک تازه'));
  await actions(other,'کیک تازه');await other.locator('#react-1').click();await page.locator('.reaction-chip').filter({hasText:'❤️'}).waitFor();
  await actions(page,'کیک تازه');await page.locator('#action-save').click();await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('ذخیره'));
  await page.keyboard.press('Escape');await page.locator('#btn-main-menu').click();await page.locator('#btn-saved').click();await page.locator('.result-card').filter({hasText:'کیک تازه'}).waitFor();await page.locator('#btn-close-feature').click();
  await actions(page,'کیک تازه');await page.locator('#action-pin').click();await page.locator('#btn-pinned-message').waitFor({state:'visible'});
  await page.locator('#btn-message-search').click();await page.locator('#message-search-query').fill('كيك');await page.locator('#message-search-form button[type=submit]').click();await page.locator('#search-hit-0').filter({hasText:'کیک تازه'}).waitFor();await page.locator('#search-hit-0').click();
  await actions(page,'کیک تازه');await page.locator('#action-delete').click();await other.locator('.deleted-message').waitFor();await other.waitForFunction(()=>document.querySelector('.reply-quote').textContent.includes('حذف شده'));
  await page.locator('#btn-settings:visible,#nav-settings:visible').first().click();await page.locator('#settings-profile').click();await page.locator('#profile-name').fill('نیلوفر تازه');await page.locator('#profile-about').fill('دربارهٔ من');await page.locator('#profile-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('ذخیره'));
  await page.locator('#btn-settings-back').click();await page.locator('#settings-appearance').click();await page.locator('#profile-theme').selectOption('light');await page.locator('#profile-font').selectOption('large');await page.locator('#profile-form button[type=submit]').click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.locator('#btn-settings-back').click();
  await page.locator('#settings-admin').click();await page.locator('#claim-code').fill('qa-only-owner-claim-code');await page.locator('#claim-form button').click();await page.locator('#registration-mode').waitFor();
  await page.locator('#registration-mode').selectOption('invite');await page.locator('#service-form button').click();await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('ذخیره'));
  await page.locator('#registration-invites').click();await page.locator('#invite-form button').click();await page.locator('#invite-link').waitFor({state:'visible'});assert.ok((await page.locator('#invite-link').inputValue()).includes('#register='));
  await page.locator('#btn-close-feature').click();
  console.log('Stage: group picker');await page.locator('#btn-open-search').click();await page.locator('#btn-group-mode').click();await page.locator('#group-title-input').fill('گروه دوستان');await page.locator('#modal-search-input').fill('sara');await page.locator('.user-search-result').waitFor();await page.locator('.user-search-result').click();console.log('Stage: save group');await page.locator('#btn-save-group').click();await page.locator('#active-chat-title').filter({hasText:'گروه دوستان'}).waitFor();
  await page.locator('#btn-chat-details').click();await page.locator('#rename-title').fill('گروه روزمره');await page.locator('#rename-form button').click();await page.locator('#active-chat-title').filter({hasText:'گروه روزمره'}).waitFor();
  await page.locator('#group-invites').click();await page.locator('#invite-form button').click();await page.locator('#invite-link').waitFor({state:'visible'});assert.ok((await page.locator('#invite-link').inputValue()).includes('#join='));await page.locator('#btn-close-feature').click();
  await send(page,'سلام گروه؛ امکانات تازه آمادهٔ بررسی است.');
  for(const width of [320,375,414,768,1280]) {
    await page.setViewportSize({width,height:860});if(width<=768&&!await page.locator('#sidebar').evaluate(el=>el.classList.contains('hidden')))await page.locator('.chat-item').filter({hasText:'گروه روزمره'}).click();await page.locator('#btn-chat-details').click();await page.locator('#rename-title').waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow '+width);
    await page.waitForTimeout(260);const box=await page.locator('.feature-card').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'modal width '+width);
    await page.screenshot({path:`.wrangler/phase2-qa/group-${width}.png`,animations:'disabled'});await page.locator('#btn-close-feature').click();
  }
  await page.setViewportSize({width:375,height:820});await page.locator('#btn-back-to-chats').click();await page.locator('#btn-open-search').click();
  const button=await page.locator('#btn-group-mode').boundingBox(),search=await page.locator('#modal-search-input').boundingBox();assert.ok(search.y-(button.y+button.height)>=15,'new chat spacing');assert.ok(button.height>=42);
  await page.screenshot({path:'.wrangler/phase2-qa/new-chat-375.png',animations:'disabled'});await page.locator('#btn-close-modal').click();
  await page.locator('#btn-settings:visible,#nav-settings:visible').first().click();await page.locator('#settings-navigation').waitFor();await page.screenshot({path:'.wrangler/phase2-qa/settings-375.png',animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(dialogErrors,[]);
  console.log(JSON.stringify({passed:true,checks:['reply','live edit and quote update','reaction','saved','pin','Persian search','delete tombstone','profile/theme/font','owner claim','registration invite','group creation/rename/invite','modal widths 320-1280','new-chat 16px spacing and touch target'],screenshots:'.wrangler/phase2-qa'}));
} catch(error) {for(let i=0;i<contexts.length;i++){const p=contexts[i].pages()[0];if(p){await p.screenshot({path:'.wrangler/phase2-qa/failure-'+i+'.png'});console.log((await p.locator('body').innerText()).slice(-2200));}}throw error;} finally {for(const context of contexts)await context.close();await browser.close();await mf.dispose();}
