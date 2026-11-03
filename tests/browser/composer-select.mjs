// The composer's Telegram details and selecting several messages, in a real browser against a real local Worker.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
const fixture = await createNavigationFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
await context.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, fixture.owner);
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
const input = page.locator('#message-input');
const send = async text => { await input.fill(text); await input.press('Enter'); await page.locator('.message-bubble:not(.pending)', { hasText: text }).last().waitFor(); };
const openChat = async id => { await page.locator(`[data-chat-id="${id}"]`).click(); await input.waitFor(); };
try {
  await page.goto(fixture.origin); await page.locator('.chat-item').first().waitFor();
  const other = await page.locator('.chat-item').evaluateAll(items => items.map(item => item.dataset.chatId).find(id => id !== 'design-team'));
  await openChat('design-team');

  // The box grows with the text and shrinks when it is cleared.
  const empty = (await input.boundingBox()).height;
  await input.fill('یک\nدو\nسه\nچهار\nپنج');
  assert.ok((await input.boundingBox()).height > empty + 30, 'the box must grow');
  await input.fill('');
  assert.equal((await input.boundingBox()).height, empty, 'the box must shrink');
  console.log('ok: the box follows the text');

  // A draft stays with its chat, across chats and a reload.
  await input.fill('پیش‌نویس گفتگو');
  await openChat(other);
  assert.equal(await input.inputValue(), '');
  await openChat('design-team');
  assert.equal(await input.inputValue(), 'پیش‌نویس گفتگو');
  await page.reload(); await page.locator('.chat-item').first().waitFor(); await openChat('design-team');
  assert.equal(await input.inputValue(), 'پیش‌نویس گفتگو');
  await input.fill('');
  console.log('ok: drafts');

  // Enter sends on a desktop, ArrowUp edits the last own message, and Escape leaves.
  await send('پیام اول من'); await send('پیام دوم من');
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), 'پیام دوم من');
  await page.locator('#composer-label strong').waitFor();
  await input.press('Escape');
  assert.ok(await page.locator('#composer-context').isHidden());
  await input.fill('');
  console.log('ok: composer keys');

  // Selection: the menu starts it, a tap adds or removes, and the composer gives way to the actions.
  const bubble = text => page.locator('.message-bubble', { hasText: text }).last();
  await bubble('پیام اول من').click({ button: 'right' });
  await page.locator('#action-select').click();
  await bubble('پیام دوم من').click();
  await page.waitForFunction(() => document.querySelectorAll('.message-bubble.selected').length === 2);
  assert.ok(await page.locator('.chat-input-area').isHidden(), 'the composer must give way');
  await page.locator('#btn-select-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText().then(text => text.replace(/\r/g, ''))), 'پیام اول من\n\nپیام دوم من');
  assert.ok(await page.locator('.selection-bar').isHidden());
  assert.ok(await page.locator('.chat-input-area').isVisible());
  console.log('ok: select and copy');

  // Escape leaves selection.
  await bubble('پیام اول من').click({ button: 'right' });
  await page.locator('#action-select').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.message-bubble.selected').count(), 0);
  console.log('ok: Escape leaves selection');

  // Forward two messages in order.
  await bubble('پیام اول من').click({ button: 'right' }); await page.locator('#action-select').click();
  await bubble('پیام دوم من').click();
  await page.locator('#btn-select-forward').click();
  await page.locator('.forward-row', { hasNotText: 'تیم طراحی' }).first().click();
  await page.locator('.message-bubble', { hasText: 'هدایت‌شده' }).filter({ hasText: 'پیام دوم من' }).waitFor();
  const order = await page.locator('.message-bubble').evaluateAll(nodes => nodes.map(node => node.textContent).filter(text => text.includes('پیام اول من') || text.includes('پیام دوم من')));
  assert.ok(order[0].includes('پیام اول من') && order[1].includes('پیام دوم من'), order.join(' | '));
  console.log('ok: forward several');

  // Delete only appears when every selected message may be deleted, then deletes them all.
  await openChat('design-team');
  await send('برای حذف یک'); await send('برای حذف دو');
  await bubble('برای حذف یک').click({ button: 'right' }); await page.locator('#action-select').click();
  await bubble('برای حذف دو').click();
  await page.locator('#btn-select-delete').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.message-bubble')].some(node => node.textContent.includes('برای حذف')));
  assert.ok(await page.locator('.selection-bar').isHidden());
  console.log('ok: delete several');

  // A pasted image goes out after the question.
  const before = await page.locator('.message-bubble').count();
  await input.evaluate(node => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(count => document.querySelectorAll('.message-bubble:not(.pending)').length > count, before, { timeout: 30000 });
  console.log('ok: paste a file');

  // On a phone Enter is a new line, and the send button sends.
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await phone.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, fixture.owner);
  const mobile = await phone.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(fixture.origin); await mobile.locator('.chat-item').first().waitFor();
  await mobile.locator('[data-chat-id="design-team"]').click();
  await mobile.locator('#message-input').fill('خط یک');
  await mobile.locator('#message-input').press('Enter');
  assert.ok((await mobile.locator('#message-input').inputValue()).startsWith('خط یک'), 'Enter must not send on a phone');
  console.log('ok: Enter on a phone');

  assert.deepEqual(errors, []);
  console.log('Composer and selection passed.');
} finally { await browser.close(); await fixture.close(); }
