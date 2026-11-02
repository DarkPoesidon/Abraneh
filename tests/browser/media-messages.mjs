// Two real browsers record, send and play voice and video messages against a real local Worker and Durable Object.
const { chromium } = await import(process.env.WIHM_PLAYWRIGHT_MODULE || 'playwright-core');
import { createNavigationFixture } from './fixture.mjs';
import assert from 'node:assert/strict';

const fixture = await createNavigationFixture(), contexts = [], errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.WIHM_CHROME_PATH ? { executablePath: process.env.WIHM_CHROME_PATH } : {}) });
async function open(account, width) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, permissions: ['microphone', 'camera'], serviceWorkers: 'block' }); contexts.push(context);
  await context.addInitScript(account => { localStorage.setItem('cf_msg_token', account.token); localStorage.setItem('cf_msg_user', JSON.stringify(account.user)); }, account);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.origin); await page.locator('.chat-item').first().waitFor();
  return page;
}
async function record(page, kind, ms = 1600) {
  await page.locator('#btn-record-' + kind).click();
  await page.locator('.media-recorder:not([hidden]) .media-send').waitFor();
  await new Promise(resolve => setTimeout(resolve, ms));
}
const sendRecording = async page => { await page.locator('.media-send').click(); await page.locator('.media-recorder').waitFor({ state: 'hidden', timeout: 15000 }); };

try {
  const created = await fixture.mf.dispatchFetch(fixture.origin + '/api/chats', { method: 'POST', headers: { Authorization: 'Bearer ' + fixture.owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUserId: fixture.peer.user.id }) });
  const chat = await created.json();
  const a = await open(fixture.owner, 1000), b = await open(fixture.peer, 375);
  for (const page of [a, b]) await page.locator(`.chat-item[data-chat-id="${chat.id}"]`).click();
  await a.locator('#btn-record-voice').waitFor();

  // Voice: reaches the other side live and really plays.
  await record(a, 'voice'); await sendRecording(a);
  const voice = b.locator('.media-play').last(); await voice.waitFor({ timeout: 10000 }); assert.match(await voice.getAttribute('aria-label'), /پیام صوتی/);
  await voice.click();
  await b.waitForFunction(() => { const player = document.querySelector('audio.media-player'); return player && !player.paused && player.currentTime > 0; }, {}, { timeout: 15000 });
  console.log('ok: voice message plays on the other side');

  // The player controls itself: its button pauses and resumes, and the seek bar works by keyboard.
  await b.locator('.voice-note[data-state="playing"] .media-play').click();
  await b.waitForFunction(() => document.querySelector('audio.media-player').paused);
  await b.locator('.voice-note .media-play').last().click();
  await b.waitForFunction(() => { const player = document.querySelector('audio.media-player'); return !player.paused || player.ended; });
  assert.equal(await b.locator('.voice-seek').last().isEnabled(), true);
  console.log('ok: voice player pause and resume');

  // With text typed, the round action sends; with none, it records.
  assert.equal(await a.locator('#btn-send-message').isVisible(), false); assert.equal(await a.locator('#btn-record-voice').isVisible(), true);
  await a.locator('#message-input').fill('متن'); assert.equal(await a.locator('#btn-send-message').isVisible(), true); assert.equal(await a.locator('#btn-record-voice').isVisible(), false);
  await a.locator('#message-input').fill(''); assert.equal(await a.locator('#btn-record-voice').isVisible(), true);
  console.log('ok: composer swaps send and record');

  // Playback survives the message list being rebuilt by a new message.
  await a.locator('#message-input').fill('متن تازه'); await a.locator('#btn-send-message').click();
  await b.locator('.message-text', { hasText: 'متن تازه' }).waitFor();
  const before = await b.evaluate(() => document.querySelector('audio.media-player').currentTime);
  await new Promise(resolve => setTimeout(resolve, 400));
  const still = await b.evaluate(() => { const player = document.querySelector('audio.media-player'); return { paused: player.paused, ended: player.ended, time: player.currentTime }; });
  assert.ok(still.ended || (!still.paused && still.time >= before), 'playback must survive a re-render');
  console.log('ok: playback survives a new message');

  // Video: the preview shows while recording, and the other side sees frames.
  await record(b, 'video', 2000);
  assert.equal(await b.locator('.media-preview').isVisible(), true); await sendRecording(b);
  const video = a.locator('.media-play').last(); await video.waitFor({ timeout: 10000 }); assert.match(await video.getAttribute('aria-label'), /پیام تصویری/);
  await video.click();
  await a.waitForFunction(() => { const player = document.querySelector('video.media-player'); return player && player.videoWidth > 0 && player.readyState >= 2; }, {}, { timeout: 15000 });
  console.log('ok: video message plays on the other side');

  // Cancel sends nothing and releases the microphone.
  const count = await a.locator('.message-bubble').count();
  await record(a, 'voice', 300); await a.locator('.media-cancel').click();
  await a.locator('.media-recorder').waitFor({ state: 'hidden' });
  assert.equal(await a.locator('.message-bubble').count(), count);
  console.log('ok: cancel sends nothing');

  // A press too short to hold anything is refused with an explanation.
  await record(a, 'voice', 100); await a.locator('.media-send').click();
  await a.locator('#chat-error', { hasText: 'خیلی کوتاه' }).waitFor();
  console.log('ok: short recording is explained');

  // A failed upload keeps the recording for a retry, which then sends it once.
  await a.route('**/media?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'سرور در دسترس نیست' }) }));
  await record(a, 'voice'); await a.locator('.media-send').click();
  await a.locator('.media-send', { hasText: 'تلاش دوباره' }).waitFor();
  await a.unroute('**/media?*');
  const sent = await a.locator('.media-play, .media-player').count();
  await a.locator('.media-send').click(); await a.locator('.media-recorder').waitFor({ state: 'hidden', timeout: 15000 });
  await a.waitForFunction(sent => document.querySelectorAll('.media-play, .media-player').length === sent + 1, sent);
  console.log('ok: retry after a failed upload');

  // Deleted media stops being playable for everyone.
  await a.locator('.message-bubble.sent:has(.media-play) .message-more').last().click();
  await a.locator('#action-delete').click();
  await a.locator('.message-bubble.sent .deleted-message').last().waitFor();
  console.log('ok: delete');

  assert.deepEqual(errors, []);
  console.log('Media messages passed.');
} finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); await browser.close(); await fixture.close(); }
