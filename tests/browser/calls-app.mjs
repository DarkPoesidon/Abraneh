// Full app + real Worker/D1/Durable Object signaling. Only media devices and STUN are local test substitutes.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Response } from 'miniflare';
const directory = '.wrangler/calls-app-qa'; await mkdir(directory, { recursive: true });
let turnRequests = 0;
const token = 'test-only-turn-key-token-never-a-real-secret';
const fixture = await createNavigationFixture({ outboundService: async request => {
  console.log('Mock TURN request:', request.url);
  assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/test-turn-key-id/credentials/generate-ice-servers');
  assert.equal(request.headers.get('Authorization'), 'Bearer ' + token); assert.deepEqual(await request.json(), { ttl: 1200 }); turnRequests++;
  return Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'temporary-test-user', credential: 'temporary-test-password' }] }, { status: 201 });
} }), contexts = [], errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
async function api(path, account, body) {
  const response = await fixture.mf.dispatchFetch(fixture.origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
}
try {
  const chat = await api('/api/chats', fixture.owner, { targetUserId: fixture.peer.user.id });
  assert.equal((await fixture.mf.dispatchFetch(fixture.origin + '/api/calls/incoming')).status, 401);
  assert.equal((await fixture.mf.dispatchFetch(fixture.origin + '/api/service/calls', { headers: { Authorization: 'Bearer ' + fixture.peer.token } })).status, 403);
  const inactive = await fixture.mf.dispatchFetch(fixture.origin + '/api/calls/ice', { method: 'POST', headers: { Authorization: 'Bearer ' + fixture.peer.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat.id, callId: 'missing-call' }) }); assert.equal(inactive.status, 403);
  const pages = [];
  for (const [i, account] of [fixture.owner, fixture.peer].entries()) {
    const context = await browser.newContext({ viewport: { width: i ? 375 : 1280, height: 850 }, permissions: ['microphone', 'camera'], serviceWorkers: 'block' }); contexts.push(context);
    await context.addInitScript(account => {
      localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user));
      window.peers = []; window.tracks = []; window.captures = []; window.iceOptions = [];
      const Peer = RTCPeerConnection; window.RTCPeerConnection = class extends Peer { constructor(options) { super({ ...options, iceServers: [] }); peers.push(this); iceOptions.push(options); } };
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { captures.push(constraints); const stream = await capture(constraints); tracks.push(...stream.getTracks()); return stream; };
    }, account);
    const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto(fixture.origin); await page.locator('.chat-item').first().waitFor();
  }
  const [a, b] = pages;
  await a.locator(`.chat-item[data-chat-id="${chat.id}"]`).click();
  await a.waitForFunction(() => document.querySelector('#status-text').textContent === 'متصل به سرور');
  for (const video of [false, true]) {
    if (video) {
      await api('/api/service/claim', fixture.owner, { code: 'local-fixture-owner-code' });
      assert.equal((await api('/api/service/calls', fixture.owner, { keyId: 'test-turn-key-id', token })).configured, true);
      const stored = await (await fixture.mf.getD1Database('DB')).prepare("SELECT value FROM site_settings WHERE key='call_turn'").first(); assert.ok(!stored.value.includes(token), 'TURN master token must be encrypted at rest');
      assert.ok(!JSON.stringify(await api('/api/service/calls', fixture.owner)).includes(token), 'Settings response must never disclose the master token');
    }
    await a.getByRole('button', { name: video ? 'تماس تصویری' : 'تماس صوتی', exact: true }).click();
    await b.locator('dialog.call-dialog').waitFor({ timeout: 12000 });
    assert.equal(await b.evaluate(() => captures.length), video ? 1 : 0, 'Incoming ringing must not capture media');
    for (const [i, page] of pages.entries()) await page.screenshot({ path: `${directory}/${video ? 'video' : 'audio'}-ringing-${i}.png` });
    await b.locator('.call-accept').click();
    for (const page of pages) {
      await page.waitForFunction(() => document.querySelector('dialog [role=status]').textContent.startsWith('تماس برقرار است.'), {}, { timeout: 20000 });
      await page.waitForFunction(async video => {
        const kinds = new Set(); for (const peer of peers) for (const r of (await peer.getStats()).values()) if (r.type === 'inbound-rtp' && r.bytesReceived > 0 && (!video || r.kind !== 'video' || r.framesDecoded > 0)) kinds.add(r.kind);
        return kinds.has('audio') && (!video || kinds.has('video'));
      }, video, { timeout: 20000 });
      assert.equal(await page.evaluate(video => captures.at(-1).video === video, video), true);
      const playback = page.getByRole('button', { name: 'پخش صدای مخاطب', exact: true }); if (await playback.isVisible()) await playback.click();
      await page.waitForFunction(video => { const audio = document.querySelector('dialog audio'), image = document.querySelector('.call-remote'); return !audio.paused && !audio.muted && audio.readyState >= 2 && (!video || !image.paused && image.muted && image.readyState >= 2 && image.videoWidth > 0); }, video, { timeout: 20000 });
      assert.equal(await page.evaluate(() => iceOptions.at(-1).iceServers.some(server => JSON.stringify(server.urls).includes('turn:'))), video, 'Configured TURN credentials must reach the peer connection');
      await page.locator('.call-microphone').click(); assert.equal(await page.evaluate(() => tracks.filter(t => t.readyState === 'live' && t.kind === 'audio').every(t => !t.enabled)), true);
      await page.locator('.call-microphone').click();
      await page.locator('.call-speaker').click(); assert.equal(await page.evaluate(() => document.querySelector('dialog audio').muted), true); await page.locator('.call-speaker').click();
      if (video) { await page.locator('.call-camera').click(); assert.equal(await page.evaluate(() => tracks.filter(t => t.readyState === 'live' && t.kind === 'video').every(t => !t.enabled)), true); await page.locator('.call-camera').click(); }
    }
    for (const [i, page] of pages.entries()) await page.screenshot({ path: `${directory}/${video ? 'video' : 'audio'}-connected-${i}.png` });
    await a.getByRole('button', { name: 'پایان تماس', exact: true }).click();
    for (const page of pages) { await page.locator('dialog').waitFor({ state: 'hidden' }); assert.equal(await page.evaluate(() => tracks.every(t => t.readyState === 'ended')), true); }
    assert.deepEqual(await api('/api/calls/incoming', fixture.peer), []);
  }
  await a.locator('#btn-main-menu').click(); await a.locator('#btn-menu-settings').click(); await a.locator('#settings-admin').click(); await a.locator('#service-call-settings').click();
  assert.equal(await a.locator('#turn-key-id').inputValue(), 'test-turn-key-id'); assert.equal(await a.locator('#turn-key-token').inputValue(), '');
  await a.locator('#turn-key-token').fill(token); await a.locator('#turn-form button').click(); await a.locator('#feature-status').filter({ hasText: 'کلید تأیید شد' }).waitFor(); assert.equal(await a.locator('#turn-key-token').inputValue(), '');
  assert.deepEqual(errors, []);
  assert.equal(turnRequests, 4, 'API and settings UI validation, and one short-lived credential per participant');
  await writeFile(directory + '/results.json', JSON.stringify({ passed: true, fullApplication: true, realWorkerSignaling: true, incomingWithoutOpenChat: true, audioBytes: true, decodedVideoFrames: true, muteAndCamera: true, stopTracks: true, physicalDevices: false, errors }, null, 2));
  console.log('Full application voice/video calls passed, including incoming calls before opening the conversation.');
} catch (error) {
  for (const [i, context] of contexts.entries()) for (const page of context.pages()) { await page.screenshot({ path: `${directory}/failure-${i}.png` }); console.log(i, await page.locator('body').innerText()); console.log('media', await page.evaluate(() => [...document.querySelectorAll('video,audio')].map(media => ({ class: media.className, paused: media.paused, muted: media.muted, ready: media.readyState, time: media.currentTime, stream: media.srcObject?.id, tracks: media.srcObject?.getTracks().map(track => ({ kind: track.kind, enabled: track.enabled, ready: track.readyState })) })))); }
  throw error;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await fixture.close(); }
