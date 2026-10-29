import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

// Ephemeral local data only. No account or resource from a real deployment is used.
export async function createNavigationFixture({bindings={},serviceBindings={},outboundService}={}) {
  const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', write: false, platform:'neutral', mainFields:['browser','module','main'], external: ['cloudflare:workers'] });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'navigation-qa', modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { JWT_SECRET: randomBytes(48).toString('hex'), ADMIN_SETUP_TOKEN: 'local-fixture-owner-code', ...bindings },
    serviceBindings,
    ...(outboundService?{outboundService}:{}),
    d1Databases: { DB: 'navigation-qa-db' }, durableObjects: { CHAT_ROOM: { className: 'ChatRoom', useSQLite: true } },
    assets: { directory: resolve('public'), binding: 'ASSETS', routerConfig: { has_user_worker: true } },
  }));
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of (await readFile('schema.sql', 'utf8')).replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
    const origin = (await mf.ready).origin;
    async function account(username, displayName) {
      const response = await mf.dispatchFetch(origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName, password: 'fixture-only-pass123' }) });
      const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); return data;
    }
    const owner = await account('nila', 'نیلوفر'), peer = await account('sara', 'سارا احمدی'), now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO chats VALUES ('design-team','group','تیم طراحی',?,?)").bind(now - 86400000, now),
      db.prepare("INSERT INTO chat_members(chat_id,user_id,joined_at) VALUES ('design-team',?,?),('design-team',?,?)").bind(owner.user.id, now - 86400000, peer.user.id, now - 86400000),
      db.prepare("INSERT INTO group_roles VALUES ('design-team',?,'owner')").bind(owner.user.id),
    ]);
    const sample = [['گفتگوها و تنظیمات را یک‌جا مرتب کنیم؟', peer.user.id], ['آره، پنل هم جمع بشه تا برای گفتگو فضای بیشتری داشته باشیم.', owner.user.id], ['آیکون‌ها واضح باشند و روی گوشی راحت بشه لمسشون کرد.', peer.user.id], ['نسخهٔ تازهٔ طرح را اینجا با هم بررسی می‌کنیم.', owner.user.id]];
    for (let i = 0; i < sample.length; i++) await db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind('design-message-' + i, 'design-team', sample[i][1], sample[i][0], now - 600000 + i * 60000).run();
    const names = ['امیر حسینی', 'سارا احمدی', 'گروه خانواده', 'کیان', 'یادداشت‌های سفر', 'مریم رضایی', 'گروه کتاب‌خوانی', 'رضا'];
    for (let i = 0; i < names.length; i++) {
      const user = 'fixture-person-' + i, chat = 'fixture-chat-' + i;
      await db.batch([
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').bind(user, 'person_' + i, 'fixture-hash', 'fixture-salt', names[i], now),
        db.prepare("INSERT INTO chats VALUES (?,'dm',NULL,?,?)").bind(chat, now, now - (i + 1) * 3600000),
        db.prepare('INSERT INTO chat_members(chat_id,user_id,joined_at) VALUES (?,?,?),(?,?,?)').bind(chat, owner.user.id, now, chat, user, now),
        db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind('fixture-preview-' + i, chat, user, ['فردا ساعت ده هماهنگ کنیم؟', 'ممنون، دریافت شد.', 'عکس‌های سفر را بعداً می‌فرستم.'][i % 3], now - (i + 1) * 3600000),
      ]);
    }
    return { mf, origin, owner, peer, close: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
