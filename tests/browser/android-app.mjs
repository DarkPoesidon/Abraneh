// The web page's side of the Android Trusted Web Activity, in a real browser against a real local Worker.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';

const fixture = await createNavigationFixture(), errors = [];
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
async function open(path = '/', { permission, setup } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block', ...(permission ? { permissions: [permission] } : {}) });
  await context.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, fixture.owner);
  await setup?.(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.origin + path); await page.locator('.chat-item').first().waitFor();
  return page;
}
try {
  // Text shared from another app waits in the composer of the next opened chat, and is never sent by itself.
  let page = await open('/?share=' + encodeURIComponent('متن <b>اشتراکی</b>'));
  assert.equal(new URL(page.url()).search, '', 'the shared text must leave the address bar');
  await page.locator('[data-chat-id="design-team"]').click();
  await page.locator('#message-input').waitFor();
  await page.waitForFunction(() => document.querySelector('#message-input').value === 'متن <b>اشتراکی</b>');
  assert.equal(await page.locator('.message-bubble', { hasText: 'اشتراکی' }).count(), 0);
  await page.context().close();
  console.log('ok: shared text');

  // The notification prompt offers to enable push, and stays closed once dismissed.
  page = await open('/');
  await page.locator('#notification-prompt').waitFor();
  await page.locator('.notification-later').click();
  await page.locator('#notification-prompt').waitFor({ state: 'detached' });
  await page.reload(); await page.locator('.chat-item').first().waitFor(); await page.waitForTimeout(500);
  assert.equal(await page.locator('#notification-prompt').count(), 0, 'a dismissed prompt must not return');
  await page.context().close();
  console.log('ok: notification prompt');

  // Android grants a verified app's permission by itself: the prompt must still enable push, from the chat list.
  const pushPosts = [], profilePatches = [];
  const setup = async context => {
    await context.addInitScript(() => {
      const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x' }) }) } };
      Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(registration), register: async () => registration, getRegistration: async () => registration, addEventListener() {} } });
    });
    await context.route('**/api/push', route => { pushPosts.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await context.route('**/api/profile', async route => {
      if (route.request().method() === 'PATCH') profilePatches.push(route.request().postDataJSON());
      const response = await route.fetch(); const json = await response.json();
      return route.fulfill({ response, json: { ...json, pushConfigured: true, vapidPublicKey: 'AAAA' } });
    });
  };
  page = await open('/', { permission: 'notifications', setup });
  await page.locator('#notification-prompt .notification-enable').click();
  await page.locator('#notification-prompt').waitFor({ state: 'detached' });
  assert.equal(pushPosts.length, 1, 'enabling must register this device with the server');
  assert.equal(profilePatches.length, 1); assert.equal(profilePatches[0].notifications, true); assert.ok(profilePatches[0].displayName, 'saving from the chat list must keep the profile');
  await page.context().close();
  console.log('ok: enabling push from the prompt');

  // A later login on this device gets its own subscription without asking again.
  page = await open('/', { permission: 'notifications', setup });
  await page.waitForTimeout(500);
  assert.equal(pushPosts.length, 2, 'a new session must renew the subscription');
  assert.equal(await page.locator('#notification-prompt').count(), 0, 'no prompt once push is enabled');
  await page.context().close();
  console.log('ok: subscription renewal');

  assert.deepEqual(errors, []);
  console.log('Android app web support passed.');
} finally { await browser.close(); await fixture.close(); }
