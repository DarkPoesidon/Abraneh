// Drives the Windows app against a real local Worker. Run from this repository, after npm ci in windows/:
//   WIHM_PLAYWRIGHT_MODULE=<playwright-core> node tests/windows/e2e.mjs
import { createNavigationFixture } from '../browser/fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const { _electron } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
const fixture = await createNavigationFixture();
const profile = mkdtempSync(join(tmpdir(), 'wihm-windows-'));
const executablePath = process.env.WIHM_WINDOWS_EXE || createRequire(resolve('windows/package.json'))('electron');
const app = await _electron.launch({ executablePath, args: [...(process.env.WIHM_WINDOWS_EXE ? [] : ['windows']), '--user-data-dir=' + profile] });
const hiddenFlag = page => page.evaluate(() => window.wihmAppHidden);
try {
  const page = await app.firstWindow();
  const frames = [];
  page.on('websocket', socket => { if (socket.url().includes('/api/ws/inbox')) socket.on('framereceived', frame => frames.push(String(frame.payload))); });

  // The setup screen refuses what it must.
  await page.locator('#connect').waitFor();
  await page.locator('#server').fill('http://example.org');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('error').textContent);
  await page.locator('#server').fill('https://127.0.0.1:1');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('error').textContent && !document.getElementById('connect').disabled);
  await page.locator('#use-proxy').check();
  await page.locator('#proxy-host').fill('bad host');
  await page.locator('#proxy-port').fill('1080');
  await page.locator('#server').fill(fixture.origin);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('error').textContent);
  await page.locator('#use-proxy').uncheck();
  console.log('ok: setup refuses a bad server and proxy');

  // Connect, and sign in as the web client would.
  await page.locator('#connect').click();
  await page.waitForURL(url => url.origin === fixture.origin);
  await page.evaluate(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, fixture.owner);
  await page.reload();
  await page.locator('.chat-item').first().waitFor();
  assert.equal(await page.evaluate(() => window.Android?.isDesktop), true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined', 'the page must not reach Node');
  console.log('ok: the web client runs, without Node');

  // The page stays alive in the tray and knows it is hidden.
  await page.locator('[data-chat-id="design-team"]').click();
  await page.locator('.message-bubble').first().waitFor();
  const browserWindow = () => app.browserWindow(page);
  await (await browserWindow()).evaluate(window => window.close());
  await page.waitForFunction(() => window.wihmAppHidden === true);
  assert.equal(await (await browserWindow()).evaluate(window => window.isVisible()), false);
  console.log('ok: closing hides to the tray');

  // A message from someone else reaches the inbox socket while hidden, and Windows shows it.
  await app.evaluate(({ Notification }) => {
    globalThis.shown = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function () { globalThis.shown.push(this.title); return show.call(this); };
  });
  const socket = await page.evaluate(({ origin, token }) => new Promise((done, fail) => {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/ws?chatId=design-team', ['wihm.v1', 'wihm.token.' + token]);
    ws.onopen = () => { ws.send(JSON.stringify({ action: 'send_message', chatId: 'design-team', text: 'windows inbox test', clientMsgId: 'cli_windows_test' })); setTimeout(() => { ws.close(); done(true); }, 500); };
    ws.onerror = () => fail(new Error('socket failed'));
  }), { origin: fixture.origin, token: fixture.peer.token });
  assert.equal(socket, true);
  const delivered = () => frames.some(frame => frame.includes('"chatId":"design-team"'));
  for (let i = 0; i < 40 && !delivered(); i++) await page.waitForTimeout(250);
  assert.ok(delivered(), 'inbox frames: ' + frames.join(' | '));
  for (let i = 0; i < 20 && !(await app.evaluate(() => globalThis.shown.length)); i++) await page.waitForTimeout(250);
  assert.equal(await app.evaluate(() => globalThis.shown.length), 1, 'one notification while hidden');
  console.log('ok: a message notifies while hidden');

  await (await browserWindow()).evaluate(window => window.show());
  await page.waitForFunction(() => window.wihmAppHidden === false);

  // The app's own settings reach the proxy, and Back leaves without saving.
  const address = page.url();
  await page.locator('#btn-main-menu').click();
  assert.match(await page.locator('#btn-menu-server').innerText(), /پروکسی|proxy/i);
  await page.locator('#btn-menu-server').click();
  await page.locator('#use-proxy').waitFor();
  await page.locator('#use-proxy').check();
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('error').textContent);
  await page.locator('#back').click();
  await page.waitForURL(url => url.origin === fixture.origin);
  await page.locator('.chat-item').first().waitFor();
  assert.equal(new URL(page.url()).origin, new URL(address).origin);
  await page.locator('#btn-main-menu').click();
  await page.locator('#btn-menu-server').click();
  await page.locator('#use-proxy').waitFor();
  assert.equal(await page.locator('#use-proxy').isChecked(), false, 'Back must not save the proxy');
  await page.locator('#back').click();
  await page.locator('.chat-item').first().waitFor();
  console.log('ok: settings reach the proxy, and Back saves nothing');

  // The menu names the app's version, and the update page can check from inside the app.
  const version = createRequire(resolve('windows/package.json'))('./package.json').version;
  await page.locator('#btn-main-menu').click();
  assert.match(await page.locator('.app-version').innerText(), new RegExp('Windows ' + version.replaceAll('.', '[.]')));
  await page.keyboard.press('Escape');
  await app.evaluate(({ dialog }) => {
    globalThis.answers = [];
    dialog.showMessageBox = async ({ message }) => { globalThis.answers.push(message); return { response: 1 }; };
    dialog.showErrorBox = (title, content) => { globalThis.answers.push(title + ': ' + content); };
  });
  await page.evaluate(() => { document.getElementById('settings-updates').click(); });
  await page.locator('#desktop-update-check').click();
  for (let i = 0; i < 40 && !(await app.evaluate(() => globalThis.answers.length)); i++) await page.waitForTimeout(250);
  assert.equal(await app.evaluate(() => globalThis.answers.length), 1, 'the check must answer');
  await page.locator('#btn-close-feature').click();
  console.log('ok: version and update check inside the app');

  // Other sites never open inside the app.
  const before = page.url();
  await page.evaluate(() => { location.href = 'https://example.org/'; }).catch(() => {});
  await page.waitForTimeout(800);
  assert.equal(page.url(), before);
  console.log('ok: other sites stay out');

  // Permissions are for this server only.
  assert.equal(await page.evaluate(() => Notification.permission), 'granted');
  console.log('Windows app passed.');
} finally {
  await app.evaluate(({ app }) => { app.isQuitting = true; app.quit(); }).catch(() => {});
  await app.close().catch(() => {});
  await fixture.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
