const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHmac, randomBytes } = require('node:crypto');
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

let mf, unconfigured, db;
const secret = randomBytes(32).toString('hex');
const adminCode = randomBytes(32).toString('hex');
const sockets = [];
const accounts = {};
let serial = 0;

before(async () => {
  const result = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform:'neutral', mainFields:['browser','module','main'], external: ['cloudflare:workers'] });
  const options = { name: 'test-worker', modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'test-db' }, durableObjects: { CHAT_ROOM: { className: 'ChatRoom', useSQLite: true } } };
  mf = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { JWT_SECRET: secret, ADMIN_SETUP_TOKEN: adminCode } }));
  unconfigured = new Miniflare(convertV4MiniflareOptions(options));
  db = await mf.getD1Database('DB');
  for (const runtime of [mf, unconfigured]) {
    const database = await runtime.getD1Database('DB');
    for (const sql of readFileSync('schema.sql', 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await database.prepare(sql).run();
  }
});

after(async () => {
  for (const socket of sockets) socket.close();
  await Promise.all([mf?.dispose(), unconfigured?.dispose()]);
});

async function api(path, { body, token, runtime = mf, headers = {}, method } = {}) {
  if (path === '/api/auth/register' && !headers['CF-Connecting-IP']) headers = { ...headers, 'CF-Connecting-IP': '198.51.100.' + (body?.username?.charCodeAt(0) || 1) };
  const response = await runtime.dispatchFetch('http://localhost' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

async function account(name, displayName = name) {
  if (!accounts[name]) {
    const response = await api('/api/auth/register', { body: { username: name, displayName, password: 'testpass123' } });
    assert.equal(response.status, 201, JSON.stringify(response));
    accounts[name] = response.data;
  }
  return accounts[name];
}

test('readiness endpoint checks schema without exposing configuration', async () => {
  const ready = await api('/api/health');
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.data, { app: 'wihm-cloudflare', version: '1.7.9', database: true });
  const missingSecret = await api('/api/health', { runtime: unconfigured });
  assert.equal(missingSecret.status, 503);
  assert.ok(!JSON.stringify(missingSecret.data).includes(secret));
});

async function dm(a, b) {
  const response = await api('/api/chats', { token: a.token, body: { targetUserId: b.user.id } });
  assert.ok([200, 201].includes(response.status));
  return response.data.id;
}

async function connect(user, chatId, path = '/ws') {
  const response = await mf.dispatchFetch(`http://localhost${path}?chatId=${chatId}&token=${user.token}`, { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  sockets.push(socket);
  return socket;
}

function nextEvent(socket, event, accepts = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Timed out waiting for ' + event)); }, 5000);
    function listener(message) {
      const data = JSON.parse(message.data);
      if (data.event !== event || !accepts(data)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', listener);
      resolve(data);
    }
    socket.addEventListener('message', listener);
  });
}

function tokenFor(payload, signingKey = secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const data = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + createHmac('sha256', signingKey).update(data).digest('base64url');
}

test('missing secret fails closed before registration and on both websocket routes', async () => {
  const registration = await api('/api/auth/register', { runtime: unconfigured, body: { username: 'no_secret', password: 'testpass123' } });
  assert.equal(registration.status, 503);
  const emptyDb = await unconfigured.getD1Database('DB');
  assert.equal((await emptyDb.prepare('SELECT COUNT(*) AS count FROM users').first()).count, 0);
  assert.equal((await api('/api/auth/login', { runtime: unconfigured, body: { username: 'no_secret', password: 'testpass123' } })).status, 503);
  for (const path of ['/ws', '/api/ws']) {
    const response = await unconfigured.dispatchFetch('http://localhost' + path + '?token=anything&chatId=anything', { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 503);
  }
});

test('Persian and emoji names register, log in, and round-trip through JWT', async () => {
  const user = await account('persian_name', 'علی احمدی 🌍');
  const login = await api('/api/auth/login', { body: { username: 'persian_name', password: 'testpass123' } });
  assert.equal(login.status, 200);
  const current = await api('/api/auth/me', { token: login.data.token });
  assert.equal(current.data.displayName, 'علی احمدی 🌍');
  assert.equal(current.data.id, user.user.id);
  assert.equal((await api('/api/auth/login', { body: { username: 'persian_name', password: 'incorrect' } })).status, 401);
});

test('old public-key forgeries and invalid signed claims are rejected', async () => {
  const user = await account('victim');
  const payload = { userId: user.user.id, username: 'victim', displayName: 'Victim', exp: Math.floor(Date.now() / 1000) + 3600 };
  const publicKey = 'cloudflare-messenger-secure-default-jwt-secret-key-change-in-prod';
  assert.equal((await api('/api/auth/me', { token: tokenFor(payload, publicKey) })).status, 401);
  for (const invalid of [{ ...payload, exp: 0 }, { ...payload, exp: undefined }, { ...payload, exp: '99999999999' }, { ...payload, userId: null }]) {
    assert.equal((await api('/api/auth/me', { token: tokenFor(invalid) })).status, 401);
  }
  assert.equal((await api('/api/auth/me', { token: tokenFor(payload, secret, { alg: 'none', typ: 'JWT' }) })).status, 401);
  assert.equal((await api('/api/auth/me', { token: user.token })).status, 200);
});

test('concurrent DM creation from both users returns one room and preserves old room IDs', async () => {
  const a = await account('parallel_a'), b = await account('parallel_b');
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => api('/api/chats', { token: i % 2 ? a.token : b.token, body: { targetUserId: i % 2 ? b.user.id : a.user.id } })));
  assert.ok(responses.every(r => [200, 201].includes(r.status)));
  assert.equal(new Set(responses.map(r => r.data.id)).size, 1);
  assert.equal(responses.filter(r => r.data.isNew).length, 1);
  const x = await account('legacy_a'), y = await account('legacy_b');
  await db.batch([
    db.prepare("INSERT INTO chats VALUES ('legacy-room', 'dm', NULL, 1, 1)"),
    db.prepare("INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES ('legacy-room',?,1)").bind(x.user.id),
    db.prepare("INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES ('legacy-room',?,1)").bind(y.user.id),
  ]);
  assert.equal(await dm(x, y), 'legacy-room');
});

test('cross-room messages and typing have no side effects through either websocket alias', async () => {
  const a = await account('isolation_a'), b = await account('isolation_b'), c = await account('isolation_c');
  const own = await dm(a, b), other = await dm(b, c);
  const observer = await connect(b, own);
  const observed = [];
  observer.addEventListener('message', event => observed.push(JSON.parse(event.data)));
  for (const path of ['/ws', '/api/ws']) {
    const socket = await connect(a, own, path);
    for (const action of ['send_message', 'typing']) {
      for (const chatId of [other, undefined, { value: other }]) {
        const rejected = nextEvent(socket, 'error');
        socket.send(JSON.stringify({ action, chatId, text: 'must-not-be-saved', isTyping: true }));
        await rejected;
      }
    }
    const invalid = nextEvent(socket, 'error'); socket.send('null'); await invalid;
    const typing = nextEvent(observer, 'typing');
    socket.send(JSON.stringify({ action: 'typing', chatId: own, isTyping: true }));
    assert.equal((await typing).chatId, own);
    const sent = nextEvent(socket, 'new_message');
    socket.send(JSON.stringify({ action: 'send_message', chatId: own, text: 'legitimate-' + path }));
    assert.equal((await sent).message.chatId, own);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?').bind(other).first()).count, 0);
  const history = await api(`/api/chats/${own}/messages`, { token: a.token });
  assert.equal(history.data.length, 2);
  assert.ok(history.data.every(message => message.text.startsWith('legitimate-')));
  assert.ok(observed.filter(event => event.event === 'new_message' || event.event === 'typing').every(event => (event.chatId || event.message.chatId) === own));
  assert.equal((await api(`/api/chats/${other}/messages`, { token: a.token })).status, 403);
  assert.equal((await mf.dispatchFetch(`http://localhost/ws?chatId=${other}&token=${a.token}`, { headers: { Upgrade: 'websocket' } })).status, 403);
});

test('history paginates all messages with tied timestamps in DO and D1 fallback', async () => {
  const a = await account('history_a'), b = await account('history_b');
  const chatId = await dm(a, b), socket = await connect(a, chatId);
  for (let i = 0; i < 56; i++) {
    const received = nextEvent(socket, 'new_message');
    socket.send(JSON.stringify({ action: 'send_message', chatId, text: `history-${i}` }));
    await received;
  }
  async function readAll(id) {
    const seen = [];
    let cursor = '';
    while (true) {
      const response = await api(`/api/chats/${id}/messages?limit=13${cursor ? '&before=' + encodeURIComponent(cursor) : ''}`, { token: a.token });
      assert.equal(response.status, 200);
      if (!response.data.length) break;
      assert.ok(response.data.every(message => message.chatId === id));
      seen.push(...response.data);
      const first = response.data[0];
      cursor = `${first.createdAt}:${first.id}`;
    }
    return seen;
  }
  assert.equal(new Set((await readAll(chatId)).map(message => message.id)).size, 56);
  // Seed only D1, so the empty room exercises the fallback with identical timestamps.
  const fallback = 'd1-only-' + serial++;
  await db.batch([
    db.prepare("INSERT INTO chats VALUES (?, 'dm', NULL, 1, 1)").bind(fallback),
    db.prepare('INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES (?,?,1)').bind(fallback, a.user.id),
    ...Array.from({ length: 56 }, (_, i) => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind(`tie_${String(i).padStart(3, '0')}`, fallback, a.user.id, `tie-${i}`, 1000)),
  ]);
  const latest = await api(`/api/chats/${fallback}/messages`, { token: a.token });
  assert.equal(latest.data[0].id, 'tie_006');
  assert.equal(latest.data.at(-1).id, 'tie_055');
  assert.equal(new Set((await readAll(fallback)).map(message => message.id)).size, 56);
  // Adding one DO message must not make the older D1-only rows unreachable.
  const hybridSocket = await connect(a, fallback);
  const hybridSent = nextEvent(hybridSocket, 'new_message');
  hybridSocket.send(JSON.stringify({ action: 'send_message', chatId: fallback, text: 'new cached message' }));
  await hybridSent;
  assert.equal(new Set((await readAll(fallback)).map(message => message.id)).size, 57);
  for (const query of ['before=bad', 'limit=0', 'limit=101', 'before=9007199254740992:x']) assert.equal((await api(`/api/chats/${chatId}/messages?${query}`, { token: a.token })).status, 400);
});

test('group creation, member invitations, and authorization work end to end', async () => {
  const a = await account('group_a'), b = await account('group_b'), c = await account('group_c'), outsider = await account('outsider');
  const created = await api('/api/chats', { token: a.token, body: { type: 'group', title: 'گروه آزمایش', memberIds: [b.user.id, b.user.id] } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await api(`/api/chats/${id}/members`, { token: b.token })).data.length, 2);
  assert.equal((await api(`/api/chats/${id}/members`, { token: outsider.token, body: { userIds: [outsider.user.id] } })).status, 403);
  assert.equal((await api(`/api/chats/${id}/members`, { token: b.token, body: { userIds: [c.user.id, b.user.id] } })).status, 403);
  assert.equal((await api(`/api/chats/${id}/members`, { token: a.token, body: { userIds: [c.user.id] } })).status, 200);
  assert.equal((await api(`/api/chats/${id}/members`, { token: c.token })).data.length, 3);
  assert.ok((await api('/api/chats', { token: c.token })).data.some(chat => chat.id === id));
  const sender = await connect(a, id), receiver = await connect(c, id);
  const delivered = nextEvent(receiver, 'new_message');
  sender.send(JSON.stringify({ action: 'send_message', chatId: id, text: 'سلام گروه' }));
  assert.equal((await delivered).message.text, 'سلام گروه');
  const privateId = await dm(a, outsider);
  assert.equal((await api(`/api/chats/${privateId}/members`, { token: a.token, body: { userIds: [c.user.id] } })).status, 400);
  assert.equal((await api('/api/chats', { token: a.token, body: { type: 'group', memberIds: ['missing-user'] } })).status, 400);
});

test('repeated sends and concurrent retries acknowledge one canonical message, scoped to its sender', async () => {
  const a = await account('dedupe_a'), b = await account('dedupe_b');
  const chatId = await dm(a, b), first = await connect(a, chatId), second = await connect(a, chatId), peer = await connect(b, chatId);
  const seen = [];
  peer.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.event === 'new_message') seen.push(data.message); });
  const action = { action: 'send_message', chatId, text: 'stable message', clientMsgId: 'same-client-key' };
  const response = nextEvent(first, 'new_message'); first.send(JSON.stringify(action));
  const original = (await response).message;
  const retried = nextEvent(second, 'new_message'); second.send(JSON.stringify(action));
  assert.equal((await retried).message.id, original.id);
  const mismatch = nextEvent(first, 'error'); first.send(JSON.stringify({ ...action, text: 'different body' }));
  assert.equal((await mismatch).retryable, false);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').bind(chatId).first()).n, 1);
  assert.equal(seen.length, 1);
  const other = nextEvent(peer, 'new_message'); peer.send(JSON.stringify(action));
  assert.notEqual((await other).message.id, original.id);
  const history = await api(`/api/chats/${chatId}/messages`, { token: a.token });
  assert.equal(history.data.length, 2);
  assert.ok(history.data.every(message => message.clientMsgId === action.clientMsgId));
});

