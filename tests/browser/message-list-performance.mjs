// Measures what one new message costs in a long chat, and that unchanged messages keep their elements.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
try {
  const db = await fixture.mf.getD1Database('DB'), now = Date.now(), ids = [];
  for (let start = 0; start < 600; start += 50) {
    const rows = Array.from({ length: 50 }, (_, i) => { const n = start + i, id = 'long-' + String(n).padStart(4, '0'); ids.push(id); return db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind(id, 'design-team', n % 3 ? fixture.owner.user.id : fixture.peer.user.id, 'پیام شمارهٔ ' + n + ' با کمی متن بیشتر برای اندازهٔ واقعی', now - (700 - n) * 60_000); });
    await db.batch(rows);
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'fa-IR' });
  await context.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); localStorage.setItem('wihm_language', 'fa'); }, fixture.owner);
  const page = await context.newPage(); await page.goto(fixture.origin);
  await page.locator('.chat-item[data-chat-id="design-team"]').click();
  await page.locator('#message-long-0599').waitFor();
  for (let round = 0; round < 12; round++) {
    const before = await page.locator('.message-bubble').count();
    await page.evaluate(() => { const list = document.querySelector('#messages-container'); list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(350);
    if (await page.locator('.message-bubble').count() === before) break;
  }
  const loaded = await page.locator('.message-bubble').count();
  assert.ok(loaded >= 300, 'a long chat is loaded: ' + loaded);
  await page.evaluate(() => { document.querySelector('#messages-container').scrollTop = 1e9; });
  await page.evaluate(() => { window.kept = document.querySelector('#message-long-0599'); });
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]));
  const costs = [];
  for (let i = 0; i < 5; i++) {
    const before = await metric();
    await page.locator('.message-input').fill('پیام تازه ' + i); await page.keyboard.press('Enter');
    await page.locator('.message-bubble:not(.pending) .message-text', { hasText: 'پیام تازه ' + i }).waitFor();
    await page.waitForTimeout(200);
    const after = await metric();
    costs.push(Math.round(((after.ScriptDuration - before.ScriptDuration) + (after.LayoutDuration - before.LayoutDuration) + (after.RecalcStyleDuration - before.RecalcStyleDuration)) * 1000));
  }
  costs.sort((a, b) => a - b);
  console.log(JSON.stringify({ bubbles: loaded, millisecondsPerMessage: costs[2], all: costs }));
  const same = await page.evaluate(() => window.kept === document.querySelector('#message-long-0599') && window.kept.isConnected);
  console.log('unchanged message keeps its element:', same);
  if (process.env.WIHM_REQUIRE_REUSE) assert.equal(same, true);
} finally { await browser.close(); await fixture.close(); }
