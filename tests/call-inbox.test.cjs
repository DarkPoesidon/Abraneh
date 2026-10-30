const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
let fixture, chatId, caller, sockets = [];
before(async () => {
  fixture = await (await import('./browser/fixture.mjs')).createNavigationFixture();
  const result = await api('/api/chats', fixture.owner, { targetUserId: fixture.peer.user.id }); chatId = result.data.id;
  const response = await fixture.mf.dispatchFetch(`${fixture.origin}/ws?chatId=${chatId}&token=${fixture.owner.token}`, { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101); caller = response.webSocket; caller.accept(); sockets.push(caller);
});
after(async () => { for (const socket of sockets) socket.close(); await fixture?.close(); });
async function api(path, account, body) {
  const response = await fixture.mf.dispatchFetch(fixture.origin + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: 'Bearer ' + account.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function until(operation, predicate) {
  for (let i = 0; i < 50; i++) { const result = await operation(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for call state');
}
test('incoming calls reach a recipient without a room socket, remain private, respect blocks and can be declined', async () => {
  assert.equal((await api('/api/calls/incoming')).status, 401);
  assert.equal((await api('/api/service/calls', fixture.peer)).status, 403);
  caller.send(JSON.stringify({ action: 'call_signal', chatId, callId: 'incoming-one', kind: 'invite', video: false }));
  const incoming = await until(() => api('/api/calls/incoming', fixture.peer), result => result.data.length === 1);
  assert.equal(incoming.data[0].callId, 'incoming-one'); assert.equal(incoming.data[0].from, fixture.owner.user.id);
  assert.deepEqual((await api('/api/calls/incoming', fixture.owner)).data, []);
  const db = await fixture.mf.getD1Database('DB');
  await db.prepare('INSERT INTO blocked_users VALUES (?,?,?)').bind(fixture.peer.user.id, fixture.owner.user.id, Date.now()).run();
  assert.deepEqual((await api('/api/calls/incoming', fixture.peer)).data, []);
  assert.equal((await api('/api/calls/decline', fixture.peer, { chatId, callId: 'incoming-one' })).status, 403);
  await db.prepare('DELETE FROM blocked_users').run();
  assert.equal((await api('/api/calls/decline', fixture.peer, { chatId, callId: 'incoming-one' })).status, 200);
  assert.deepEqual((await api('/api/calls/incoming', fixture.peer)).data, []);
  assert.equal((await api('/api/calls/ice', fixture.peer, { chatId, callId: 'incoming-one' })).status, 403);
});
test('cancelled ringing disappears from the inbox and rejects unrelated TURN credential requests', async () => {
  caller.send(JSON.stringify({ action: 'call_signal', chatId, callId: 'incoming-two', kind: 'invite', video: true }));
  await until(() => api('/api/calls/incoming', fixture.peer), result => result.data.length === 1);
  assert.equal((await api('/api/calls/ice', fixture.owner, { chatId, callId: 'wrong-call' })).status, 403);
  assert.equal((await api('/api/calls/ice', fixture.owner, { chatId, callId: 'incoming-two' })).data.relay, false);
  caller.send(JSON.stringify({ action: 'call_signal', chatId, callId: 'incoming-two', kind: 'end' }));
  await until(() => api('/api/calls/incoming', fixture.peer), result => result.data.length === 0);
});