test('delivery and read receipts are distinct, authorized and monotonic, including tied timestamps', async () => {
  const a = await account('receipts_a'), b = await account('receipts_b'), outsider = await account('receipts_out');
  const chatId = await dm(a, b), sender = await connect(a, chatId);
  const response = nextEvent(sender, 'new_message'); sender.send(JSON.stringify({ action: 'send_message', chatId, text: 'read me', clientMsgId: 'receipt-1' }));
  const message = (await response).message;
  const unread = async () => (await api('/api/chats', { token: b.token })).data.find(chat => chat.id === chatId);
  assert.equal((await unread()).unreadCount, 1); assert.equal((await unread()).firstUnreadId, message.id);
  const event = nextEvent(sender, 'receipt');
  const delivered = await api(`/api/chats/${chatId}/receipts`, { token: b.token, body: { messageId: message.id, read: false } });
  assert.equal(delivered.status, 200); assert.equal(delivered.data.readAt, 0); assert.equal((await event).userId, b.user.id);
  assert.equal((await unread()).unreadCount, 1);
  await api(`/api/chats/${chatId}/receipts`, { token: b.token, body: { messageId: message.id, read: true } });
  assert.equal((await unread()).unreadCount, 0);
  assert.equal((await api(`/api/chats/${chatId}/receipts`, { token: outsider.token })).status, 403);
  assert.equal((await api(`/api/chats/${chatId}/receipts`, { token: b.token, body: { messageId: 'missing', read: true } })).status, 404);
  const tied = 'receipt-ties';
  await db.batch([
    db.prepare("INSERT INTO chats VALUES (?, 'dm', NULL, 1, 1)").bind(tied),
    ...[a, b].map(user => db.prepare('INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES (?,?,1)').bind(tied, user.user.id)),
    ...['a', 'b', 'c'].map(id => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind('receipt_tie_' + id, tied, a.user.id, id, 1000)),
    db.prepare('INSERT INTO message_metadata VALUES (?,?)').bind('receipt_tie_a', 'fallback-client-id'),
  ]);
  await api(`/api/chats/${tied}/receipts`, { token: b.token, body: { messageId: 'receipt_tie_b', read: true } });
  const regressed = await api(`/api/chats/${tied}/receipts`, { token: b.token, body: { messageId: 'receipt_tie_a', read: true } });
  assert.equal(regressed.data.readId, 'receipt_tie_b');
  const remaining = (await api('/api/chats', { token: b.token })).data.find(chat => chat.id === tied);
  assert.equal(remaining.unreadCount, 1); assert.equal(remaining.firstUnreadId, 'receipt_tie_c');
  assert.equal((await api(`/api/chats/${tied}/messages`, { token: b.token })).data[0].clientMsgId, 'fallback-client-id');
});

