import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CloudflareError } from './cloudflare.mjs';
import { applyMigrations } from './migrations.mjs';

export const APP_MARKER = 'wihm-cloudflare-v2';
const legacyMarker = 'wihm-cloudflare-v1';
export const isNewer = (a, b) => {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
export const validAccount = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
export const validName = name => typeof name === 'string' && /^[a-z][a-z0-9-]{2,39}$/.test(name) && !name.endsWith('-');

async function settingsFor(api, path) {
  try { return (await api.request(path)).result; }
  catch (e) {
    // Never interpret a permissions/server error as a missing Worker.
    if (e instanceof CloudflareError && e.status === 404 && e.codes.includes(10007)) return null;
    throw e;
  }
}

export async function inspect(api, accountId, name) {
  if (!validAccount(accountId) || !validName(name)) throw new Error('نام باید ۳ تا ۴۰ حرف کوچک انگلیسی، عدد یا خط تیره باشد و با حرف شروع شود.');
  const path = `/accounts/${accountId}/workers/scripts/${name}`;
  const settings = await settingsFor(api, path + '/settings');
  if (settings) {
    const binding = key => settings.bindings?.find(b => b.name === key);
    if (![APP_MARKER, legacyMarker].includes(binding('WIHM_INSTALLER')?.text) || binding('DB')?.type !== 'd1'
        || binding('CHAT_ROOM')?.type !== 'durable_object_namespace' || binding('CHAT_ROOM')?.class_name !== 'ChatRoom'
        || binding('JWT_SECRET')?.type !== 'secret_text') {
      throw new Error('برنامه‌ای با این نام از قبل وجود دارد و متعلق به این نصب‌کننده نیست. نام دیگری انتخاب کنید.');
    }
  }
  const installedVersion = settings ? settings.bindings?.find(binding => binding.name === 'WIHM_VERSION')?.text || '1.0.0' : null;
  return { accountId, name, mode: settings ? 'update' : 'new', installedVersion, settings };
}

async function uploadAssets(api, accountId, name, directory) {
  const manifest = {}, files = new Map();
  // The shipped public directory is intentionally flat; reject unexpected content.
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isFile() || !TYPES[extname(item.name)]) throw new Error('محتوای بستهٔ نصب معتبر نیست. بستهٔ رسمی را دوباره دریافت کنید.');
    const content = await readFile(join(directory, item.name));
    const hash = createHash('sha256').update(content.toString('base64') + extname(item.name).slice(1)).digest('hex').slice(0, 32);
    manifest['/' + item.name] = { hash, size: content.length };
    files.set(hash, { content, type: TYPES[extname(item.name)] });
  }
  const { result: session } = await api.request(`/accounts/${accountId}/workers/scripts/${name}/assets-upload-session`, { method: 'POST', json: { manifest } });
  if (!session?.jwt || !Array.isArray(session.buckets)) throw new Error('دریافت مجوز بارگذاری فایل‌ها کامل نشد. دوباره تلاش کنید.');
  let completion = session.buckets.length === 0 ? session.jwt : null;
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = files.get(hash);
      if (!file) throw new Error('فهرست بارگذاری فایل‌ها معتبر نیست. دوباره تلاش کنید.');
      form.append(hash, new Blob([file.content.toString('base64')], { type: file.type }), hash);
    }
    const { result } = await api.request(`/accounts/${accountId}/workers/assets/upload?base64=true`, { method: 'POST', form, token: session.jwt });
    if (result?.jwt) completion = result.jwt;
  }
  if (!completion) throw new Error('بارگذاری فایل‌ها کامل نشد. دوباره تلاش کنید.');
  return completion;
}

