// Drives the shrunk QA build of the Android app on an emulator, against a real local Worker.
// Run from this repository, with the emulator already booted:
//   ANDROID_ADB=<adb path> WIHM_APK=<app-universal-qa.apk> WIHM_SHOTS=<folder> node tests/android/emulator-e2e.mjs
import { createNavigationFixture } from '../browser/fixture.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ADB = process.env.ANDROID_ADB || 'adb', APK = process.env.WIHM_APK, SHOTS = process.env.WIHM_SHOTS || '.';
const PACKAGE = 'com.wihm.messenger', SKIP_SLOW = !!process.env.WIHM_SKIP_SLOW;
// A hung emulator must fail the run, since adb itself never gives up waiting for it.
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26, timeout: 120000 });
const shell = command => adb('shell', command);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms, what) {
  const started = Date.now();
  for (;;) {
    let value; try { value = await check(); } catch (error) { value = false; if (Date.now() - started >= ms) throw error; }
    if (value) return Date.now() - started;
    if (Date.now() - started >= ms) assert.fail('Timed out waiting for ' + what);
    await sleep(250);
  }
}
const results = [];
function ok(name, detail = '') { results.push(name); console.log(`ok: ${name}${detail ? ' (' + detail + ')' : ''}`); }

const notifications = () => shell('dumpsys notification --noredact');
const ringing = () => /pkg=com\.wihm\.messenger[^\n]*id=9100/.test(notifications());
const hasText = text => notifications().includes(text);
const topActivity = () => (shell('dumpsys activity activities').match(/topResumedActivity=[^\n]*/) || [''])[0];
const serviceAlive = () => /ServiceRecord[^\n]*WihmNotificationService/.test(shell('dumpsys activity services ' + PACKAGE));
function shot(name) { writeFileSync(join(SHOTS, name + '.png'), execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 })); }
function tap(text) {
  shell('uiautomator dump /sdcard/ui.xml');
  const dump = shell('cat /sdcard/ui.xml'), node = dump.match(new RegExp(`text="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i')); // Android may show buttons in capitals.
  assert.ok(node, `No "${text}" on screen; top: ${topActivity()}`);
  shell(`input tap ${(+node[1] + +node[3]) >> 1} ${(+node[2] + +node[4]) >> 1}`);
}
const home = () => shell('input keyevent KEYCODE_HOME');
async function removeFromRecents() {
  // The same system call as swiping the app away, without depending on the launcher's layout.
  const root = shell('am stack list').split('RootTask id=').find(block => block.includes('taskId') && block.includes(PACKAGE + '/'));
  if (root) shell('am stack remove ' + parseInt(root));
  await sleep(1500);
  assert.ok(!shell('am stack list').includes(PACKAGE + '/'), 'the app must be gone from recents');
}

async function evaluateInApp(expression) {
  const pid = shell('pidof ' + PACKAGE).trim();
  adb('forward', 'tcp:9333', 'localabstract:webview_devtools_remote_' + pid);
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json(), target = targets.find(row => row.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const reply = new Promise(resolve => { socket.onmessage = event => resolve(JSON.parse(event.data)); });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  const { result } = await reply; socket.close();
  return result?.result?.value;
}

const fixture = await createNavigationFixture();
const port = new URL(fixture.origin).port, server = `http://localhost:${port}`;
const db = await fixture.mf.getD1Database('DB');
const events = [];
let caller, chatId, callNumber = 0;
async function callerSocket() {
  const response = await fixture.mf.dispatchFetch(`${fixture.origin}/ws?chatId=${chatId}&token=${fixture.owner.token}`, { headers: { Upgrade: 'websocket' } });
  caller = response.webSocket; caller.accept();
  caller.addEventListener('message', event => { try { events.push(JSON.parse(event.data)); } catch {} });
}
async function invite(video = false) {
  // The server allows a few invites a minute per user, which this test would otherwise exceed.
  for (;;) {
    const callId = 'e2e-call-' + (++callNumber) + '-' + Date.now();
    caller.send(JSON.stringify({ action: 'call_signal', chatId, callId, kind: 'invite', video }));
    await sleep(300);
    if (!events.some(event => event.event === 'call_error' && event.callId === callId)) return callId;
    await sleep(15000);
  }
}
const endCall = callId => caller.send(JSON.stringify({ action: 'call_signal', chatId, callId, kind: 'end' }));
async function connectedToInbox() {
  // The status line in the service's own notification reports the socket state.
  return notifications().includes('Connected and receiving');
}
const prepareDevice = () => adb('reverse', `tcp:${port}`, `tcp:${port}`);

try {
  const created = await fixture.mf.dispatchFetch(fixture.origin + '/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.owner.token }, body: JSON.stringify({ targetUserId: fixture.peer.user.id }) });
  chatId = (await created.json()).id; await callerSocket();

  try { adb('uninstall', PACKAGE); } catch {}
  adb('install', '-r', APK);
  for (const permission of ['POST_NOTIFICATIONS', 'RECORD_AUDIO', 'CAMERA']) shell(`pm grant ${PACKAGE} android.permission.${permission}`);
  prepareDevice();
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="server_url">${server}</string></map>`;
  writeFileSync(join(SHOTS, 'prefs.xml'), prefs);
  adb('push', join(SHOTS, 'prefs.xml'), '/data/local/tmp/prefs.xml');
  shell(`run-as ${PACKAGE} sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/prefs.xml shared_prefs/wihm_messenger_prefs.xml'`);

  shell(`am start -W -n ${PACKAGE}/.MainActivity`);
  await until(() => topActivity().includes(PACKAGE), 20000, 'the app to open');
  await until(() => evaluateInApp('document.readyState').then(state => state === 'complete'), 30000, 'the page to load');
  ok('the app opens the page from the server without a browser');
  await evaluateInApp(`localStorage.setItem('cf_msg_token',${JSON.stringify(fixture.peer.token)});localStorage.setItem('cf_msg_user',${JSON.stringify(JSON.stringify(fixture.peer.user))});location.reload();true`);
  await until(serviceAlive, 30000, 'the service to start after login');
  await until(connectedToInbox, 20000, 'the inbox socket');
  const row = await db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?').bind(fixture.peer.user.id).first();
  assert.ok(row?.endpoint.startsWith('wihm-native:'));
  ok('login starts the service, and its socket registers this device');
  await until(() => topActivity().includes('RequestIgnoreBatteryOptimizations'), 10000, 'the battery exemption dialog right after login');
  shot('00-battery-dialog');
  tap('Allow');
  await until(() => shell('dumpsys deviceidle whitelist').includes(PACKAGE), 8000, 'the battery exemption');
  await until(() => topActivity().includes('MainActivity'), 8000, 'the app to return after the dialog');
  ok('login asks for the battery exemption once, and the app returns');

  // The back key closes one layer at a time, and leaves the app from the chat list.
  const inApp = () => topActivity().includes(PACKAGE), back = () => shell('input keyevent KEYCODE_BACK');
  const settingsOpen = () => evaluateInApp("document.getElementById('feature-modal').style.display==='flex'");
  await evaluateInApp("document.getElementById('nav-settings').click()");
  await until(settingsOpen, 5000, 'settings to open');
  back(); await until(async () => !await settingsOpen(), 5000, 'back to close settings');
  assert.ok(inApp(), 'closing settings must stay in the app');
  await sleep(500); assert.equal(await settingsOpen(), false, 'settings must not open again');
  back(); await until(() => !inApp(), 5000, 'back on the chat list to leave the app');
  shell('monkey -p ' + PACKAGE + ' -c android.intent.category.LAUNCHER 1'); await until(inApp, 8000, 'the app to come back');
  ok('the back key closes settings, then leaves the app');
  shot('01-signed-in');

  home(); await sleep(2000);
  let callId = await invite();
  let took = await until(ringing, 8000, 'the ring with the app in the background');
  ok('a call rings with the app in the background', took + ' ms');
  endCall(callId); await until(() => !ringing(), 8000, 'the ring to stop'); await until(() => hasText('Missed call'), 5000, 'the missed call notification');
  ok('the caller hanging up stops the ring and leaves a missed call');

  await removeFromRecents();
  assert.ok(serviceAlive(), 'the service must survive removal from recents');
  await until(connectedToInbox, 10000, 'the socket after removal from recents');
  callId = await invite();
  took = await until(ringing, 8000, 'the ring with the app closed');
  ok('a call rings with the app removed from recents', took + ' ms');
  await sleep(1500); shot('02-incoming-call');
  const audio = shell('dumpsys audio');
  if (/USAGE_NOTIFICATION_RINGTONE[^\n]*(started|state:started)/.test(audio) || /usage=USAGE_NOTIFICATION_RINGTONE/.test(audio)) ok('the ringtone is playing'); else console.log('note: no ringtone player seen in dumpsys audio');
  const declinedFrom = events.length;
  // With the screen on, Android shows a call as a heads-up notification rather than a full screen.
  // uiautomator can't see that window, so this taps the button's place on this 1080x2340 device.
  shell('input tap 408 450');
  await until(() => events.slice(declinedFrom).some(event => event.kind === 'decline' && event.callId === callId), 8000, 'the decline to reach the caller');
  await until(() => !ringing(), 5000, 'the ring to stop after declining');
  ok('declining from the notification reaches the caller');

  shell('dumpsys battery unplug'); shell('input keyevent KEYCODE_SLEEP'); await sleep(1500);
  shell('dumpsys deviceidle force-idle');
  assert.match(shell('dumpsys deviceidle get deep'), /IDLE/);
  callId = await invite();
  took = await until(ringing, 10000, 'the ring in Doze');
  ok('a call rings with the screen off in Doze', took + ' ms');
  await until(() => topActivity().includes('IncomingCallActivity'), 8000, 'the full screen call over the sleeping screen');
  ok('the full screen call opens and wakes the screen');
  await sleep(1500);
  shot('03-full-screen-call');
  const acceptFrom = events.length;
  tap('Answer');
  await until(() => topActivity().includes('MainActivity'), 10000, 'the app to open from the answer button');
  await until(() => !ringing(), 8000, 'the ring to stop after answering');
  await until(() => events.slice(acceptFrom).some(event => event.kind === 'accept' && event.callId === callId), 30000, 'the page to accept the call');
  ok('answering opens the app and the page accepts the call');
  await sleep(1500); shot('04-answered');
  endCall(callId); await sleep(1500);
  shell('dumpsys deviceidle unforce'); shell('dumpsys battery reset');

  home(); await sleep(1500);
  const messageFrom = events.length;
  caller.send(JSON.stringify({ action: 'send_message', chatId, text: 'متن خصوصی', clientMsgId: 'e2e-' + Date.now() }));
  took = await until(() => hasText('New message in Abraneh'), 15000, 'the message notification');
  assert.ok(!hasText('متن خصوصی'), 'the text stays hidden until previews are on');
  await sleep(1000);
  assert.ok(!events.slice(messageFrom).some(event => event.event === 'receipt' && event.readId), 'a message must not count as read while the app is off screen');
  ok('a message notifies with the app closed, and hides its text', took + ' ms');

  shell('svc wifi disable; svc data disable'); await sleep(5000);
  callId = await invite(); await sleep(1000); endCall(callId); await sleep(500);
  shell('svc wifi enable; svc data enable');
  // Straight away: if the old socket is dead, the reconnect's catch-up must still find this call.
  callId = await invite();
  took = await until(ringing, 30000, 'the ring after the network returned');
  ok('a call placed as the network returns still rings', took + ' ms');
  endCall(callId); await until(() => !ringing(), 8000, 'the ring to stop');

  const pid = shell('pidof ' + PACKAGE).trim();
  shell(`run-as ${PACKAGE} kill -9 ${pid}`);
  await until(() => shell('pidof ' + PACKAGE).trim() && serviceAlive(), 90000, 'Android to restart the killed service');
  await until(connectedToInbox, 30000, 'the socket after the process was killed');
  callId = await invite();
  took = await until(ringing, 8000, 'the ring after the process was killed');
  ok('the service restarts after its process is killed', took + ' ms');
  endCall(callId); await until(() => !ringing(), 8000, 'the ring to stop');

  // adb can keep waiting on the old connection after the device has gone down.
  try { execFileSync(ADB, ['reboot'], { stdio: 'ignore', timeout: 20000 }); } catch {}
  await sleep(5000); adb('wait-for-device');
  await until(() => shell('getprop sys.boot_completed').trim() === '1', 180000, 'the emulator to boot');
  prepareDevice();
  await until(serviceAlive, 120000, 'the service to start after boot');
  await until(connectedToInbox, 90000, 'the socket after boot');
  callId = await invite();
  took = await until(ringing, 10000, 'the ring after reboot');
  ok('a reboot starts the service without opening the app', took + ' ms');
  endCall(callId); await until(() => !ringing(), 8000, 'the ring to stop');

  if (!SKIP_SLOW) {
    await sleep(7 * 60_000);
    assert.ok(await connectedToInbox(), 'the socket must stay up while idle');
    callId = await invite();
    took = await until(ringing, 8000, 'the ring after a long idle');
    ok('a call still rings after 7 idle minutes', took + ' ms');
    endCall(callId);
  }
  shell('run-as ' + PACKAGE + ' cat /dev/null');
  const crashes = shell(`logcat -d -b crash`);
  assert.ok(!crashes.includes(PACKAGE), 'the app must not crash:\n' + crashes.slice(-3000));
  ok('no crash in the log');
  console.log(shell('logcat -d -s WihmNotificationService').slice(-1500));
  console.log(`\nPassed ${results.length} checks.`);
} catch (error) {
  try { shot('failure'); writeFileSync(join(SHOTS, 'failure-logcat.txt'), shell('logcat -d -t 400')); writeFileSync(join(SHOTS, 'failure-notifications.txt'), notifications()); } catch {}
  console.error('FAILED after', results.length, 'checks:', error.message);
  console.error('recent call events:', JSON.stringify(events.slice(-6).map(({ event, kind, callId, message }) => ({ event, kind, callId, message }))));
  try { console.error(shell('logcat -d -s WihmNotificationService IncomingCall LaunchActivity AndroidRuntime').slice(-1500)); } catch {}
  process.exitCode = 1;
} finally {
  try { caller?.close(); } catch {}
  await fixture.close();
}
