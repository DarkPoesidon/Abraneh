const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHmac, randomBytes } = require('node:crypto');
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

let mf, unconfigured, db;
const secret = randomBytes(32).toString('hex');
const sockets = [];
const accounts = {};
let serial = 0;

before(async () => {
  const result = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  const options = { name: 'test-worker', modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'test-db' }, durableObjects: { CHAT_ROOM: { className: 'ChatRoom', useSQLite: true } } };
  mf = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { JWT_SECRET: secret } }));
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

async function api(path, { body, token, runtime = mf } = {}) {
  const response = await runtime.dispatchFetch('http://localhost' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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

function nextEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Timed out waiting for ' + event)); }, 5000);
    function listener(message) {
      const data = JSON.parse(message.data);
      if (data.event !== event) return;
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
  assert.equal((await api(`/api/chats/${id}/members`, { token: b.token, body: { userIds: [c.user.id, b.user.id] } })).status, 200);
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