test('device revocation notifies live sockets and rejects legacy tokens first used after logout-others', async () => {
  const user = await account('device_owner'), other = await account('device_peer');
  const loggedIn = await api('/api/auth/login', { body: { username: 'device_owner', password: 'testpass123' } });
  const second = { user: user.user, token: loggedIn.data.token };
  const chatId = await dm(user, other), socket = await connect(second, chatId);
  const sessions = (await api('/api/auth/sessions', { token: user.token })).data;
  assert.equal(sessions.filter(session => session.current).length, 1); assert.equal(sessions.length, 2);
  const target = sessions.find(session => !session.current);
  assert.equal((await api('/api/auth/sessions/revoke', { token: other.token, body: { id: target.id } })).status, 404);
  const revoked = nextEvent(socket, 'session_revoked');
  assert.equal((await api('/api/auth/sessions/revoke', { token: user.token, body: { id: target.id } })).status, 200);
  assert.equal((await revoked).event, 'session_revoked');
  assert.equal((await api('/api/auth/me', { token: second.token })).status, 401);
  const legacyPayload = { userId: user.user.id, username: user.user.username, displayName: 'Old client', exp: Math.floor(Date.now() / 1000) + 3600 };
  const knownLegacy = tokenFor(legacyPayload), unseenLegacy = tokenFor({ ...legacyPayload, exp: legacyPayload.exp + 1 });
  assert.equal((await api('/api/auth/me', { token: knownLegacy })).status, 200);
  await api('/api/auth/sessions/revoke', { token: user.token, body: { others: true } });
  assert.equal((await api('/api/auth/me', { token: knownLegacy })).status, 401);
  assert.equal((await api('/api/auth/me', { token: unseenLegacy })).status, 401);
  assert.equal((await api('/api/auth/me', { token: user.token })).status, 200);
  await api('/api/auth/logout', { token: user.token, body: {} });
  assert.equal((await api('/api/auth/me', { token: user.token })).status, 401);
});

