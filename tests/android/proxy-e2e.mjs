// Proves the Android app's page and its inbox socket really travel through a SOCKS5 proxy.
// Run from this repository, with the emulator booted:
//   ANDROID_ADB=<adb path> WIHM_APK=<app-qa.apk> WIHM_SHOTS=<folder> node tests/android/proxy-e2e.mjs
import { createNavigationFixture } from '../browser/fixture.mjs';
import { execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ADB = process.env.ANDROID_ADB || 'adb', APK = process.env.WIHM_APK, SHOTS = process.env.WIHM_SHOTS || '.', PACKAGE = 'com.wihm.messenger';
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26, timeout: 120000 });
const shell = command => adb('shell', command);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms, what) { const started = Date.now(); for (;;) { let value; try { value = await check(); } catch {} if (value) return; if (Date.now() - started >= ms) assert.fail('Timed out waiting for ' + what); await sleep(250); } }

// A minimal SOCKS5 server without authentication. Everything goes to the local Worker.
const fixture = await createNavigationFixture();
const port = Number(new URL(fixture.origin).port);
const tunnels = [];
const proxy = createServer(client => {
  client.once('data', () => {
    client.write(Buffer.from([5, 0]));
    client.once('data', request => {
      const type = request[3], host = type === 3 ? request.subarray(5, 5 + request[4]).toString() : [...request.subarray(4, 8)].join('.');
      tunnels.push(host + ':' + request.readUInt16BE(request.length - 2));
      const upstream = connect(port, '127.0.0.1', () => { client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); upstream.pipe(client); client.pipe(upstream); });
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    });
  });
  client.on('error', () => {});
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

try {
  try { adb('uninstall', PACKAGE); } catch {}
  adb('install', '-r', APK);
  for (const permission of ['POST_NOTIFICATIONS', 'RECORD_AUDIO', 'CAMERA']) shell(`pm grant ${PACKAGE} android.permission.${permission}`);
  shell('dumpsys deviceidle whitelist +' + PACKAGE);
  adb('reverse', `tcp:${proxyPort}`, `tcp:${proxyPort}`);
  // This address has no route except through the proxy's tunnel to the Worker, and 10.0.2.2 reaches the host otherwise.
  const server = 'http://wihm-proxy-test.invalid:' + port;
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="server_url">${server}</string><boolean name="battery_exemption_asked" value="true" /><boolean name="proxy_enabled" value="true" /><string name="proxy_type">socks5</string><string name="proxy_host">127.0.0.1</string><int name="proxy_port" value="${proxyPort}" /></map>`;
  writeFileSync(join(SHOTS, 'prefs.xml'), prefs);
  adb('push', join(SHOTS, 'prefs.xml'), '/data/local/tmp/prefs.xml');
  shell(`run-as ${PACKAGE} sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/prefs.xml shared_prefs/wihm_messenger_prefs.xml'`);
  shell(`am start -W -n ${PACKAGE}/.MainActivity`);
  await until(() => tunnels.some(row => row.startsWith('wihm-proxy-test.invalid')), 30000, 'the page to use the proxy');
  console.log('ok: the page loads through SOCKS5, with the name resolved by the proxy');

  const pid = shell('pidof ' + PACKAGE).trim();
  adb('forward', 'tcp:9333', 'localabstract:webview_devtools_remote_' + pid);
  const target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(row => row.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `localStorage.setItem('cf_msg_token',${JSON.stringify(fixture.peer.token)});localStorage.setItem('cf_msg_user',${JSON.stringify(JSON.stringify(fixture.peer.user))});location.reload();true` } }));
  await sleep(500); socket.close();
  const notifications = () => shell('dumpsys notification --noredact');
  await until(() => notifications().includes('Connected and receiving'), 40000, 'the inbox socket through the proxy');
  console.log('ok: the background service connects through the proxy too');
  const before = tunnels.length;
  proxy.close();
  shell(`am force-stop ${PACKAGE}`);
  console.log(`\nPassed (${before} tunnels).`);
} finally {
  await fixture.close();
}
