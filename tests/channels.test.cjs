const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { webcrypto, createHmac } = require('node:crypto');
const { buildSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const built = buildSync({ entryPoints: ['src/channels.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const scope = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module: scope, exports: scope.exports, require, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, URL, Headers, Response, AbortSignal, Date });
const { handleChannels, publicChannels, scheduledChannels, webhookUrl } = scope.exports;

function fixture(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT); INSERT INTO users VALUES ('owner','owner'),('reader','reader'),('admin','admin'),('stranger','stranger'); CREATE TABLE service_user_state(user_id TEXT PRIMARY KEY,disabled_at INTEGER); CREATE TABLE site_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE rate_limits(key TEXT PRIMARY KEY,window_start INTEGER,count INTEGER,expires_at INTEGER);`);
  database.exec(readFileSync('migrations/0009_channels.sql', 'utf8'));
  function statement(sql, params = []) {
    const compiled = database.prepare(sql);
    return {
      sql, params,
      bind(...values) { return statement(sql, values); },
      async first() { return compiled.get(...params) || null; },
      async all() { return { results: compiled.all(...params) }; },
      execute() { const result = compiled.run(...params); return { meta: { changes: Number(result.changes) } }; },
      async run() { return this.execute(); },
    };
  }
  const env = { JWT_SECRET: 'local-test-webhook-encryption-key-'.repeat(2), DB: { prepare: statement, async batch(statements) { database.exec('BEGIN'); try { const rows = statements.map(row => row.execute()); database.exec('COMMIT'); return rows; } catch (error) { database.exec('ROLLBACK'); throw error; } } } };
  async function api(userId, path, method = 'GET', body, token) {
    const request = new Request('https://app.test' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    try { const response = path.startsWith('/api/channel-api/') ? await publicChannels(request, env) : await handleChannels(request, env, { userId }); return { status: response.status, data: await response.json() }; }
    catch (error) { if (error.status) return { status: error.status, data: { error: error.message } }; throw error; }
  }
  const create = async (visibility = 'private', who = 'owner') => { const result = await api(who, '/api/channels', 'POST', { title: 'Test channel', visibility }); assert.equal(result.status, 201, JSON.stringify(result)); return result.data; };
  return { database, env, api, create };
}

test('private invitations isolate posts; subscribers cannot publish; only owner assigns posting admins', async t => {
  const f = fixture(t), channel = await f.create(), base = '/api/channels/' + channel.id;
  assert.equal((await f.api('reader', base)).status, 404);
  assert.equal((await f.api('reader', base + '/subscribe', 'POST', { invite: '0'.repeat(64) })).status, 404);
  assert.equal((await f.api('reader', base + '/subscribe', 'POST', { invite: channel.invite })).status, 200);
  assert.equal((await f.api('reader', base + '/posts', 'POST', { text: 'forbidden' })).status, 403);
  assert.equal((await f.api('reader', base + '/members', 'POST', { userId: 'stranger', role: 'admin' })).status, 403);
  assert.equal((await f.api('owner', base + '/members', 'POST', { userId: 'admin', role: 'admin' })).status, 200);
  const posted = await f.api('admin', base + '/posts', 'POST', { text: 'published' }); assert.equal(posted.status, 201);
  assert.equal((await f.api('admin', base + '/tokens', 'POST', { label: 'bad', scope: 'write', days: 1 })).status, 403);
  assert.equal((await f.api('reader', base + '/posts')).data.posts[0].text, 'published');
  assert.equal((await f.api('stranger', base + '/posts')).status, 404);
  await f.api('owner', base + '/members', 'POST', { userId: 'admin', role: 'subscriber' });
  assert.equal((await f.api('admin', base + '/posts', 'PATCH', { text: 'no' })).status, 403);
});

test('public catalog, cursor pages, edits and tombstones preserve channel isolation', async t => {
  const f = fixture(t), channel = await f.create('public'), base = '/api/channels/' + channel.id;
  const other = await f.create();
  const catalog = await f.api('reader', '/api/channels?discover=1');
  assert.deepEqual(catalog.data.channels.map(row => row.id), [channel.id]);
  const now = Date.now();
  const insert = f.database.prepare('INSERT INTO channel_posts(id,channel_id,author_id,text,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,0)');
  for (let i = 0; i < 35; i++) insert.run('p-' + String(i).padStart(3, '0'), channel.id, 'owner', 'post-' + i, now + i, now + i);
  insert.run('other-post', other.id, 'owner', 'secret', now, now);
  const page = await f.api('reader', base + '/posts'); assert.equal(page.data.posts.length, 30); assert.ok(page.data.next);
  const older = await f.api('reader', base + '/posts?before=' + page.data.next); assert.equal(older.data.posts.length, 5);
  assert.ok(![...page.data.posts, ...older.data.posts].some(post => post.id === 'other-post'));
  assert.equal((await f.api('owner', base + '/posts/p-000', 'PATCH', { text: 'edited' })).data.text, 'edited');
  const deleted = await f.api('owner', base + '/posts/p-000', 'DELETE'); assert.equal(deleted.data.text, ''); assert.ok(deleted.data.deletedAt);
  assert.equal((await f.api('owner', base + '/posts/p-000', 'PATCH', { text: 'restore' })).status, 404);
});

test('random bot tokens are hashed, scoped, expiring, revocable and unusable for other channels', async t => {
  const f = fixture(t), channel = await f.create(), other = await f.create(), base = '/api/channels/' + channel.id;
  const read = (await f.api('owner', base + '/tokens', 'POST', { label: 'reader', scope: 'read', days: 30 })).data;
  assert.match(read.token, /^wihm_bot_[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(f.database.prepare('SELECT * FROM channel_tokens').all()).includes(read.token));
  const endpoint = '/api/channel-api/' + channel.id + '/posts';
  assert.equal((await f.api(null, endpoint, 'GET', undefined, read.token)).status, 200);
  assert.equal((await f.api(null, endpoint, 'POST', { text: 'bad' }, read.token)).status, 403);
  assert.equal((await f.api(null, '/api/channel-api/' + other.id + '/posts', 'GET', undefined, read.token)).status, 401);
  const write = (await f.api('owner', base + '/tokens', 'POST', { label: 'writer', scope: 'write', days: 1 })).data;
  assert.equal((await f.api(null, endpoint, 'POST', { text: 'bot post' }, write.token)).status, 201);
  assert.equal((await f.api(null, endpoint, 'GET', undefined, write.token)).status, 403);
  await f.api('owner', base + '/tokens/' + read.id, 'DELETE');
  assert.equal((await f.api(null, endpoint, 'GET', undefined, read.token)).status, 401);
  f.database.prepare('UPDATE channel_tokens SET expires_at=0 WHERE id=?').run(write.id);
  assert.equal((await f.api(null, endpoint, 'POST', { text: 'expired' }, write.token)).status, 401);
  assert.equal((await f.api(null, endpoint, 'GET')).status, 401);
});

test('webhook guard allows only HTTPS workers or administrator peers and refuses userinfo, IPs, redirects and arbitrary hosts', async t => {
  const f = fixture(t);
  for (const url of ['http://sink.account.workers.dev/events', 'https://127.0.0.1/events', 'https://localhost/events', 'https://private.attacker.org/events', 'https://a:b@sink.account.workers.dev/events', 'https://sink.account.workers.dev:8443/events', 'https://sink.account.workers.dev/events?token=secret']) {
    await assert.rejects(webhookUrl(f.env, url));
  }
  assert.equal(await webhookUrl(f.env, 'https://sink.account.workers.dev/events'), 'https://sink.account.workers.dev/events');
  f.database.prepare("INSERT INTO site_settings VALUES ('discovery_peers',?)").run(JSON.stringify(['hooks.allowed.org']));
  assert.equal(await webhookUrl(f.env, 'https://hooks.allowed.org/events'), 'https://hooks.allowed.org/events');
});

test('webhooks seal secrets, atomically enqueue stable signed events and stop after five failed deliveries', async t => {
  const f = fixture(t), channel = await f.create(), base = '/api/channels/' + channel.id;
  const configured = await f.api('owner', base + '/webhook', 'POST', { url: 'https://sink.account.workers.dev/events' }); assert.equal(configured.status, 201);
  const secret = configured.data.secret, stored = f.database.prepare('SELECT secret_cipher FROM channel_webhooks').get().secret_cipher;
  assert.ok(!stored.includes(secret));
  assert.equal((await f.api('owner', base + '/posts', 'POST', { text: 'event text' })).status, 201);
  const event = f.database.prepare('SELECT * FROM channel_outbox').get(), deliveries = [];
  let now = Date.now() + 1;
  const fail = async (url, options) => { deliveries.push({ url, options }); return new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }); };
  for (let i = 0; i < 5; i++) {
    await scheduledChannels(f.env, fail, now);
    const row = f.database.prepare('SELECT * FROM channel_outbox').get(); assert.equal(row.attempts, i + 1); now = row.next_at + 1;
  }
  await scheduledChannels(f.env, fail, now); assert.equal(deliveries.length, 5);
  for (const { options } of deliveries) {
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers['X-WIHM-Event'], event.id); assert.equal(options.body, event.payload);
    const signature = createHmac('sha256', secret).update(options.headers['X-WIHM-Timestamp'] + '.' + event.payload).digest('hex');
    assert.equal(options.headers['X-WIHM-Signature'], 'sha256=' + signature);
    assert.ok(!JSON.stringify(options).includes(secret));
  }
  const info = await f.api('owner', base + '/webhook'); assert.equal(info.data.outbox[0].attempts, 5); assert.ok(!JSON.stringify(info).includes(secret));
  await f.api('owner', base + '/webhook', 'DELETE'); assert.equal(f.database.prepare('SELECT count(*) AS n FROM channel_outbox').get().n, 0);
});

test('successful webhook deliveries delete jobs and full outboxes refuse posts without losing existing data', async t => {
  const f = fixture(t), channel = await f.create(), base = '/api/channels/' + channel.id;
  const hook = (await f.api('owner', base + '/webhook', 'POST', { url: 'https://sink.account.workers.dev/events' })).data;
  await f.api('owner', base + '/posts', 'POST', { text: 'first' });
  await scheduledChannels(f.env, async () => new Response(null, { status: 204 }), Date.now() + 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM channel_outbox').get().n, 0);
  const insert = f.database.prepare('INSERT INTO channel_outbox(id,webhook_id,payload,next_at) VALUES (?,?,?,?)');
  for (let i = 0; i < 100; i++) insert.run('full-' + i, hook.id, '{}', Date.now());
  assert.equal((await f.api('owner', base + '/posts', 'POST', { text: 'must not lose' })).status, 409);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM channel_posts').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM channel_outbox').get().n, 100);
});

test('a losing edit cannot enqueue a webhook for another mutation with the same timestamp', async t => {
  const f = fixture(t), channel = await f.create(), base = '/api/channels/' + channel.id;
  await f.api('owner', base + '/webhook', 'POST', { url: 'https://sink.account.workers.dev/events' });
  const posted = await f.api('owner', base + '/posts', 'POST', { text: 'original' });
  f.database.prepare('DELETE FROM channel_outbox').run();
  const batch = f.env.DB.batch;
  f.env.DB.batch = async statements => {
    if (statements[0].sql.startsWith('UPDATE channel_posts')) {
      const sameTimestamp = statements[0].params[1];
      f.database.prepare("UPDATE channel_posts SET text='winning edit',updated_at=?,event_id='other-mutation' WHERE id=?").run(sameTimestamp, posted.data.id);
    }
    return batch(statements);
  };
  assert.equal((await f.api('owner', base + '/posts/' + posted.data.id, 'PATCH', { text: 'losing edit' })).status, 409);
  assert.equal(f.database.prepare('SELECT text FROM channel_posts WHERE id=?').get(posted.data.id).text, 'winning edit');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM channel_outbox').get().n, 0);
});
