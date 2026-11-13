const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
let fixture, chatId, caller, inbox, received = [];
const sockets = [];
async function connect(account) {
  const response = await fixture.mf.dispatchFetch(`${fixture.origin}/api/ws/inbox`, { headers: { Upgrade: 'websocket', ...(account ? { Authorization: 'Bearer ' + account.token } : {}) } });
  if (response.status !== 101) return { status: response.status };
  const socket = response.webSocket; socket.accept(); sockets.push(socket);
  return { status: 101, socket };
}
async function until(predicate) {
  // The message queue flushes on a Durable Object alarm, so this waits longer than a call does.
  for (let i = 0; i < 400; i++) { const found = predicate(); if (found) return found; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('Timed out; received ' + JSON.stringify(received));
}
before(async () => {
  fixture = await (await import('./browser/fixture.mjs')).createNavigationFixture();
  const created = await fixture.mf.dispatchFetch(fixture.origin + '/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.owner.token }, body: JSON.stringify({ targetUserId: fixture.peer.user.id }) });
  chatId = (await created.json()).id;
  const response = await fixture.mf.dispatchFetch(`${fixture.origin}/ws?chatId=${chatId}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol':'wihm.v1, wihm.token.'+fixture.owner.token } });
  caller = response.webSocket; caller.accept(); sockets.push(caller);
});
after(async () => { for (const socket of sockets) try { socket.close(); } catch {} await fixture?.close(); });

test('the native channel refuses anonymous clients and registers a signed-in device', async () => {
  assert.equal((await connect()).status, 401);
  const opened = await connect(fixture.peer); assert.equal(opened.status, 101);
  inbox = opened.socket; inbox.addEventListener('message', event => { if (event.data !== 'pong') received.push(JSON.parse(event.data)); });
  const db = await fixture.mf.getD1Database('DB');
  const row = await db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?').bind(fixture.peer.user.id).first();
  assert.ok(row.endpoint.startsWith('wihm-native:'));
  assert.equal((await db.prepare('SELECT notifications FROM user_profiles WHERE user_id=?').bind(fixture.peer.user.id).first()).notifications, 1);
});
test('keepalive pings are answered', async () => {
  const pong = new Promise(resolve => inbox.addEventListener('message', event => { if (event.data === 'pong') resolve(true); }));
  inbox.send('ping'); assert.equal(await pong, true);
});
test('an incoming call rings the closed app with the caller name, without VAPID keys, and ending it stops the ring', async () => {
  caller.send(JSON.stringify({ action: 'call_signal', chatId, callId: 'native-one', kind: 'invite', video: true }));
  const ring = await until(() => received.find(event => event.kind === 'call' && event.callId === 'native-one'));
  assert.equal(ring.chatId, chatId); assert.equal(ring.caller, 'نیلوفر'); assert.equal(ring.video, true); assert.ok(ring.expiresAt > Date.now());
  caller.send(JSON.stringify({ action: 'call_signal', chatId, callId: 'native-one', kind: 'end' }));
  await until(() => received.find(event => event.kind === 'call-end' && event.callId === 'native-one'));
});
test('a new message reaches the closed app and hides its text until previews are on', async () => {
  caller.send(JSON.stringify({ action: 'send_message', chatId, text: 'متن خصوصی', clientMsgId: 'native-message' }));
  const message = await until(() => received.find(event => event.messageId));
  assert.equal(message.chatId, chatId); assert.ok(!JSON.stringify(message).includes('متن خصوصی'));
});
test('a reconnect replaces the older socket of the same session', async () => {
  const closed = new Promise(resolve => inbox.addEventListener('close', () => resolve(true)));
  assert.equal((await connect(fixture.peer)).status, 101);
  assert.equal(await closed, true);
});