export async function deploy({ api, accountId, name, payloadDir, journal, progress = () => {}, fetcher = fetch, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  progress('check');
  // Revalidate immediately before mutations, including retries after a lost upload response.
  const plan = await inspect(api, accountId, name);
  const release = JSON.parse(await readFile(join(payloadDir, 'release.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(release.appVersion)) throw new Error('نسخهٔ بسته معتبر نیست. نصب‌کنندهٔ رسمی را دریافت کنید.');
  if (plan.installedVersion && isNewer(plan.installedVersion, release.appVersion)) throw new Error('نسخهٔ نصب‌شده جدیدتر از این نصب‌کننده است. آخرین بسته را دریافت کنید.');
  const root = `/accounts/${accountId}`;
  const scriptPath = `${root}/workers/scripts/${name}`;
  const [worker, schema] = await Promise.all([readFile(join(payloadDir, 'worker.mjs'), 'utf8'), readFile(join(payloadDir, 'schema.sql'), 'utf8')]);
  progress('address');
  let subdomain;
  try { subdomain = (await api.request(root + '/workers/subdomain')).result?.subdomain; }
  catch (e) { if (!(e instanceof CloudflareError && e.status === 404)) throw e; }
  if (!subdomain) {
    const result = await api.request(root + '/workers/subdomain', { method: 'PUT', json: { subdomain: `${name}-${accountId.slice(0, 8)}` } });
    subdomain = result.result?.subdomain;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(subdomain ?? '')) throw new Error('آدرس Workers فعال نشد. ورود و تأیید ایمیل حساب کلادفلر را کامل کنید و دوباره تلاش کنید.');

  progress('database');
  const databaseName = `${name}-db`;
  const bindingId = plan.settings?.bindings.find(b => b.name === 'DB')?.id;
  const databases = await api.list(root + '/d1/database');
  let database = bindingId ? databases.find(db => db.uuid === bindingId) : databases.find(db => db.name === databaseName);
  if (bindingId && !database) throw new Error('دیتابیس نصب قبلی پیدا نشد. برای حفظ اطلاعات، نصب متوقف شد.');
  const saved = await journal.get(accountId, name);
  if (!database) {
    database = (await api.request(root + '/d1/database', { method: 'POST', json: { name: databaseName } })).result;
    if (!database?.uuid) throw new Error('ساخت دیتابیس کامل نشد. دوباره تلاش کنید.');
    // Non-secret journal allows recovery if the app closes before schema initialization.
    await journal.set(accountId, name, { databaseId: database.uuid });
  } else if (!bindingId && saved?.databaseId !== database.uuid) {
    let owned = false;
    try {
      const rows = await api.query(accountId, database.uuid, 'SELECT app, worker_name FROM wihm_installation WHERE id = 1');
      owned = [APP_MARKER, legacyMarker].includes(rows[0]?.results?.[0]?.app) && rows[0]?.results?.[0]?.worker_name === name;
    } catch { /* An unrelated database must never be initialized or adopted. */ }
    if (!owned) throw new Error('دیتابیسی با این نام از قبل وجود دارد. برای دست‌نخورده ماندن آن، نام دیگری انتخاب کنید.');
  }
  progress('schema');
  await api.query(accountId, database.uuid, schema);
  await applyMigrations(api, accountId, database.uuid, payloadDir, release);
  await api.query(accountId, database.uuid, 'CREATE TABLE IF NOT EXISTS wihm_installation (id INTEGER PRIMARY KEY CHECK (id = 1), app TEXT NOT NULL, worker_name TEXT NOT NULL)');
  await api.query(accountId, database.uuid, 'INSERT OR IGNORE INTO wihm_installation (id, app, worker_name) VALUES (1, ?, ?)', [APP_MARKER, name]);
  await journal.set(accountId, name, { databaseId: database.uuid });

  progress('assets');
  const jwt = await uploadAssets(api, accountId, name, join(payloadDir, 'public'));
  progress('publish');
  const metadata = {
    main_module: 'worker.mjs', compatibility_date: '2026-01-01', compatibility_flags: ['nodejs_compat'],
    bindings: [
      { name: 'DB', type: 'd1', id: database.uuid },
      { name: 'CHAT_ROOM', type: 'durable_object_namespace', class_name: 'ChatRoom' },
      { name: 'ASSETS', type: 'assets' },
      { name: 'WIHM_INSTALLER', type: 'plain_text', text: APP_MARKER },
      { name: 'WIHM_VERSION', type: 'plain_text', text: release.appVersion },
      plan.settings ? { name: 'JWT_SECRET', type: 'inherit' } : { name: 'JWT_SECRET', type: 'secret_text', text: randomBytes(48).toString('base64url') },
    ],
    assets: { jwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
    ...(!plan.settings ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['ChatRoom'] } } : {}),
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.mjs', new Blob([worker], { type: 'application/javascript+module' }), 'worker.mjs');
  await api.request(scriptPath + '?bindings_inherit=strict', { method: 'PUT', form });
  await api.request(scriptPath + '/subdomain', { method: 'POST', json: { enabled: true, previews_enabled: false } });

  const url = `https://${name}.${subdomain}.workers.dev`;
  progress('verify', url);
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetcher(url + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const health = await response.json();
      if (response.ok && health.app === 'wihm-cloudflare' && health.database === true && health.version === release.appVersion) {
        return { url, verified: true, mode: plan.mode, version: release.appVersion };
      }
    } catch { /* DNS and Worker propagation can lag a successful deployment. */ }
    if (attempt < 11) await pause(1500);
  }
  return { url, verified: false, mode: plan.mode, version: release.appVersion };
}
