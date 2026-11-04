const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { createHmac, randomBytes } = require('node:crypto');
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

test('1.0 storage and legacy JWT upgrade in place; migrations are replay-safe and existing duplicate history is preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wihm-upgrade-'));
  const secret = randomBytes(48).toString('hex');
  // A minimal pre-upgrade runtime uses exactly the old SQLite room layout.
  const legacy = `import { DurableObject } from 'cloudflare:workers';
    export class ChatRoom extends DurableObject {
      constructor(ctx,env) { super(ctx,env); this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,sender_name TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,client_msg_id TEXT)'); }
      async fetch() {
        this.ctx.storage.sql.exec("INSERT INTO messages VALUES ('old-a','legacy-user','قدیمی','old body',1000,'old-client-id'),('old-b','legacy-user','قدیمی','old body',1000,'old-client-id')");
        return new Response('seeded');
      }
    }
    export default { fetch(request,env) { return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('legacy-room')).fetch(request); } };`;
  const base = {
    name: 'upgrade-test', modules: true, compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { JWT_SECRET: secret }, d1Databases: { DB: 'upgrade-db' }, d1Persist: join(directory, 'd1'),
    durableObjects: { CHAT_ROOM: { className: 'ChatRoom', useSQLite: true } }, durableObjectsPersist: join(directory, 'do'),
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ ...base, script: legacy }));
  let socket;
  try {
    let db = await mf.getD1Database('DB');
    const initial = readFileSync('schema.sql', 'utf8').split('CREATE TABLE IF NOT EXISTS user_sessions')[0];
    for (const statement of initial.replace(/^--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean)) await db.prepare(statement).run();
    await db.batch([
      db.prepare("INSERT INTO users VALUES ('legacy-user','legacy','hash','salt','قدیمی',1)"),
      db.prepare("INSERT INTO chats VALUES ('legacy-room','dm',NULL,1,1000)"),
      db.prepare("INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES ('legacy-room','legacy-user',1)"),
      db.prepare("INSERT INTO messages VALUES ('old-a','legacy-room','legacy-user','old body',1000),('old-b','legacy-room','legacy-user','old body',1000)"),
      db.prepare("INSERT INTO users VALUES ('a-member','member','hash','salt','عضو',1)"),
      db.prepare("INSERT INTO chats VALUES ('legacy-group','group','قدیمی',1,1)"),
      db.prepare("INSERT INTO chat_members(chat_id,user_id,joined_at) VALUES ('legacy-group','legacy-user',1),('legacy-group','a-member',1)"),
    ]);
    assert.equal((await mf.dispatchFetch('http://localhost/seed')).status, 200);
    const { applyMigrations } = await import('../installer/migrations.mjs');
    const api = { async query(_account, _database, sql, params = []) {
      const results = [];
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) results.push(await db.prepare(statement).bind(...params).all());
      return results;
    } };
    const manifest = { migrations: ['0001_reliable_delivery.sql','0002_daily_use.sql','0003_updates_telegram.sql','0004_service_discovery.sql','0005_service_backup.sql','0006_advanced_security.sql','0007_secure_federation.sql','0009_channels.sql','0010_broadcast_channels.sql','0011_chat_deletions.sql','0012_chat_photos_remote_channels.sql','0013_secure_device_lists.sql','0014_password_resets.sql'] };
    const payload = resolve('.');
    await applyMigrations(api, 'account', 'same-database', payload, manifest);
    await applyMigrations(api, 'account', 'same-database', payload, manifest);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM schema_migrations').first()).n, 13);
    assert.equal((await db.prepare("SELECT user_id FROM group_roles WHERE chat_id='legacy-group' AND role='owner'").first()).user_id,'legacy-user');
    // Replaying an upgrade must not take ownership back after a real transfer.
    await db.batch([db.prepare("UPDATE group_roles SET role='member' WHERE chat_id='legacy-group'"),db.prepare("INSERT INTO group_roles VALUES ('legacy-group','a-member','owner')")]);
    await applyMigrations(api, 'account', 'same-database', payload, manifest);
    for(const statement of readFileSync('migrations/0002_daily_use.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
    assert.equal((await db.prepare("SELECT user_id FROM group_roles WHERE chat_id='legacy-group' AND role='owner'").first()).user_id,'a-member');
    const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform:'neutral', mainFields:['browser','module','main'], external: ['cloudflare:workers'] });
    await mf.setOptions(convertV4MiniflareOptions({ ...base, script: compiled.outputFiles[0].text }));
    db = await mf.getD1Database('DB');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ userId: 'legacy-user', username: 'legacy', displayName: 'قدیمی', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = header + '.' + claims + '.' + createHmac('sha256', secret).update(header + '.' + claims).digest('base64url');
    const health = await (await mf.dispatchFetch('http://localhost/api/health')).json();
    assert.deepEqual(health, { app: 'wihm-cloudflare', version: '1.7.20', database: true });
    const history = await (await mf.dispatchFetch('http://localhost/api/chats/legacy-room/messages', { headers: { Authorization: 'Bearer ' + token } })).json();
    assert.deepEqual(history.map(message => message.id), ['old-a', 'old-b']);
    const response = await mf.dispatchFetch('http://localhost/ws?chatId=legacy-room&token=' + token, { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 101); socket = response.webSocket; socket.accept();
    const acknowledged = new Promise((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error('Legacy retry not acknowledged')), 5000);
      socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.event === 'new_message') { clearTimeout(timer); resolveEvent(data.message); } });
    });
    socket.send(JSON.stringify({ action: 'send_message', chatId: 'legacy-room', text: 'old body', clientMsgId: 'old-client-id' }));
    assert.equal((await acknowledged).id, 'old-a');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM messages').first()).n, 2);
    assert.equal((await db.prepare('SELECT display_name FROM users WHERE id = ?').bind('legacy-user').first()).display_name, 'قدیمی');
  } finally {
    socket?.close(); await mf.dispose();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