test('login and registration limits survive independent requests and return actionable 429 errors', async () => {
  for (let i = 0; i < 15; i++) assert.equal((await api('/api/auth/login', { body: { username: 'rate_unknown', password: 'incorrect' }, headers: { 'CF-Connecting-IP': '192.0.2.44' } })).status, 401);
  const limited = await api('/api/auth/login', { body: { username: 'rate_unknown', password: 'incorrect' }, headers: { 'CF-Connecting-IP': '192.0.2.44' } });
  assert.equal(limited.status, 429); assert.match(limited.data.error, /۱۵/);
  assert.equal((await api('/api/auth/login', { body: { username: 'rate_unknown', password: 'incorrect' }, headers: { 'CF-Connecting-IP': '192.0.2.99' } })).status, 401);
  // Invalid input still consumes the per-IP registration budget; no accounts are created.
  for (let i = 0; i < 30; i++) assert.equal((await api('/api/auth/register', { body: { username: 'x', password: 'short' }, headers: { 'CF-Connecting-IP': '192.0.2.45' } })).status, 400);
  assert.equal((await api('/api/auth/register', { body: { username: 'x', password: 'short' }, headers: { 'CF-Connecting-IP': '192.0.2.45' } })).status, 429);
});

test('a failed global-index write preserves the canonical message and a later retry repairs D1 without duplication', async () => {
  const a = await account('repair_a'), b = await account('repair_b');
  const chatId = await dm(a, b), socket = await connect(a, chatId);
  // Simulate a D1 batch failure while session validation remains available.
  await db.prepare('DROP TABLE message_metadata').run();
  const action = { action: 'send_message', chatId, text: 'durable during index failure', clientMsgId: 'repair-stable-id' };
  let original;
  try {
    const received = nextEvent(socket, 'new_message'); socket.send(JSON.stringify(action));
    original = (await received).message;
    assert.equal((await db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').bind(chatId).first()).n, 0);
  } finally {
    await db.prepare('CREATE TABLE message_metadata (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, client_msg_id TEXT NOT NULL)').run();
  }
  const retried = nextEvent(socket, 'new_message'); socket.send(JSON.stringify(action));
  assert.equal((await retried).message.id, original.id);
  // D1 synchronization happens after the duplicate acknowledgement.
  for (let i = 0; i < 20; i++) {
    if ((await db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').bind(chatId).first()).n === 1) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').bind(chatId).first()).n, 1);
  assert.equal((await api(`/api/chats/${chatId}/messages`, { token: a.token })).data.length, 1);
});

test('room send budget rejects flooding while duplicate acknowledgements remain available', async () => {
  const a = await account('flood_a'), b = await account('flood_b'), chatId = await dm(a, b), socket = await connect(a, chatId);
  let limited = null, firstId = null;
  for (let i = 0; i < 245; i++) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No send result')), 5000);
      function listener(event) {
        const data = JSON.parse(event.data);
        if (!['new_message', 'error'].includes(data.event)) return;
        clearTimeout(timer); socket.removeEventListener('message', listener); resolve(data);
      }
      socket.addEventListener('message', listener);
    });
    socket.send(JSON.stringify({ action: 'send_message', chatId, text: 'budget ' + i, clientMsgId: 'budget_' + i }));
    const event = await response;
    if (i === 0) firstId = event.message.id;
    if (event.event === 'error') { limited = event; break; }
  }
  assert.equal(limited?.retryable, true);
  const retry = nextEvent(socket, 'new_message'); socket.send(JSON.stringify({ action: 'send_message', chatId, text: 'budget 0', clientMsgId: 'budget_0' }));
  assert.equal((await retry).message.id, firstId);
});

