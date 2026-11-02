const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
let fixture, chatId, sockets = [];
const webm = size => { const bytes = new Uint8Array(size); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); for (let i = 4; i < size; i++) bytes[i] = i % 251; return bytes; };
const headers = account => ({ ...(account ? { Authorization: 'Bearer ' + account.token } : {}) });
before(async () => {
  fixture = await (await import('./browser/fixture.mjs')).createNavigationFixture();
  const response = await fixture.mf.dispatchFetch(fixture.origin + '/api/chats', { method: 'POST', headers: { ...headers(fixture.owner), 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUserId: fixture.peer.user.id }) });
  chatId = (await response.json()).id;
});
after(async () => { for (const socket of sockets) socket.close(); await fixture?.close(); });
function upload(account, bytes, query = {}, chat = chatId) {
  const params = new URLSearchParams({ kind: 'voice', mime: 'audio/webm;codecs=opus', durationMs: '3000', ...query });
  return fixture.mf.dispatchFetch(`${fixture.origin}/api/chats/${chat}/media?${params}`, { method: 'POST', headers: headers(account), body: bytes });
}
const download = (account, id, chat = chatId) => fixture.mf.dispatchFetch(`${fixture.origin}/api/chats/${chat}/media/${id}`, { headers: headers(account) });
async function stranger() {
  const response = await fixture.mf.dispatchFetch(fixture.origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'stranger_' + Date.now().toString(36), password: 'fixture-only-pass123' }) });
  return response.json();
}

test('a recording larger than one storage row round-trips byte for byte to the other member', async () => {
  const bytes = webm(2_500_000), response = await upload(fixture.owner, bytes, { clientMsgId: 'cli_big' });
  assert.equal(response.status, 201);
  const { message } = await response.json();
  assert.deepEqual(message.media, { kind: 'voice', mime: 'audio/webm', size: bytes.length, durationMs: 3000 });
  assert.match(message.text, /پیام صوتی/);
  const stored = await download(fixture.peer, message.id);
  assert.equal(stored.status, 200); assert.equal(stored.headers.get('Content-Type'), 'audio/webm'); assert.equal(stored.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), bytes);
  const history = await (await fixture.mf.dispatchFetch(`${fixture.origin}/api/chats/${chatId}/messages?limit=5`, { headers: headers(fixture.peer) })).json();
  assert.equal(history.find(row => row.id === message.id).media.size, bytes.length);
});

test('a retry with the same client id reuses the stored message', async () => {
  const first = await (await upload(fixture.owner, webm(2000), { clientMsgId: 'cli_retry' })).json();
  const second = await upload(fixture.owner, webm(2000), { clientMsgId: 'cli_retry' });
  assert.equal(second.status, 200); assert.equal((await second.json()).message.id, first.message.id);
});

test('only members with a session can send or download', async () => {
  const { message } = await (await upload(fixture.owner, webm(2000))).json(), outsider = await stranger();
  assert.equal((await upload(null, webm(2000))).status, 401);
  assert.equal((await upload(outsider, webm(2000))).status, 403);
  assert.equal((await download(null, message.id)).status, 401);
  assert.equal((await download(outsider, message.id)).status, 403);
});

test('blocked participants cannot send', async () => {
  const db = await fixture.mf.getD1Database('DB');
  await db.prepare('INSERT INTO blocked_users VALUES (?,?,?)').bind(fixture.peer.user.id, fixture.owner.user.id, Date.now()).run();
  try { assert.equal((await upload(fixture.owner, webm(2000))).status, 403); }
  finally { await db.prepare('DELETE FROM blocked_users').run(); }
});

test('type, container, size and duration are checked by the server', async () => {
  assert.equal((await upload(fixture.owner, webm(2000), { mime: 'text/html' })).status, 415);
  assert.equal((await upload(fixture.owner, webm(2000), { kind: 'video', mime: 'audio/webm' })).status, 415);
  assert.equal((await upload(fixture.owner, new TextEncoder().encode('<script>alert(1)</script>'))).status, 400);
  assert.equal((await upload(fixture.owner, webm(4 * 1048576 + 1))).status, 413);
  assert.equal((await upload(fixture.owner, webm(2000), { durationMs: String(10 * 60_000) })).status, 400);
});

test('deleting a media message removes its bytes and it cannot be edited', async () => {
  const { message } = await (await upload(fixture.owner, webm(2000))).json();
  const action = (name, body) => fixture.mf.dispatchFetch(`${fixture.origin}/api/chats/${chatId}/messages/${message.id}/${name}`, { method: 'POST', headers: { ...headers(fixture.owner), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await action('edit', { text: 'changed' })).status, 400);
  assert.equal((await action('delete', {})).status, 200);
  assert.equal((await download(fixture.peer, message.id)).status, 404);
});

test('a WebSocket authenticates with a subprotocol and never needs the token in its URL', async () => {
  const response = await fixture.mf.dispatchFetch(`${fixture.origin}/ws?chatId=${chatId}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'wihm.v1, wihm.token.' + fixture.owner.token } });
  assert.equal(response.status, 101); assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'wihm.v1');
  response.webSocket.accept(); sockets.push(response.webSocket);
  const refused = await fixture.mf.dispatchFetch(`${fixture.origin}/ws?chatId=${chatId}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'wihm.v1, wihm.token.not-a-token' } });
  assert.equal(refused.status, 401);
});

test('new accounts need an eight character password and unknown users get the same login error', async () => {
  const register = await fixture.mf.dispatchFetch(fixture.origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'short_pass', password: '1234567' }) });
  assert.equal(register.status, 400);
  const login = username => fixture.mf.dispatchFetch(fixture.origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'definitely-wrong' }) });
  const [missing, wrong] = await Promise.all([login('nobody_here'), login('nila')]);
  assert.equal(missing.status, 401); assert.equal(wrong.status, 401);
  assert.deepEqual(await missing.json(), await wrong.json());
});
