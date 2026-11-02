// Two real browsers against real local Worker/D1/Durable Object signaling, testing calls under failure.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';

const fixture = await createNavigationFixture(), contexts = [], errors = [];
const launch = { headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) };
const browser = await chromium.launch(launch);
async function api(path, account, body) {
  const response = await fixture.mf.dispatchFetch(fixture.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
}
async function open(account, { noCamera = false, breakIce = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 }, permissions: ['microphone', 'camera'], serviceWorkers: 'block' }); contexts.push(context);
  await context.addInitScript(({ account, noCamera }) => {
    localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user));
    window.sockets = []; window.peers = [];
    const Socket = WebSocket; window.WebSocket = class extends Socket { constructor(...args) { super(...args); sockets.push(this); } };
    const Peer = RTCPeerConnection; window.RTCPeerConnection = class extends Peer { constructor(options) { super({ ...options, iceServers: [] }); peers.push(this); } };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { if (noCamera && constraints.video) throw new DOMException('no camera', 'NotFoundError'); return capture(constraints); };
  }, { account, noCamera });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  if (breakIce) await page.route('**/api/calls/ice', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'TURN down' }) }));
  await page.goto(fixture.origin); await page.locator('.chat-item').first().waitFor();
  return page;
}
const connected = page => page.waitForFunction(() => document.querySelector('dialog [role=status]').textContent.startsWith('تماس برقرار است.'), {}, { timeout: 20000 });
const dialogOpen = page => page.evaluate(() => document.querySelector('dialog.call-dialog').open);
const inbound = (page, kind) => page.waitForFunction(async kind => {
  for (const peer of peers) for (const r of (await peer.getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === kind && r.bytesReceived > 0) return true;
  return false;
}, kind, { timeout: 20000 });
const bytes = (page, kind) => page.evaluate(async kind => { let total = 0; for (const r of (await peers.at(-1).getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === kind) total += r.bytesReceived; return total; }, kind);
// The server allows four rings a minute per user, counted in whole clock minutes.
let ringMinute = 0, rings = 0;
async function respectRingLimit() {
  const minute = () => Math.floor(Date.now() / 60_000);
  if (minute() === ringMinute && rings >= 4) await new Promise(resolve => setTimeout(resolve, (ringMinute + 1) * 60_000 - Date.now() + 200));
  if (minute() !== ringMinute) { ringMinute = minute(); rings = 0; }
  rings++;
}
async function startCall(a, b, chatId, video) {
  await respectRingLimit();
  await a.locator(`.chat-item[data-chat-id="${chatId}"]`).click();
  await a.waitForFunction(chatId => sockets.some(socket => socket.readyState === 1 && socket.url.includes(chatId)), chatId);
  await a.getByRole('button', { name: video ? 'تماس تصویری' : 'تماس صوتی', exact: true }).click();
  await b.locator('dialog.call-dialog').waitFor({ timeout: 12000 });
  await b.locator('.call-accept').click();
  await connected(a); await connected(b);
}
// Closes the socket of the open chat and returns a wait for its replacement.
async function dropSocket(page) {
  const count = await page.evaluate(() => { sockets.findLast(socket => socket.readyState === 1).close(); return sockets.length; });
  return () => page.waitForFunction(count => sockets.length > count && sockets.at(-1).readyState === 1, count, { timeout: 15000 });
}
const hangUp = async (a, b) => { await a.getByRole('button', { name: 'پایان تماس', exact: true }).click(); for (const page of [a, b]) await page.locator('dialog.call-dialog').waitFor({ state: 'hidden' }); };

try {
  const chat = await api('/api/chats', fixture.owner, { targetUserId: fixture.peer.user.id });
  let [a, b] = [await open(fixture.owner), await open(fixture.peer)];

  // 1. A brief loss of the chat socket must not end a call whose media is still flowing.
  await startCall(a, b, chat.id, false); await inbound(a, 'audio'); await inbound(b, 'audio');
  await (await dropSocket(a))();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await dialogOpen(a), true, 'caller lost the call when its socket dropped');
  assert.equal(await dialogOpen(b), true, 'callee lost the call when the other socket dropped');
  const before = await bytes(b, 'audio'); await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(await bytes(b, 'audio') > before, 'audio must keep flowing after the socket reconnects');
  console.log('ok: socket drop keeps the call');

  // 2. Hanging up after reconnecting still reaches the other side.
  await hangUp(a, b);
  console.log('ok: hangup after reconnect');

  // 3. Hanging up while the socket is down must not leave the other side or the server stuck.
  await startCall(a, b, chat.id, false);
  const reconnected = await dropSocket(a);
  await a.getByRole('button', { name: 'پایان تماس', exact: true }).click();
  await b.locator('dialog.call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await reconnected();
  console.log('ok: hangup while offline');

  // 4. The next call in the same chat must start straight away.
  await startCall(a, b, chat.id, false); await hangUp(a, b);
  console.log('ok: new call after offline hangup');

  // 5. A video call to someone without a camera connects as audio, and they still see the caller.
  await b.context().close(); contexts.splice(1, 1);
  b = await open(fixture.peer, { noCamera: true });
  await startCall(a, b, chat.id, true);
  await inbound(a, 'audio'); await inbound(b, 'audio'); await inbound(b, 'video');
  assert.equal(await b.locator('.call-camera').isVisible(), false);
  await hangUp(a, b);
  console.log('ok: callee without camera');

  // 6. A caller without a camera still receives the other side's video.
  await a.context().close(); contexts.splice(0, 1);
  a = await open(fixture.owner, { noCamera: true });
  await b.context().close(); contexts.splice(0, 1);
  b = await open(fixture.peer);
  await startCall(a, b, chat.id, true);
  await inbound(a, 'video'); await inbound(b, 'audio');
  await hangUp(a, b);
  console.log('ok: caller without camera');

  // 7. A TURN credential failure must fall back to a direct connection.
  await a.context().close(); contexts.splice(0, 1);
  a = await open(fixture.owner, { breakIce: true });
  await startCall(a, b, chat.id, false); await inbound(a, 'audio');
  await hangUp(a, b);
  console.log('ok: TURN failure falls back');

  // 8. A network change restarts ICE on the live call, and media keeps flowing on the new path.
  await startCall(a, b, chat.id, false); await inbound(a, 'audio'); await inbound(b, 'audio');
  const credentials = page => page.evaluate(() => peers.at(-1).localDescription.sdp.match(/a=ice-ufrag:(.+)/)[1]);
  const [callerBefore, calleeBefore] = [await credentials(a), await credentials(b)];
  await a.evaluate(() => { const peer = peers.at(-1); Object.defineProperty(peer, 'connectionState', { configurable: true, value: 'failed' }); peer.onconnectionstatechange(); delete peer.connectionState; });
  await a.waitForFunction(ufrag => !peers.at(-1).localDescription.sdp.includes('a=ice-ufrag:' + ufrag) && peers.at(-1).signalingState === 'stable', callerBefore, { timeout: 15000 });
  assert.notEqual(await credentials(b), calleeBefore, 'the callee must answer with new credentials');
  const flowing = await bytes(b, 'audio'); await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(await bytes(b, 'audio') > flowing, 'audio must keep flowing after the restart');
  assert.equal(await dialogOpen(a), true);
  await hangUp(a, b);
  console.log('ok: ICE restart');

  assert.deepEqual(errors, []);
  console.log('Call resilience passed.');
} finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); await browser.close(); await fixture.close(); }