test('malformed and oversized JSON is rejected before hashing a password', async () => {
  assert.equal((await api('/api/auth/login', { body: null })).status, 400);
  assert.equal((await api('/api/auth/login', { body: { username: 'nobody', password: 'x'.repeat(65000) } })).status, 413);
});
async function sent(socket, chatId, text, extra = {}) {
  const clientMsgId=extra.clientMsgId || 'daily_' + (++serial);
  // Another sender's broadcast can arrive between registering this listener
  // and our own acknowledgement. Match the stable send ID, not only the event.
  const received = nextEvent(socket, 'new_message',data=>data.message.clientMsgId===clientMsgId);
  socket.send(JSON.stringify({ action: 'send_message', chatId, text, ...extra, clientMsgId }));
  return (await received).message;
}
const change = (user, chat, message, action, body = {}) => api(`/api/chats/${chat}/messages/${message}/${action}`, { token: user.token, body });

test('message replies, edits, reactions and tombstones stay canonical across retries and permissions', async () => {
  const a = await account('daily_a'), b = await account('daily_b'), outsider = await account('daily_out');
  const chat = await dm(a,b), socket = await connect(a,chat), peer = await connect(b,chat);
  const original = await sent(socket,chat,'متن اصلی', {clientMsgId:'daily_original'});
  const reply = await sent(peer,chat,'پاسخ', {replyToId:original.id});
  assert.equal(reply.replyTo.text,'متن اصلی');
  assert.equal((await change(b,chat,original.id,'edit',{text:'دستکاری',actor:a.user.id})).status,403);
  assert.equal((await change(outsider,chat,original.id,'delete')).status,403);
  const update = nextEvent(peer,'message_changed');
  const edited = await change(a,chat,original.id,'edit',{text:'ویرایش کیک'});
  assert.equal(edited.status,200,JSON.stringify(edited));
  assert.equal((await update).message.text,'ویرایش کیک');
  assert.ok(edited.data.message.editedAt);
  assert.equal((await change(b,chat,original.id,'reaction',{emoji:'❤️'})).status,200);
  const reacted = await change(b,chat,original.id,'reaction',{emoji:'👍'});
  assert.deepEqual(reacted.data.message.reactions,[{emoji:'👍',users:[b.user.id]}]);
  assert.equal((await change(b,chat,original.id,'reaction',{emoji:'invalid'})).status,400);
  assert.equal((await change(b,chat,original.id,'delete')).status,403);
  const removed = await change(a,chat,original.id,'delete');
  assert.equal(removed.status,200); assert.equal(removed.data.message.text,'');
  assert.deepEqual(removed.data.message.reactions,[]);
  assert.equal((await change(a,chat,original.id,'edit',{text:'زنده شود'})).status,403);
  const retry = await sent(socket,chat,'متن اصلی',{clientMsgId:'daily_original'});
  assert.equal(retry.id,original.id);assert.ok(retry.deletedAt);
  const history = (await api(`/api/chats/${chat}/messages`,{token:a.token})).data;
  assert.equal(history.find(m=>m.id===original.id).text,'');
  assert.equal(history.find(m=>m.id===reply.id).replyTo.deleted,true);
  assert.equal((await api(`/api/chats/${chat}/search?q=${encodeURIComponent('کیک')}`,{token:a.token})).data.length,0);
  const preview=(await api('/api/chats',{token:a.token})).data.find(c=>c.id===chat);
  assert.equal(preview.lastMessage.id,reply.id);
});

