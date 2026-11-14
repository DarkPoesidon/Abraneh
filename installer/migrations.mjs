/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function applyMigrations(api, accountId, databaseId, payloadDir, manifest) {
  await api.query(accountId, databaseId, 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const rows = await api.query(accountId, databaseId, 'SELECT version FROM schema_migrations');
  const applied = new Set((rows[0]?.results || []).map(row => row.version));
  if (!Array.isArray(manifest.migrations) || manifest.migrations.some(name => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) throw new Error('فهرست تغییرات دیتابیس بسته معتبر نیست. نصب‌کنندهٔ رسمی را دریافت کنید.');
  if ([...applied].some(name => !manifest.migrations.includes(name))) throw new Error('دیتابیس با نسخهٔ جدیدتری به‌روزرسانی شده است. آخرین نصب‌کننده را دریافت کنید.');
  for (const name of [...manifest.migrations].sort()) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(payloadDir, 'migrations', name), 'utf8');
    // Migrations must be retry-safe: a connection can fail after an accepted query.
    await api.query(accountId, databaseId, sql);
    await api.query(accountId, databaseId, 'INSERT OR IGNORE INTO schema_migrations (version,applied_at) VALUES (?,?)', [name, Date.now()]);
  }
}
