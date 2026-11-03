// A language switch must flip the interface, but your own messages stay on the right and players stay left to right.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
try {
  for (const [language, dir] of [['en', 'ltr'], ['fa', 'rtl']]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block' });
    await context.addInitScript(([account, language]) => { localStorage.setItem('wihm_language', language); localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, [fixture.owner, language]);
    const page = await context.newPage();
    await page.goto(fixture.origin); await page.locator('[data-chat-id="design-team"]').click(); await page.locator('.message-bubble.sent').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dir), dir);
    const sides = await page.evaluate(() => {
      const list = document.getElementById('messages-container').getBoundingClientRect(), box = selector => document.querySelector(selector).getBoundingClientRect();
      const sent = box('.message-bubble.sent'), received = box('.message-bubble.received');
      return { sentGapRight: list.right - sent.right, sentGapLeft: sent.left - list.left, receivedGapRight: list.right - received.right, receivedGapLeft: received.left - list.left };
    });
    assert.ok(sides.sentGapRight < sides.sentGapLeft, 'own messages sit on the right in ' + language);
    assert.ok(sides.receivedGapLeft < sides.receivedGapRight, "other people's messages sit on the left in " + language);

    // Each settings chevron points away from its row's text, and every row has an icon and a chevron.
    await page.evaluate(() => document.getElementById('btn-settings').click()); await page.locator('#settings-navigation').waitFor();
    const rows = await page.locator('#settings-navigation .settings-row').evaluateAll(nodes => nodes.filter(node => !node.hidden && node.offsetParent).map(node => {
      const svg = [...node.querySelectorAll(':scope > svg')], chevron = node.querySelector('.row-chevron'), text = node.querySelector('span')?.getBoundingClientRect(), place = chevron?.getBoundingClientRect();
      return { id: node.id, icons: svg.length, transform: chevron && getComputedStyle(chevron).transform, chevronAfterText: place && text ? place.left > text.left : null };
    }));
    assert.ok(rows.length > 5);
    for (const row of rows) {
      if (row.id === 'settings-logout') continue;
      assert.equal(row.icons, 2, row.id + ' needs an icon and a chevron');
      assert.equal(row.chevronAfterText, dir === 'ltr', row.id + ' chevron side in ' + language);
      assert.equal(row.transform === 'none', dir === 'ltr', row.id + ' chevron direction in ' + language);
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
    console.log('ok: directions in', language);
    await context.close();
  }
  console.log('Directions passed.');
} finally { await browser.close(); await fixture.close(); }