test('Persian search normalizes variants and paginates timestamp ties without exposing other chats or hidden messages', async () => {
  const a = await account('search_a'), b = await account('search_b'), chat = await dm(a,b), socket = await connect(a,chat);
  const first=await sent(socket,chat,'كيكِ می‌روم');
  let found=await api(`/api/chats/${chat}/search?q=${encodeURIComponent('کیک')}`,{token:a.token});
  assert.equal(found.status,200,JSON.stringify(found));assert.equal(found.data[0].id,first.id);
  assert.equal((await api(`/api/chats/${chat}/search?q=${encodeURIComponent('میروم')}`,{token:a.token})).data[0].id,first.id);
  await db.batch(Array.from({length:65},(_,i)=>db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind('tied-search-'+String(i).padStart(2,'0'),chat,a.user.id,'درخت',100)));
  await db.prepare("INSERT INTO message_search SELECT id,chat_id,text FROM messages WHERE chat_id=? AND id LIKE 'tied-search-%'").bind(chat).run();
  const page=(await api(`/api/chats/${chat}/search?q=${encodeURIComponent('درخت')}`,{token:a.token})).data;
  assert.equal(page.length,50);const last=page.at(-1);
  const rest=(await api(`/api/chats/${chat}/search?q=${encodeURIComponent('درخت')}&before=${last.createdAt}:${last.id}`,{token:a.token})).data;
  assert.equal(rest.length,15);assert.equal(new Set([...page,...rest].map(m=>m.id)).size,65);
  assert.equal((await api(`/api/chats/${chat}/search?q=%25`,{token:a.token})).data.length,0);
  assert.equal((await change(a,chat,first.id,'hide')).status,200);
  assert.equal((await api(`/api/chats/${chat}/search?q=${encodeURIComponent('کیک')}`,{token:a.token})).data.length,0);
  assert.equal((await api(`/api/chats/${chat}/search?q=${encodeURIComponent('کیک')}`,{token:b.token})).data.length,1);
  const history=(await api(`/api/chats/${chat}/messages?limit=50`,{token:a.token})).data;
  assert.equal(history.length,50);assert.ok(!history.some(m=>m.id===first.id));
});

test('group owners, admins, removals, single-use invites and transfer enforce current membership', async () => {
  const a=await account('roles_a'),b=await account('roles_b'),c=await account('roles_c'),d=await account('roles_d');
  const created=await api('/api/chats',{token:a.token,body:{type:'group',title:'نقش‌ها',memberIds:[b.user.id]}}),chat=created.data.id;
  const group=(user,body)=>api(`/api/chats/${chat}/group`,{token:user.token,method:'PATCH',body});
  assert.equal((await group(b,{action:'rename',title:'غیرمجاز'})).status,403);
  assert.equal((await group(a,{action:'role',userId:b.user.id,role:'admin'})).status,200);
  assert.equal((await group(b,{action:'rename',title:'نام تازه'})).status,200);
  assert.equal((await group(b,{action:'remove',userId:a.user.id})).status,403);
  const invite=(await api(`/api/chats/${chat}/invites`,{token:b.token,body:{uses:1,hours:1}})).data;
  const joined=await Promise.all([c,d].map(user=>api(`/api/invites/${invite.token}/join`,{token:user.token,body:{}})));
  assert.equal(joined.filter(row=>row.status===200).length,1,JSON.stringify(joined));
  const winner=joined[0].status===200?c:d,live=await connect(winner,chat),removed=nextEvent(live,'chat_access_revoked');
  assert.equal((await group(b,{action:'remove',userId:winner.user.id})).status,200);await removed;
  assert.equal((await api(`/api/chats/${chat}/messages`,{token:winner.token})).status,403);
  const listed=(await api(`/api/chats/${chat}/invites`,{token:a.token})).data;
  await api(`/api/chats/${chat}/invites`,{token:a.token,method:'DELETE',body:{id:listed[0].id}});
  assert.equal((await api(`/api/invites/${invite.token}/join`,{token:winner.token,body:{}})).status,403);
  assert.equal((await api(`/api/chats/${chat}/leave`,{token:a.token,body:{}})).status,409);
  assert.equal((await group(a,{action:'transfer',userId:b.user.id})).status,200);
  assert.equal((await group(a,{action:'role',userId:b.user.id,role:'member'})).status,403);
  assert.equal((await api(`/api/chats/${chat}/leave`,{token:a.token,body:{}})).status,200);
  const details=(await api(`/api/chats/${chat}/details`,{token:b.token})).data;
  assert.equal(details.role,'owner');assert.equal(details.members.length,1);
});

