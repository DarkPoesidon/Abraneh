// Each message on the update page must name what is really happening, in both languages.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
const EXPECT = {
  en: { latest: 'This device has the latest version on the server.', edit: 'You are editing a message. Save or cancel the edit, then press this button again.', server: /Server version: \d+\.\d+\.\d+/ },
  fa: { latest: 'این دستگاه آخرین نسخهٔ موجود روی سرور را دارد.', edit: 'در حال ویرایش پیام هستید. ویرایش را ذخیره یا لغو کنید و دوباره این دکمه را بزنید.', server: /نسخهٔ سرور: / },
};
try {
  for (const language of ['en', 'fa']) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(([account, language]) => { localStorage.setItem('wihm_language', language); localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, [fixture.owner, language]);
    const page = await context.newPage();
    await page.goto(fixture.origin); await page.locator('[data-chat-id="design-team"]').click();
    const input = page.locator('#message-input'); await input.waitFor();
    const status = page.locator('#client-update-status');
    const openUpdates = async () => { await page.evaluate(() => document.getElementById('settings-updates').click()); await status.waitFor(); };
    const press = () => page.evaluate(() => { window.WihmUpdates.state; return window.WihmUpdates.apply(); });
    const message = text => page.waitForFunction(text => document.getElementById('client-update-status').textContent === text, text, { timeout: 15000 });

    // A check with nothing new says so, and names the server's version.
    await openUpdates();
    await page.locator('#client-update-check').click();
    await message(EXPECT[language].latest);
    assert.match(await page.locator('#client-update-available').innerText(), EXPECT[language].server);
    console.log('ok: up to date, in', language);

    // Text in the box is a draft, so nothing blocks an update and no reason is shown.
    await page.locator('#btn-close-feature').click();
    await input.fill('متنی که هنوز ارسال نشده');
    await openUpdates();
    await press();
    assert.doesNotMatch(await status.innerText(), /edit|ویرایش|call|تماس/i, 'a draft must not be reported as a problem');
    console.log('ok: a draft does not block, in', language);

    // Editing a message does block, and says that is why.
    await page.locator('#btn-close-feature').click();
    await input.fill('پیام ' + language); await input.press('Enter');
    await page.locator('.message-bubble.sent:not(.pending)', { hasText: 'پیام ' + language }).waitFor();
    await input.press('ArrowUp');
    await page.locator('#composer-label strong').waitFor();
    await openUpdates();
    await press();
    await message(EXPECT[language].edit);
    console.log('ok: an edit blocks and says so, in', language);
    await context.close();
  }
  console.log('Update apply passed.');
} finally { await browser.close(); await fixture.close(); }
