// A message shows one tick until it is read, then two, on a phone-sized screen and a desktop.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
const open = async (account, width) => {
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(a => { localStorage.setItem('cf_msg_token', a.token); localStorage.setItem('cf_msg_user', JSON.stringify(a.user)); }, account);
  const page = await context.newPage(); await page.goto(fixture.origin); await page.locator('.chat-item').first().waitFor(); return page;
};
try {
  const response = await fetch(fixture.origin + '/api/chats', { method: 'POST', headers: { authorization: 'Bearer ' + fixture.owner.token, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'dm', targetUserId: fixture.peer.user.id }) });
  const chat = await response.json();
  for (const width of [390, 1200]) {
    const sender = await open(fixture.owner, width), reader = await open(fixture.peer, width), text = 'پیام ' + width;
    await sender.locator(`[data-chat-id="${chat.id}"]`).click(); await sender.locator('#message-input').waitFor();
    await sender.locator('#message-input').fill(text); await sender.locator('#btn-send-message').click();
    const status = sender.locator('.message-bubble.sent', { hasText: text }).locator('.message-status');
    await status.locator('svg').waitFor();
    await sender.waitForFunction(id => document.querySelector(`[data-chat-id="${id}"]`), chat.id);
    await sender.locator('.message-bubble.sent:not(.pending)', { hasText: text }).waitFor();
    assert.equal(await status.locator('path').count(), 1, 'one tick before it is read');
    // The reader opens the app after the message arrived, which is the usual way to read one.
    await reader.reload(); await reader.locator(`[data-chat-id="${chat.id}"]`).waitFor();
    await reader.locator(`[data-chat-id="${chat.id}"]`).click();
    await reader.locator('.message-bubble', { hasText: text }).waitFor();
    await sender.locator('.message-bubble.sent', { hasText: text }).locator('.message-status[data-state="read"]').waitFor({ timeout: 8000 });
    assert.equal(await status.locator('path').count(), 2, 'two ticks once it is read');
    console.log('ok: read ticks at', width);
    await sender.context().close(); await reader.context().close();
  }
  console.log('Read receipts passed.');
} finally { await browser.close(); await fixture.close(); }