test('blocking closes existing private sockets, isolates search and leaves shared groups usable', async () => {
  const a=await account('block_a'),b=await account('block_b'),chat=await dm(a,b),socket=await connect(b,chat);
  const stopped=nextEvent(socket,'chat_access_revoked');
  assert.equal((await api('/api/blocks',{token:a.token,body:{userId:b.user.id}})).status,200);await stopped;
  assert.equal((await mf.dispatchFetch(`http://localhost/ws?chatId=${chat}&token=${b.token}`,{headers:{Upgrade:'websocket'}})).status,403);
  assert.equal((await api('/api/chats',{token:b.token,body:{targetUserId:a.user.id}})).status,403);
  assert.equal((await api('/api/users/search?q=block_a',{token:b.token})).data.length,0);
  const group=(await api('/api/chats',{token:a.token,body:{type:'group',memberIds:[b.user.id]}})).data.id;
  const shared=await connect(b,group);assert.equal((await sent(shared,group,'گروه مشترک')).text,'گروه مشترک');
  await api('/api/blocks',{token:a.token,method:'DELETE',body:{userId:b.user.id}});
  assert.equal((await api('/api/chats',{token:b.token,body:{targetUserId:a.user.id}})).status,200);
});

test('profiles and password changes preserve this session while invalidating concurrent old-password sessions', async () => {
  const a=await account('profile_a'),b=await account('profile_b'),chat=await dm(a,b);
  const login=(await api('/api/auth/login',{body:{username:'profile_a',password:'testpass123'}})).data;
  const live=await connect(login,chat),revoked=nextEvent(live,'session_revoked');
  assert.equal((await api('/api/profile',{token:a.token,method:'PATCH',body:{displayName:'نام تازه',about:'درباره',avatar:'',theme:'light',fontSize:'large',notifications:false,notificationPreview:false}})).status,200);
  assert.equal((await api('/api/profile',{token:a.token})).data.displayName,'نام تازه');
  assert.equal((await api('/api/profile',{token:a.token,method:'PATCH',body:{displayName:'عکس',about:'',avatar:'data:image/svg+xml;base64,PHN2Zz4=',theme:'dark',fontSize:'normal'}})).status,400);
  assert.equal((await api('/api/profile/password',{token:a.token,body:{currentPassword:'wrong',newPassword:'new-password123'}})).status,403);
  const results=await Promise.all(['new-password123','different-password123'].map(newPassword=>api('/api/profile/password',{token:a.token,body:{currentPassword:'testpass123',newPassword}})));
  assert.equal(results.filter(row=>row.status===200).length,1,JSON.stringify(results));await revoked;
  assert.equal((await api('/api/auth/me',{token:a.token})).status,200);
  assert.equal((await api('/api/auth/me',{token:login.token})).status,401);
  assert.equal((await api('/api/auth/login',{body:{username:'profile_a',password:'testpass123'}})).status,401);
  const password=results[0].status===200?'new-password123':'different-password123';
  assert.equal((await api('/api/auth/login',{body:{username:'profile_a',password}})).status,200);
});

test('saved messages, personal hides, chat preferences and group pins respect permissions', async () => {
  const a=await account('save_a'),b=await account('save_b');
  const chat=(await api('/api/chats',{token:a.token,body:{type:'group',memberIds:[b.user.id]}})).data.id;
  const msg=await sent(await connect(a,chat),chat,'ذخیره‌کردنی');
  assert.equal((await change(b,chat,msg.id,'pin')).status,403);
  assert.equal((await change(a,chat,msg.id,'pin')).status,200);
  assert.equal((await api(`/api/chats/${chat}/details`,{token:b.token})).data.pinnedMessageId,msg.id);
  await change(b,chat,msg.id,'save');assert.equal((await api('/api/saved',{token:b.token})).data[0].text,'ذخیره‌کردنی');
  await change(a,chat,msg.id,'edit',{text:'متن تازه'});assert.equal((await api('/api/saved',{token:b.token})).data[0].text,'متن تازه');
  await api(`/api/chats/${chat}/preferences`,{token:b.token,method:'PATCH',body:{archived:true,muted:true,pinned:true}});
  const list=(await api('/api/chats',{token:b.token})).data.find(row=>row.id===chat);assert.ok(list.archived&&list.muted&&list.pinned);
  assert.equal((await api('/api/chats',{token:a.token})).data.find(row=>row.id===chat).muted,false);
  await change(b,chat,msg.id,'hide');assert.equal((await api('/api/saved',{token:b.token})).data.length,0);
  assert.equal((await api('/api/chats',{token:b.token})).data.find(row=>row.id===chat).lastMessage,null);
  await api(`/api/chats/${chat}/leave`,{token:b.token,body:{}});assert.equal((await api('/api/saved',{token:b.token})).data.length,0);
});

