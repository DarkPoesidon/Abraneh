// Run from repository root. Set WIHM_PLAYWRIGHT_MODULE / WIHM_CHROME_PATH for an existing installation.
// On a phone, dragging an open chat to the right returns to the list; a short or vertical drag does not.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import assert from 'node:assert/strict';
import { createNavigationFixture } from './fixture.mjs';

const fixture = await createNavigationFixture();
const browser = await chromium.launch({ ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}), headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.origin);
  await page.evaluate(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); localStorage.setItem('wihm_language', 'fa'); }, fixture.owner);
  await page.reload();
  const cdp = await context.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  async function drag(fromX, fromY, toX, toY, steps = 12) {
    await touch('touchStart', fromX, fromY);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', fromX + (toX - fromX) * i / steps, fromY + (toY - fromY) * i / steps); await page.waitForTimeout(16); }
    await touch('touchEnd');
    await page.waitForTimeout(450);
  }
  const chatOpen = () => page.evaluate(() => document.getElementById('active-chat-wrapper').style.display === 'flex');
  async function openChat() {
    await page.locator('[data-chat-id="design-team"]').click();
    await page.locator('.message-bubble').first().waitFor();
    await page.waitForTimeout(300);
  }

  await openChat();
  await drag(120, 400, 170, 400);
  assert.equal(await chatOpen(), true, 'a short drag keeps the chat');
  assert.equal(await page.evaluate(() => document.getElementById('active-chat-wrapper').style.transform), '', 'and it springs back');
  console.log('ok: a short drag springs back');

  await drag(200, 300, 210, 600);
  assert.equal(await chatOpen(), true, 'scrolling keeps the chat');
  console.log('ok: a vertical drag scrolls');

  await drag(300, 400, 120, 400);
  assert.equal(await chatOpen(), true, 'a leftward drag is for replying, not for back');
  console.log('ok: a leftward drag is not back');

  await drag(60, 400, 330, 400);
  assert.equal(await chatOpen(), false, 'a long rightward drag goes back');
  assert.equal(await page.evaluate(() => document.getElementById('sidebar').classList.contains('hidden')), false);
  assert.equal(await page.evaluate(() => document.getElementById('active-chat-wrapper').style.transform), '');
  console.log('ok: dragging right returns to the list');

  await openChat();
  assert.equal(await chatOpen(), true, 'the chat opens again after a swipe back');
  assert.deepEqual(errors, []);
  console.log('Swipe back passed.');
} finally {
  await browser.close();
  await fixture.close();
}
