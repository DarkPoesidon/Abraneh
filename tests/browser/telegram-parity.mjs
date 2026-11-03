// The new channel, file, username, admin and English screens, in a real browser against a real local Worker.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = process.env.WIHM_SHOTS || '.wrangler/parity-qa'; await mkdir(directory, { recursive: true });
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
const errors = [];
async function open(account, viewport = { width: 1200, height: 850 }, language) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.addInitScript(({ account, language }) => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); if (language && !sessionStorage.getItem('language-set')) { localStorage.setItem('wihm_language', language); sessionStorage.setItem('language-set', '1'); } }, { account, language });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.origin); await page.locator('.chat-item').first().waitFor();
  return page;
}
const menu = async (page, id) => { await page.locator('#btn-main-menu').click(); await page.locator('#' + id).click(); };
const shot = (page, name) => page.screenshot({ path: `${directory}/${name}.png` });
try {
  const db = await fixture.mf.getD1Database('DB');
  const owner = await open(fixture.owner), peer = await open(fixture.peer, { width: 390, height: 800 });

  // Username
  await peer.locator('#nav-settings').click();
  await peer.locator('#settings-profile').click();
  await peer.locator('#profile-username').fill('sara_new');
  await peer.locator('#username-form button').click();
  await peer.waitForFunction(() => document.querySelector('#user-username-badge').textContent === '@sara_new');
  assert.equal((await db.prepare('SELECT username FROM users WHERE id=?').bind(fixture.peer.user.id).first()).username, 'sara_new');
  await peer.reload(); await peer.locator('.chat-item').first().waitFor();
  console.log('ok: username');

  // A public channel: only the owner gets a composer.
  await menu(owner, 'btn-menu-channel');
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
  await owner.locator('#new-channel-photo-file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: pixel });
  await owner.locator('#new-channel-photo img').waitFor();
  await owner.locator('#new-channel-title').fill('خبرنامه');
  await owner.locator('#new-channel-description').fill('تازه‌ترین خبرها');
  await shot(owner, 'channel-create-1');
  await owner.locator('#channel-step-one button[type=submit]').click();
  await owner.locator('input[name=channel-type][value=public]').check();
  await owner.locator('#channel-handle').fill('news_room');
  await shot(owner, 'channel-create-2');
  await owner.locator('#channel-step-two button[type=submit]').click();
  await owner.locator('#channel-new-link').waitFor();
  assert.match(await owner.locator('#channel-new-link').inputValue(), /#channel=news_room$/);
  await shot(owner, 'channel-create-3');
  await owner.locator('#channel-created-done').click();
  await owner.waitForFunction(() => document.querySelector('#active-chat-title')?.textContent === 'خبرنامه');
  await owner.locator('.message-input').fill('اولین پست کانال'); await owner.keyboard.press('Enter');
  await owner.locator('.message-text', { hasText: 'اولین پست کانال' }).waitFor();
  console.log('ok: channel created, and its owner can post');

  await menu(peer, 'btn-menu-discover');
  await peer.locator('#channel-search-query').fill('news');
  await peer.locator('#channel-search-form button').click();
  await peer.locator('#channel-result-0').waitFor(); await shot(peer, 'channel-discover');
  await peer.locator('#channel-result-0').click();
  await peer.waitForFunction(() => document.querySelector('#active-chat-title')?.textContent === 'خبرنامه');
  await peer.locator('.message-text', { hasText: 'اولین پست کانال' }).waitFor();
  assert.equal(await peer.locator('.chat-input-area').isVisible(), false, 'a subscriber has no composer');
  assert.equal(await peer.locator('.channel-footer button').isVisible(), true, 'a subscriber can mute');
  assert.equal(await peer.locator('.message-sender').count(), 0, 'posts show no author');
  await peer.waitForFunction(() => /مشترک/.test(document.querySelector('#status-text').textContent));
  assert.equal(await owner.locator('.message-bubble.sent').count(), 0, 'posts sit on one side, even for the owner');
  await owner.locator('#btn-chat-details').click(); await owner.locator('#channel-edit').waitFor(); await shot(owner, 'channel-info');
  await owner.locator('#channel-edit').click(); await owner.locator('#edit-channel-description').fill('خبرهای تازه'); await shot(owner, 'channel-edit');
  await owner.locator('#channel-edit-form button[type=submit]').click(); await owner.locator('.channel-about', { hasText: 'خبرهای تازه' }).waitFor();
  await owner.locator('#feature-modal .icon-btn[aria-label*="بستن"], #btn-close-feature').first().click();
  assert.equal(await peer.locator('#settings-channels').count(), 0, 'the old channel screen is gone');
  assert.equal(await peer.locator('.call-launch').first().isVisible(), false, 'a channel has no call buttons');
  await peer.waitForTimeout(800); await shot(peer, 'channel-subscriber');
  await owner.locator('.message-input').fill('پست زنده'); await owner.keyboard.press('Enter');
  await peer.locator('.message-text', { hasText: 'پست زنده' }).waitFor();
  console.log('ok: a subscriber joins, reads live and cannot post');

  // A file and an image travel in a private chat.
  const created = await fixture.mf.dispatchFetch(fixture.origin + '/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.owner.token }, body: JSON.stringify({ targetUserId: fixture.peer.user.id }) });
  const chatId = (await created.json()).id;
  await owner.reload(); await owner.locator(`.chat-item[data-chat-id="${chatId}"]`).click();
  await owner.waitForFunction(() => ['متصل به سرور', 'آنلاین'].includes(document.querySelector('#status-text').textContent));
  await owner.locator('.media-picker').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await owner.locator('.file-note .file-name', { hasText: 'report.pdf' }).waitFor();
  await owner.locator('.media-picker').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: pixel });
  await owner.locator('.image-note img[src^="blob:"]').waitFor();
  await peer.goto(fixture.origin); await peer.locator(`.chat-item[data-chat-id="${chatId}"]`).click();
  await peer.locator('.file-note .file-name', { hasText: 'report.pdf' }).waitFor();
  await peer.locator('.image-note img[src^="blob:"]').waitFor({ timeout: 15000 });
  await shot(peer, 'files');
  const [download] = await Promise.all([peer.waitForEvent('download'), peer.locator('.file-note').click()]);
  assert.equal(download.suggestedFilename(), 'report.pdf');
  await peer.locator('.image-note').click(); assert.equal(await peer.locator('.image-viewer').isVisible(), true);
  await peer.locator('.image-viewer button', { hasText: 'بستن' }).click();
  console.log('ok: files and images send, show and save');

  // A report reaches the admin, who acts on it from the panel.
  await peer.locator('.message-bubble.received').last().click({ button: 'right' });
  await peer.locator('#action-report').click();
  await peer.locator('#report-reason').fill('این فایل مشکوک است');
  await peer.locator('#report-form button').click();
  await peer.locator('#feature-status', { hasText: 'گزارش ثبت شد.' }).waitFor();
  await fixture.mf.dispatchFetch(fixture.origin + '/api/service/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.owner.token }, body: JSON.stringify({ code: 'local-fixture-owner-code' }) });
  await owner.reload(); await owner.locator('.chat-item').first().waitFor();
  await owner.locator('#btn-main-menu').click();
  await owner.locator('#admin-menu-badge:not([hidden])').waitFor();
  await owner.locator('#btn-menu-admin').click();
  await owner.locator('#admin-reports').click();
  await owner.locator('.admin-card', { hasText: 'این فایل مشکوک است' }).waitFor(); await shot(owner, 'admin-reports');
  await owner.locator('#report-state-0').click();
  await owner.locator('.admin-card.is-done').waitFor();
  await owner.locator('#admin-home').click(); await owner.locator('#admin-channels').click();
  await owner.locator('.admin-card', { hasText: 'خبرنامه' }).waitFor(); await shot(owner, 'admin-channels');
  await owner.locator('#chat-toggle-0').click();
  await owner.locator('.admin-card .error-text').waitFor();
  await peer.reload(); await peer.locator('.chat-item').first().waitFor();
  assert.equal(await peer.locator('.chat-item', { hasText: 'خبرنامه' }).count(), 0, 'a suspended channel disappears');
  await owner.locator('#chat-toggle-0').click(); await owner.locator('.admin-card .error-text').waitFor({ state: 'detached' });
  console.log('ok: reports and moderation in the panel');

  // Deleting a private chat from the list, for this side only.
  await owner.reload(); await owner.locator('.chat-item[data-chat-id="fixture-chat-0"]').waitFor();
  await owner.locator('.chat-item[data-chat-id="fixture-chat-0"]').click({ button: 'right' });
  await owner.locator('#delete-for-everyone').waitFor(); await shot(owner, 'delete-chat');
  await owner.locator('#delete-chat-form button[type=submit]').click();
  await owner.locator('.chat-item[data-chat-id="fixture-chat-0"]').waitFor({ state: 'detached' });
  await owner.reload(); await owner.locator('.chat-item').first().waitFor();
  assert.equal(await owner.locator('.chat-item[data-chat-id="fixture-chat-0"]').count(), 0, 'it stays gone after a reload');
  console.log('ok: delete a chat');

  // Touch: long press opens the floating menu, and a sideways swipe replies.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, serviceWorkers: 'block', locale: 'fa-IR' });
  await touchContext.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, fixture.owner);
  const touch = await touchContext.newPage(); await touch.goto(fixture.origin);
  await touch.locator('.chat-item[data-chat-id="design-team"]').click();
  const received = touch.locator('.message-bubble.received').first(); await received.waitFor();
  assert.equal(await touch.locator('.message-more').first().isVisible(), false, 'no dots button on a phone');
  const cdp = await touchContext.newCDPSession(touch), box = await received.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const fingers = (type, px, py) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });
  await fingers('touchStart', x, y); await touch.waitForTimeout(600); await fingers('touchEnd', x, y);
  await touch.locator('#feature-modal.message-menu #action-reply').waitFor();
  await touch.waitForTimeout(250); await shot(touch, 'message-menu-touch');
  const menuBox = await touch.locator('.feature-card').boundingBox();
  assert.ok(menuBox.width <= 250 && menuBox.y >= 0 && menuBox.y + menuBox.height <= 800, 'the menu floats on screen: ' + JSON.stringify(menuBox));
  await touch.mouse.click(5, 795); await touch.locator('#feature-modal.message-menu').waitFor({ state: 'detached' }).catch(() => {});
  await touch.waitForFunction(() => document.querySelector('#feature-modal').style.display === 'none');
  const fresh2 = await received.boundingBox(), sx = fresh2.x + fresh2.width - 20, sy = fresh2.y + fresh2.height / 2;
  await fingers('touchStart', sx, sy); for (let step = 1; step <= 8; step++) await fingers('touchMove', sx - step * 12, sy); await fingers('touchEnd', sx - 96, sy);
  await touch.locator('#composer-context:not([hidden])').waitFor();
  console.log('ok: long press and swipe to reply');
  await touchContext.close();

  // Links stay safe, and forwarding is reachable from the menu.
  await owner.reload(); await owner.locator('.chat-item[data-chat-id="design-team"]').click();
  await owner.locator('.message-input').fill('ببین https://example.org/a?b=1&c=2 و <img src=x onerror=alert(1)> @sara'); await owner.keyboard.press('Enter');
  await owner.locator('.message-text a[href="https://example.org/a?b=1&c=2"]').waitFor();
  assert.equal(await owner.locator('.message-text a').last().getAttribute('rel'), 'noopener noreferrer nofollow');
  assert.equal(await owner.locator('.message-text img').count(), 0, 'markup in a message stays text');
  assert.equal(await owner.locator('.message-text .mention').last().innerText(), '@sara');
  await owner.locator('.message-input').fill('');
  await owner.locator('.message-input').pressSequentially('@sa');
  await owner.locator('.mention-row').first().click();
  assert.equal(await owner.locator('.message-input').inputValue(), '@sara_new ');
  await owner.locator('.message-input').fill('');
  await owner.locator('.message-bubble').last().click({ button: 'right', position: { x: 4, y: 4 } }); await owner.locator('#action-forward').click();
  await owner.locator('#forward-query').fill('خبرنامه'); await owner.locator('.forward-row').first().click();
  await owner.locator('.forward-label').last().waitFor();
  assert.match(await owner.locator('.forward-label').last().innerText(), /هدایت‌شده از/);
  console.log('ok: links, mentions and forwarding');

  // English
  const english = await open(fixture.peer, { width: 1200, height: 850 }, 'en');
  assert.equal(await english.evaluate(() => document.documentElement.dir), 'ltr');
  const left = await english.evaluate(() => document.querySelector('.chat-filters').innerText + document.querySelector('#chat-filter-input').placeholder);
  assert.ok(!/[؀-ۿ]/.test(left), 'the sidebar is English: ' + left);
  assert.match(await english.locator('.chat-item', { hasText: 'تیم طراحی' }).first().innerText(), /تیم طراحی/, 'names stay as written');
  await english.locator(`.chat-item[data-chat-id="${chatId}"]`).click();
  await english.locator('.file-note .file-name', { hasText: 'report.pdf' }).waitFor();
  await shot(english, 'english-chat');
  await english.locator('#btn-settings:visible,#nav-settings:visible').first().click(); await english.locator('#settings-language-row').click(); await english.locator('input[name=app-language][value=en]:checked').waitFor(); await english.waitForTimeout(300); await shot(english, 'english-settings');
  const interfaceText = await english.locator('#feature-modal').innerText();
  const leftover = interfaceText.split('\n').filter(line => /[؀-ۿ]/.test(line) && !/سارا|فارسی|زبان/.test(line));
  assert.deepEqual(leftover, [], 'settings in English');
  await Promise.all([english.waitForNavigation(), english.locator('input[name=app-language][value=fa]').click()]); await english.locator('.chat-item').first().waitFor();
  assert.equal(await english.evaluate(() => document.documentElement.dir), 'rtl');
  console.log('ok: English and back');

  // Someone with no Persian: a new device opens in English, and the switch needs no reading.
  for (const [locale, dir, button] of [['de-DE', 'ltr', 'Sign in'], ['fa-IR', 'rtl', 'ورود']]) {
    const context = await browser.newContext({ locale, serviceWorkers: 'block' }), fresh = await context.newPage();
    await fresh.goto(fixture.origin); await fresh.locator('#auth-language-row').waitFor();
    assert.equal(await fresh.evaluate(() => document.documentElement.dir), dir, locale);
    assert.match(await fresh.locator('body').innerText(), new RegExp(button), locale);
    if (locale === 'de-DE') await shot(fresh, 'first-open');
    await context.close();
  }
  const fresh = await (await browser.newContext({ locale: 'de-DE', serviceWorkers: 'block' })).newPage();
  await fresh.goto(fixture.origin); await fresh.locator('#auth-language-row').waitFor();
  await Promise.all([fresh.waitForNavigation(), fresh.locator('#auth-language-row [data-language=fa]').click()]);
  assert.equal(await fresh.evaluate(() => document.documentElement.dir), 'rtl', 'the choice sticks over the device language');
  const menuPage = await open(fixture.owner, { width: 390, height: 800 });
  await menuPage.locator('#btn-main-menu').click(); await menuPage.locator('#btn-menu-language').click();
  await menuPage.locator('input[name=app-language][value=fa]:checked').waitFor();
  console.log('ok: a first open without Persian');

  assert.deepEqual(errors, []);
  console.log('Parity screens passed.');
} finally { await browser.close(); await fixture.close(); }