test('service owner claim, invitation-only registration quotas and reports are isolated from ordinary accounts', async () => {
  const admin=await account('service_owner'),other=await account('service_other');
  assert.equal((await api('/api/service/settings',{token:other.token})).status,403);
  assert.equal((await api('/api/service/claim',{token:admin.token,body:{code:'wrong'}})).status,403);
  assert.equal((await api('/api/service/claim',{token:admin.token,body:{code:adminCode}})).status,200);
  assert.equal((await api('/api/service/claim',{token:other.token,body:{code:adminCode}})).status,403);
  const invite=(await api('/api/service/invites',{token:admin.token,body:{uses:1,hours:1}})).data;
  await api('/api/service/settings',{token:admin.token,method:'PATCH',body:{registration:'invite'}});
  try {
    assert.equal((await api('/api/bootstrap')).data.registration,'invite');
    assert.equal((await api('/api/auth/register',{body:{username:'no_invite',password:'testpass123'}})).status,403);
    const attempts=await Promise.all(['invite_one','invite_two'].map(username=>api('/api/auth/register',{body:{username,password:'testpass123',inviteToken:invite.token}})));
    assert.equal(attempts.filter(row=>row.status===201).length,1,JSON.stringify(attempts));
    assert.equal((await api('/api/auth/login',{body:{username:'service_other',password:'testpass123'}})).status,200);
    const reported=await api('/api/reports',{token:other.token,body:{userId:admin.user.id,reason:'گزارش آزمایشی'}});assert.equal(reported.status,201);
    assert.equal((await api('/api/service/reports',{token:other.token})).status,403);
    const reports=(await api('/api/service/reports',{token:admin.token})).data;assert.equal(reports[0].reason,'گزارش آزمایشی');
    assert.equal((await api('/api/service/reports',{token:admin.token,method:'PATCH',body:{id:reports[0].id,status:'resolved'}})).status,200);
  } finally {await api('/api/service/settings',{token:admin.token,method:'PATCH',body:{registration:'open'}});}
});
test('durable edits and deletion override a failed D1 index in history, search, saves and reconnect snapshots',async()=>{
  const a=await account('mutation_a'),b=await account('mutation_b'),chat=await dm(a,b),socket=await connect(a,chat);
  const msg=await sent(socket,chat,'متن قبل از اختلال');await change(a,chat,msg.id,'save');
  await db.prepare("CREATE TRIGGER fail_mutation_index BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'simulated write failure'); END").run();
  try {
    const edited=await change(a,chat,msg.id,'edit',{text:'اصلاح قطعی پس از اختلال'});assert.equal(edited.status,200);
    assert.equal((await db.prepare('SELECT text FROM messages WHERE id=?').bind(msg.id).first()).text,'متن قبل از اختلال');
    assert.equal((await api('/api/saved',{token:a.token})).data[0].text,'اصلاح قطعی پس از اختلال');
    assert.equal((await api(`/api/chats/${chat}/changes`,{token:a.token,body:{ids:[msg.id]}})).data[0].text,'اصلاح قطعی پس از اختلال');
    assert.equal((await api(`/api/chats/${chat}/search?q=${encodeURIComponent('قبل از اختلال')}`,{token:a.token})).data.length,0);
    assert.equal((await change(a,chat,msg.id,'delete')).status,200);
    assert.equal((await api('/api/saved',{token:a.token})).data[0].text,'');
    assert.equal((await api(`/api/chats/${chat}/messages`,{token:a.token})).data[0].deletedAt>0,true);
  } finally {await db.prepare('DROP TRIGGER fail_mutation_index').run();}
  await sent(socket,chat,'متن قبل از اختلال',{clientMsgId:msg.clientMsgId});
  for(let i=0;i<25;i++){if((await db.prepare('SELECT text FROM messages WHERE id=?').bind(msg.id).first()).text==='')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal((await db.prepare('SELECT text FROM messages WHERE id=?').bind(msg.id).first()).text,'');
});

test('saved-message pages preserve ties and long Persian search is literal rather than a LIKE pattern',async()=>{
  const a=await account('page_a'),b=await account('page_b'),chat=await dm(a,b),socket=await connect(a,chat);
  const long='یک عبارت فارسی طولانی برای آزمودن جستجو که بیش از پنجاه بایت دارد';
  const msg=await sent(socket,chat,long);
  assert.equal((await api(`/api/chats/${chat}/search?q=${encodeURIComponent(long)}`,{token:a.token})).data[0].id,msg.id);
  await db.batch(Array.from({length:17},(_,i)=>db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind('saved-page-'+String(i).padStart(2,'0'),chat,a.user.id,'ذخیره',50)));
  await db.prepare("INSERT INTO saved_messages SELECT ?,id,chat_id,500 FROM messages WHERE id LIKE 'saved-page-%'").bind(a.user.id).run();
  const ids=[];let cursor='';
  for(let i=0;i<3;i++) {const page=(await api('/api/saved'+(cursor?'?before='+cursor:''),{token:a.token})).data;ids.push(...page.map(row=>row.id));const last=page.at(-1);cursor=last.savedAt+':'+last.id;}
  assert.equal(ids.length,17);assert.equal(new Set(ids).size,17);
});
