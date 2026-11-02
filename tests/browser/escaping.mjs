// A value with quotes must stay data inside an HTML attribute, in the real app against a real local Worker.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';

const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
const displayName = 'سارا "x" autofocus onfocus="window.injected=1';
try {
  const response = await fixture.mf.dispatchFetch(fixture.origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'quoted', displayName, password: 'fixture-only-pass123' }) });
  const account = await response.json(); assert.equal(response.status, 201);
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, account);
  const page = await context.newPage(); await page.goto(fixture.origin);
  await page.locator('#btn-main-menu').click(); await page.locator('#btn-menu-settings').click();
  await page.locator('#settings-profile').click(); await page.locator('#profile-file').waitFor({ state: 'attached' });
  assert.equal(await page.locator('[onfocus]').count(), 0, 'a display name must not create event handler attributes');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.evaluate(name => [...document.querySelectorAll('input')].some(input => input.value === name), displayName), true, 'the whole name must appear in its field');
  console.log('Attribute escaping passed.');
} finally { await browser.close(); await fixture.close(); }
