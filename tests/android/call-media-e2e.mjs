// A real call with media between the Android app on an emulator and a browser, through a real local Worker.
// Run from this repository, with the emulator booted and the QA build available:
//   ANDROID_ADB=<adb path> WIHM_APK=<app-universal-qa.apk> WIHM_SHOTS=<folder> node tests/android/call-media-e2e.mjs
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from '../browser/fixture.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ADB = process.env.ANDROID_ADB || 'adb', APK = process.env.WIHM_APK, SHOTS = process.env.WIHM_SHOTS || '.';
const PACKAGE = 'com.wihm.messenger';
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26, timeout: 120000 });
const shell = command => adb('shell', command);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = [];
const note = line => { log.push(line); console.log(line); };
async function until(check, ms, what) {
  const started = Date.now();
  for (;;) {
    let value; try { value = await check(); } catch {}
    if (value) return;
    if (Date.now() - started >= ms) assert.fail('Timed out waiting for ' + what);
    await sleep(250);
  }
}
function tapText(text) {
  shell('uiautomator dump /sdcard/ui.xml');
  const node = shell('cat /sdcard/ui.xml').match(new RegExp(`text="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  assert.ok(node, `No "${text}" on screen`);
  shell(`input tap ${(+node[1] + +node[3]) >> 1} ${(+node[2] + +node[4]) >> 1}`);
}
function shot(name) { writeFileSync(join(SHOTS, name + '.png'), execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 })); }

// Stays attached to the app's page, so signaling frames and console errors are recorded as they happen.
async function attachToApp() {
  const pid = shell('pidof ' + PACKAGE).trim();
  adb('forward', 'tcp:9333', 'localabstract:webview_devtools_remote_' + pid);
  const target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(row => row.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl), waiting = new Map(); let id = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.id) { waiting.get(data.id)?.(data.result); waiting.delete(data.id); return; }
    if (data.method === 'Network.webSocketFrameSent') frame('app sent', data.params.response.payloadData);
    if (data.method === 'Network.webSocketFrameReceived') frame('app got', data.params.response.payloadData);
    if (data.method === 'Runtime.exceptionThrown') note('app exception: ' + data.params.exceptionDetails.text);
    if (data.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(data.params.type)) note('app console: ' + data.params.args.map(arg => arg.value ?? arg.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(resolve => { waiting.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Network.enable');
  return { close: () => socket.close(), evaluate: async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value };
}
function frame(side, text) {
  try { const data = JSON.parse(text); if (data.event === 'call_signal' || data.action === 'call_signal') note(`${side} ${data.kind}`); else if (data.event === 'call_error') note(`${side} call_error: ${data.message}`); } catch {}
}
const callState = `(() => { const dialog = document.querySelector('dialog.call-dialog'); return { open: !!dialog?.open, status: dialog?.querySelector('[role=status]')?.textContent || '', error: document.getElementById('chat-error')?.textContent || '' }; })()`;
const connected = state => state?.open && state.status.startsWith('تماس برقرار است.');

const fixture = await createNavigationFixture();
const port = new URL(fixture.origin).port, server = `http://localhost:${port}`;
// The emulator can't reach mDNS names, so the browser offers its real addresses.
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'], ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
let app;
async function bothStayUp(page, name) {
  await until(async () => connected(await app.evaluate(callState)) && connected(await page.evaluate(callState)), 30000, 'both sides to connect in: ' + name);
  await sleep(10000);
  assert.ok(connected(await app.evaluate(callState)), 'the app side must stay in the call');
  assert.ok(connected(await page.evaluate(callState)), 'the browser side must stay in the call');
  note('ok: ' + name);
}
async function hangUpFromBrowser(page) {
  await page.locator('dialog.call-dialog .call-end:visible').click();
  await until(async () => !(await app.evaluate(callState)).open, 8000, 'the app side to leave the call');
}

try {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.owner.token };
  const chatId = (await (await fixture.mf.dispatchFetch(fixture.origin + '/api/chats', { method: 'POST', headers, body: JSON.stringify({ targetUserId: fixture.peer.user.id }) })).json()).id;

  const context = await browser.newContext({ permissions: ['microphone', 'camera'], serviceWorkers: 'block' });
  await context.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, fixture.owner);
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => note('browser exception: ' + error.message));
  page.on('websocket', socket => { socket.on('framesent', event => frame('browser sent', event.payload)); socket.on('framereceived', event => frame('browser got', event.payload)); });
  await page.goto(fixture.origin);
  await page.locator(`.chat-item[data-chat-id="${chatId}"]`).click();
  await page.waitForFunction(() => document.querySelector('#status-text').textContent === 'متصل به سرور');

  try { adb('uninstall', PACKAGE); } catch {}
  adb('install', '-r', APK);
  for (const permission of ['POST_NOTIFICATIONS', 'RECORD_AUDIO', 'CAMERA']) shell(`pm grant ${PACKAGE} android.permission.${permission}`);
  shell('dumpsys deviceidle whitelist +' + PACKAGE);
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="server_url">${server}</string><boolean name="battery_exemption_asked" value="true" /></map>`;
  writeFileSync(join(SHOTS, 'prefs.xml'), prefs);
  adb('push', join(SHOTS, 'prefs.xml'), '/data/local/tmp/prefs.xml');
  shell(`run-as ${PACKAGE} sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/prefs.xml shared_prefs/wihm_messenger_prefs.xml'`);
  shell(`am start -W -n ${PACKAGE}/.MainActivity`);
  await until(async () => { app = await attachToApp(); if ((await app.evaluate('document.readyState')) === 'complete') return true; app.close(); }, 30000, 'the page to load');
  await app.evaluate(`localStorage.setItem('cf_msg_token',${JSON.stringify(fixture.peer.token)});localStorage.setItem('cf_msg_user',${JSON.stringify(JSON.stringify(fixture.peer.user))});location.reload();true`);
  await sleep(1000); await until(() => app.evaluate(`!!document.querySelector('.chat-item[data-chat-id="${chatId}"]')`), 30000, 'the chat list');
  // The list can render again while it loads, which would lose a single click.
  await until(async () => { await app.evaluate(`document.querySelector('.chat-item[data-chat-id="${chatId}"]')?.click();true`); await sleep(1500); return app.evaluate(`['متصل به سرور','آنلاین'].includes(document.querySelector('#status-text').textContent)`); }, 30000, 'the app socket');

  note('--- browser calls, app on screen answers on its page');
  await page.getByRole('button', { name: 'تماس صوتی', exact: true }).click();
  await until(() => app.evaluate(`document.querySelector('.call-accept')?.getClientRects().length>0`), 15000, 'the call on the app page');
  await app.evaluate(`document.querySelector('.call-accept').click();true`);
  await bothStayUp(page, 'browser to app on screen'); shot('call-a');
  await hangUpFromBrowser(page); await sleep(16000);

  note('--- app calls, browser answers');
  // Later, because the click opens a confirm dialog that blocks this evaluation until it closes.
  await app.evaluate(`setTimeout(()=>[...document.querySelectorAll('.call-launch')].find(button=>button.getAttribute('aria-label')==='تماس صوتی').click());true`);
  await sleep(1500); tapText('OK');
  await page.locator('.call-accept').waitFor({ timeout: 15000 });
  await page.locator('.call-accept').click();
  await bothStayUp(page, 'app to browser'); shot('call-b');
  await hangUpFromBrowser(page); await sleep(16000);

  note('--- browser calls, closed app answers from its notification');
  shell('input keyevent KEYCODE_HOME'); await sleep(1500);
  await page.getByRole('button', { name: 'تماس صوتی', exact: true }).click();
  await until(() => /pkg=com\.wihm\.messenger[^\n]*id=9100/.test(shell('dumpsys notification --noredact')), 10000, 'the ring');
  await sleep(1500);
  shell('input tap 672 450'); // The Answer button of the heads-up notification on this 1080x2340 device.
  await bothStayUp(page, 'browser to the app in the background'); shot('call-c');
  note('\nPassed.');
} catch (error) {
  note('FAILED: ' + error.message);
  try { note('app: ' + JSON.stringify(await app?.evaluate(callState)) + ' socket: ' + await app?.evaluate(`document.querySelector('#status-text').textContent`)); shot('call-failure'); } catch {}
  try { note(shell('logcat -d -t 80 -s chromium:E cr_media:* WihmNotificationService')); } catch {}
  process.exitCode = 1;
} finally {
  writeFileSync(join(SHOTS, 'call-media.log'), log.join('\n'));
  try { app?.close(); } catch {}
  await browser.close();
  await fixture.close();
}
