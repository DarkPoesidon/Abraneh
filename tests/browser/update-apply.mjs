// Getting a new version must not depend on the interface language, or on text the app already keeps as a draft.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
try {
  for (const language of ['en', 'fa']) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(([account, language]) => { localStorage.setItem('wihm_language', language); localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, [fixture.owner, language]);
    const page = await context.newPage();
    await page.goto(fixture.origin); await page.locator('[data-chat-id="design-team"]').click(); await page.locator('#message-input').waitFor();
    await page.locator('#message-input').fill('متنی که هنوز ارسال نشده');
    await page.evaluate(() => document.getElementById('settings-updates').click());
    await page.locator('#client-update-mode').waitFor();
    const blocked = () => page.evaluate(async () => { await window.WihmUpdates.apply(); return window.WihmUpdates.state().message; });
    assert.doesNotMatch(await blocked(), /ارسال یا کپی|در جریان است/, 'the update page must not block the update in ' + language);
    console.log('ok: not blocked in', language);
    await context.close();
  }
  console.log('Update apply passed.');
} finally { await browser.close(); await fixture.close(); }
