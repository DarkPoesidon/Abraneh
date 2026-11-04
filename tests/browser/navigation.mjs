// Run from repository root. Set WIHM_PLAYWRIGHT_MODULE / WIHM_CHROME_PATH for an existing installation.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createNavigationFixture } from './fixture.mjs';

const directory = '.wrangler/navigation-qa';
await mkdir(directory, { recursive: true });
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}), headless: true });
const contexts = [], errors = [], results = [], fontRequests = [];
const fontPath = '/fonts/Vazir-Variable.woff2';
const expectedFontSha256 = '3d7c6820aa45e4f1c569561a7dabc6472153e14ea883b5b6ef41aa764c66def0';
let fontPhase = 'online';
async function waitFor(page, predicate, argument) { await page.waitForFunction(predicate, argument); }
async function noOverflow(page, label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow: ' + label);
}
async function settings(page) {
  await page.locator('#btn-main-menu').click(); await page.locator('#btn-menu-settings').click();
  await page.locator('#settings-navigation').waitFor({ state: 'visible' });
}
async function fontReady(page) {
  const loaded = await page.evaluate(async () => {
    const regular = await document.fonts.load('400 16px Vazir', 'آزمایش نوشتهٔ فارسی');
    const bold = await document.fonts.load('700 16px Vazir', 'آزمایش نوشتهٔ فارسی');
    await document.fonts.ready;
    return {
      regularLoaded: regular.length > 0 && regular.every(face => face.status === 'loaded') && document.fonts.check('400 16px Vazir', 'آزمایش نوشتهٔ فارسی'),
      boldLoaded: bold.length > 0 && bold.every(face => face.status === 'loaded') && document.fonts.check('700 16px Vazir', 'آزمایش نوشتهٔ فارسی'),
      primaryFamilies: ['body', '#message-input', '#btn-main-menu', '#user-display-name'].map(selector => ({ selector, family: getComputedStyle(document.querySelector(selector)).fontFamily.split(',')[0].replace(/["']/g, '').trim() })),
    };
  });
  assert.equal(loaded.regularLoaded, true, 'Vazir regular Persian face is actually loaded');
  assert.equal(loaded.boldLoaded, true, 'Vazir bold Persian face is actually loaded');
  for (const element of loaded.primaryFamilies) assert.equal(element.family, 'Vazir', 'primary font: ' + element.selector);
  return loaded;
}
async function screenshot(page, name) { await fontReady(page); await page.screenshot({ path: `${directory}/${name}.png`, animations: 'disabled' }); }
async function sidebarWidth(page, expected) {
  await page.waitForFunction(width => Math.abs(document.getElementById('sidebar').getBoundingClientRect().width - width) <= 1, expected);
}
async function loadedPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, locale: 'fa-IR', reducedMotion: 'reduce' }); contexts.push(context);
  await context.addInitScript(({ owner }) => {
    if (!localStorage.getItem('navigation-qa-seeded')) {
      localStorage.setItem('cf_msg_token', owner.token); localStorage.setItem('cf_msg_user', JSON.stringify(owner.user)); localStorage.setItem('navigation-qa-seeded', '1');
    }
  }, { owner: fixture.owner });
  const page = await context.newPage(); page.on('pageerror', error => errors.push({ width, message: error.message }));
  page.on('response', response => { if (new URL(response.url()).pathname === fontPath) fontRequests.push({ width, phase: fontPhase, status: response.status(), contentType: response.headers()['content-type'], fromServiceWorker: response.fromServiceWorker() }); });
  await page.goto(fixture.origin); await page.locator('[data-chat-id="design-team"]').waitFor();
  await page.locator('[data-chat-id="design-team"]').click(); await page.locator('#message-design-message-3').waitFor();
  await fontReady(page);
  return { context, page };
}
try {
  const fontResponse = await fetch(fixture.origin + fontPath);
  assert.equal(fontResponse.status, 200, 'bundled font HTTP status');
  assert.match(fontResponse.headers.get('content-type') || '', /font\/woff2/);
  const fontBytes = Buffer.from(await fontResponse.arrayBuffer());
  const fontSha256 = createHash('sha256').update(fontBytes).digest('hex'); assert.equal(fontSha256, expectedFontSha256);
  for (const width of [320, 375, 414, 600, 768, 769, 1024, 1440]) {
    const { page } = await loadedPage(width);
    const mobile = width <= 768;
    await noOverflow(page, width);
    assert.equal(await page.locator('#sidebar-header #btn-sessions').count(), 0);
    assert.equal(await page.locator('#sidebar .sidebar-header #btn-sessions').count(), 0);
    if (mobile) {
      assert.equal(await page.locator('#btn-toggle-sidebar').isVisible(), false);
      await page.locator('#message-input').fill('پیش‌نویس موبایل');
      await page.locator('#btn-back-to-chats').click(); await page.locator('#btn-main-menu').waitFor({ state: 'visible' });
      await page.locator('[data-chat-id="design-team"]').click();
      assert.equal(await page.locator('#message-input').inputValue(), 'پیش‌نویس موبایل');
      await screenshot(page, `chat-${width}`);
      await page.locator('#active-chat-title').click(); await page.locator('#group-add-members').waitFor();
      await page.locator('#group-add-members').click(); await page.locator('#search-modal').waitFor({ state: 'visible' });
      assert.ok((await page.locator('#search-modal-title').textContent()).includes('افزودن عضو'));
      await page.locator('#btn-close-modal').click();
      await page.locator('#btn-back-to-chats').click();
    } else {
      await sidebarWidth(page, 344);
      await page.locator('#message-input').fill('پیش‌نویس محفوظ بماند');
      await page.locator('#btn-toggle-sidebar').click(); await waitFor(page, () => document.getElementById('sidebar').classList.contains('collapsed'));
      await sidebarWidth(page, 76);
      assert.equal(await page.locator('#message-input').inputValue(), 'پیش‌نویس محفوظ بماند');
      await page.locator('[data-chat-id="design-team"]').click(); assert.equal(await page.locator('#message-input').inputValue(), 'پیش‌نویس محفوظ بماند');
      await screenshot(page, `rail-${width}`);
      await page.reload(); await page.locator('#sidebar.collapsed').waitFor(); await page.locator('[data-chat-id="design-team"]').click(); await page.locator('#message-design-message-3').waitFor();
      await sidebarWidth(page, 76);
      if (width === 1440) {
        await page.setViewportSize({ width: 375, height: 860 }); await sidebarWidth(page, 375);
        assert.equal(await page.locator('#sidebar').evaluate(node => node.classList.contains('collapsed')), false);
        await page.setViewportSize({ width, height: 860 }); await sidebarWidth(page, 76);
      }
      await page.locator('#btn-toggle-sidebar').click();
      await waitFor(page, () => !document.getElementById('sidebar').classList.contains('collapsed'));
      await sidebarWidth(page, 344);
      await screenshot(page, `expanded-${width}`);
    }
    await page.locator('#btn-main-menu').click();
    await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-saved');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#main-menu').isVisible(), false); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-main-menu');
    await page.locator('#btn-main-menu').click(); await page.mouse.click(width - 10, 2); assert.equal(await page.locator('#main-menu').isVisible(), false);
    await settings(page); await screenshot(page, `settings-${width}`);
    await page.locator('#settings-server').focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-close-feature');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-server');
    assert.ok((await page.locator('#btn-sessions').boundingBox()).height >= 44, 'devices touch target ' + width);
    assert.equal(Math.round(await page.locator('#btn-sessions > .ui-icon').first().evaluate(node => node.getBoundingClientRect().width)), 24);
    await page.locator('#btn-sessions').click(); await page.locator('#sessions-list .session-row').first().waitFor();
    assert.equal(await page.locator('#feature-modal').isVisible(), false);
    await page.keyboard.press('Escape'); await page.locator('#settings-navigation').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-sessions');
    for (const [button, selector] of [['settings-profile', '#profile-name'], ['settings-appearance', '#profile-theme'], ['settings-notifications', '#enable-notifications'], ['settings-password', '#password-current']]) {
      await page.locator('#' + button).click(); await page.locator(selector).waitFor({ state: 'visible' });
      assert.equal(await page.locator('#settings-navigation').isVisible(), false);
      await noOverflow(page, width + ' ' + button);
      await page.locator('#btn-settings-back').click(); await page.locator('#settings-navigation').waitFor({ state: 'visible' });
    }
    await page.locator('#settings-admin').click(); await page.locator('#claim-code').waitFor(); await page.locator('#btn-close-feature').click();
    assert.ok(['btn-main-menu', 'btn-settings', 'nav-settings'].includes(await page.evaluate(() => document.activeElement.id)), 'closing settings restores a visible account/menu launcher');
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      event.prompt = async () => {}; event.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(event);
    });
    assert.equal(await page.locator('#install-banner').isVisible(), false, 'install action remains inside a closed menu');
    await page.locator('#btn-main-menu').click(); await page.locator('#btn-install-pwa').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btn-install-pwa').evaluate(node => !!node.closest('#main-menu')), true);
    await page.locator('#btn-install-pwa').click(); assert.equal(await page.locator('#main-menu').isVisible(), false);
    await noOverflow(page, width + ' after navigation'); results.push({ width, mobile, passed: true });
  }
  const { page } = await loadedPage(375);
  await page.locator('#btn-back-to-chats').click(); await settings(page);
  await page.setViewportSize({ width: 375, height: 420 });
  await waitFor(page, () => document.querySelector('.feature-card').getBoundingClientRect().height <= 420 + 1);
  await page.locator('#settings-admin').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#settings-admin').isVisible(), true);
  await screenshot(page, 'settings-short-375');
  await page.setViewportSize({ width: 375, height: 860 });
  await page.locator('#settings-appearance').click(); await page.locator('#profile-theme').selectOption('light');
  await page.locator('#profile-form button[type="submit"]').click(); await waitFor(page, () => document.documentElement.dataset.theme === 'light');
  await page.locator('#btn-settings-back').click(); await page.locator('#settings-navigation').waitFor(); await screenshot(page, 'settings-light-375');
  await page.locator('#btn-close-feature').click(); await page.locator('[data-chat-id="design-team"]').click(); await screenshot(page, 'chat-light-375');
  const offline = await loadedPage(1024);
  await offline.page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await offline.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cachedFont = await offline.page.evaluate(async path => {
    const response = await caches.match(path); if (!response) return null;
    const bytes = await response.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
    return { status: response.status, bytes: bytes.byteLength, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
  }, fontPath);
  assert.equal(cachedFont?.sha256, expectedFontSha256, 'service-worker cache contains the exact bundled font');
  const cdp = await offline.context.newCDPSession(offline.page); await cdp.send('Network.enable'); await cdp.send('Network.clearBrowserCache'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  fontPhase = 'offline'; await offline.context.setOffline(true); await offline.page.reload({ waitUntil: 'domcontentloaded' });
  const offlineFont = await fontReady(offline.page); await screenshot(offline.page, 'font-offline-1024');
  assert.ok(fontRequests.some(request => request.phase === 'offline' && request.status === 200 && request.fromServiceWorker), 'offline font is served successfully by the service worker');
  await offline.context.setOffline(false); fontPhase = 'online'; await cdp.detach();
  assert.ok(fontRequests.some(request => request.status === 200 && /font\/woff2/.test(request.contentType || '')), 'Chrome observed a successful WOFF2 font response');
  assert.deepEqual(errors, []);
  const summary = { passed: true, viewports: results, screenshots: directory, checks: ['desktop expanded/collapsed widths', 'collapse preference survives reload', 'draft preserved during collapse and same-chat navigation', 'mobile back/list navigation', 'menu keyboard and outside dismissal', 'settings categories and Devices return flow', 'modal scrolling on a short screen', 'dark/light appearance', 'install action is confined to the main menu', 'actual Vazir 400/700 Persian faces and computed primary family', 'WOFF2 HTTP type, binary identity and offline service-worker reload'], font: { sha256: fontSha256, bytes: fontBytes.length, cachedFont, offlineFont, requests: fontRequests }, errors };
  await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} catch (error) {
  for (let i = 0; i < contexts.length; i++) {
    const page = contexts[i].pages()[0]; if (page) await page.screenshot({ path: `${directory}/failure-${i}.png`, animations: 'disabled' }).catch(() => {});
  }
  throw error;
} finally { for (const context of contexts) await context.close(); await browser.close(); await fixture.close(); }
