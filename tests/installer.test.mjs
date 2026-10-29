import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Cloudflare, CloudflareError } from '../installer/cloudflare.mjs';
import { deploy, uploadAssets, APP_MARKER } from '../installer/deploy.mjs';
import { createJournal } from '../installer/journal.mjs';
import { startServer } from '../installer/server.mjs';

const accountId = 'a'.repeat(32), token = 'test_token_'.repeat(5), name = 'family-chat';
const ok = result => Response.json({ success: true, result });
const failure = (status, code) => Response.json({ success: false, errors: [{ code, message: 'Never expose provider text: ' + token }] }, { status });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wihm-installer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Exercise the shipped asset tree, including the font directory, in every deployment.
  await cp(new URL('../public/', import.meta.url),join(directory,'public'),{recursive:true});
  await writeFile(join(directory, 'worker.mjs'), 'export default {fetch(){return new Response("ok")}}');
  await writeFile(join(directory, 'schema.sql'), await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await writeFile(join(directory, 'release.json'), JSON.stringify({ appVersion: '1.2.3', migrations: [] }));
  return directory;
}
function mockCloudflare() {
  const state = { calls: [], db: null, settings: null, metadata: [], subdomain: 'my-account', marker: null, failOnce: null, applyThenFail: false, noUploads: false, applied: new Set() };
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.replace('/client/v4', ''), method = options.method;
    state.calls.push({ path, method, options });
    if (state.failOnce === path) { state.failOnce = null; return failure(503, 10000); }
    if (path.endsWith('/settings')) return state.settings ? ok(state.settings) : failure(404, 10007);
    if (path === '/accounts') return ok([{ id: accountId, name: 'حساب آزمایشی' }]);
    if (path.endsWith('/workers/subdomain')) {
      if (method === 'PUT') state.subdomain = JSON.parse(options.body).subdomain;
      return state.subdomain ? ok({ subdomain: state.subdomain }) : failure(404, 10007);
    }
    if (path.endsWith('/d1/database')) {
      if (method === 'POST') { assert.equal(state.db, null); state.db = { uuid: '12345678-1234-1234-1234-123456789abc', name: name + '-db' }; return ok(state.db); }
      return ok(state.db ? [state.db] : []);
    }
    if (path.endsWith('/query')) {
      const { sql, params } = JSON.parse(options.body);
      if (sql === 'SELECT version FROM schema_migrations') return ok([{ success: true, results: [...state.applied].map(version => ({ version })) }]);
      if (sql.startsWith('INSERT OR IGNORE INTO schema_migrations')) state.applied.add(params[0]);
      if (sql.startsWith('INSERT OR IGNORE INTO wihm_installation')) state.marker = { app: params[0], worker_name: params[1] };
      if (sql.startsWith('SELECT app')) {
        if (!state.marker) return failure(400, 7500);
        return ok([{ success: true, results: [state.marker] }]);
      }
      return ok([{ success: true, results: [] }]);
    }
    if (path.endsWith('/assets-upload-session')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      state.manifest = JSON.parse(options.body).manifest;
      return ok({ jwt: 'asset-upload-token', buckets: state.noUploads ? [] : [[...new Set(Object.values(state.manifest).map(item => item.hash))]] });
    }
    if (path.endsWith('/assets/upload')) {
      assert.equal(options.headers.Authorization, 'Bearer asset-upload-token');
      for (const [hash, file] of options.body) {
        const content = Buffer.from(await file.text(), 'base64');
        assert.equal(Object.values(state.manifest).find(item => item.hash === hash).size, content.length);
      }
      return ok({ jwt: 'asset-completion-token' });
    }
    if (path.endsWith('/scripts/' + name)) {
      const metadata = JSON.parse(await options.body.get('metadata').text());
      assert.ok(['asset-completion-token', 'asset-upload-token'].includes(metadata.assets.jwt));
      assert.equal(metadata.bindings.find(b => b.name === 'DB').id, state.db.uuid);
      assert.ok((await options.body.get('worker.mjs').text()).includes('export default'));
      assert.equal(new URL(url).searchParams.get('bindings_inherit'), 'strict');
      state.metadata.push(metadata);
      state.settings = { bindings: metadata.bindings.map(binding => binding.type === 'inherit' ? { name: binding.name, type: 'secret_text' } : binding.type === 'secret_text' ? { name: binding.name, type: binding.type } : binding) };
      if (state.applyThenFail) { state.applyThenFail = false; throw new Error('connection lost after successful publication'); }
      return ok({ id: name });
    }
    if (path.endsWith('/scripts/' + name + '/subdomain')) return ok({ enabled: true });
    throw new Error('Unexpected mock request: ' + method + ' ' + path);
  };
  return { state, api: new Cloudflare(token, fetcher) };
}
const health = async () => Response.json({ app: 'wihm-cloudflare', version: '1.2.3', database: true });

test('deployment uses multipart assets, a SQLite migration, and a private secret; journal stores identifiers only', async t => {
  const payloadDir = await fixture(t), { api, state } = mockCloudflare();
  const journal = createJournal(join(payloadDir, 'journal')), phases = [];
  const result = await deploy({ api, accountId, name, payloadDir, journal, fetcher: health, progress: phase => phases.push(phase) });
  assert.equal(result.verified, true);
  assert.equal(result.url, 'https://family-chat.my-account.workers.dev');
  assert.ok(state.manifest['/fonts/Vazir-Variable.woff2']);
  assert.ok(!Object.keys(state.manifest).some(path=>path.includes('\\')));
  assert.deepEqual(phases, ['check', 'address', 'database', 'schema', 'assets', 'publish', 'verify']);
  assert.deepEqual(state.metadata[0].migrations, { new_tag: 'v1', new_sqlite_classes: ['ChatRoom'] });
  const secret = state.metadata[0].bindings.find(b => b.name === 'JWT_SECRET');
  assert.equal(secret.type, 'secret_text'); assert.ok(secret.text.length >= 64);
  assert.equal(state.marker.app, APP_MARKER);
  const saved = await readFile(join(payloadDir, 'journal', `${accountId}-${name}.json`), 'utf8');
  assert.ok(!saved.includes(token)); assert.ok(!saved.includes(secret.text));
  for (const name of ['ADMIN_SETUP_TOKEN','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY']) {
    const binding=state.metadata[0].bindings.find(row=>row.name===name);
    assert.equal(binding.type,'secret_text'); assert.ok(binding.text); assert.ok(!saved.includes(binding.text));
  }
  assert.equal(result.adminCode,state.metadata[0].bindings.find(row=>row.name==='ADMIN_SETUP_TOKEN').text);
  assert.equal(JSON.parse(saved).databaseId, state.db.uuid);
});

test('nested paths preserve duplicate asset URLs and reject unsupported content before uploading',async t=>{
  const payloadDir=await fixture(t),directory=join(payloadDir,'public');
  await mkdir(join(directory,'assets','nested'),{recursive:true});
  await cp(join(directory,'fonts','Vazir-Variable.woff2'),join(directory,'assets','nested','copy.woff2'));
  const {api,state}=mockCloudflare();
  assert.equal(await uploadAssets(api,accountId,name,directory),'asset-completion-token');
  assert.deepEqual(state.manifest['/assets/nested/copy.woff2'],state.manifest['/fonts/Vazir-Variable.woff2']);
  const previous=state.calls.length;
  await writeFile(join(directory,'assets','nested','unsupported.exe'),'not an executable');
  await assert.rejects(uploadAssets(api,accountId,name,directory),/محتوای بستهٔ نصب معتبر نیست/);
  assert.equal(state.calls.length,previous);
});

test('retry after accepted upload with lost response reuses database and inherits JWT without a new migration', async t => {
  const payloadDir = await fixture(t), { api, state } = mockCloudflare(), journal = createJournal(join(payloadDir, 'journal'));
  state.applyThenFail = true;
  await assert.rejects(deploy({ api, accountId, name, payloadDir, journal, fetcher: health }), /ارتباط/);
  state.noUploads = true;
  const result = await deploy({ api, accountId, name, payloadDir, journal, fetcher: health });
  assert.equal(result.mode, 'update');
  assert.equal(state.calls.filter(c => c.path.endsWith('/d1/database') && c.method === 'POST').length, 1);
  assert.deepEqual(state.metadata[1].bindings.find(b => b.name === 'JWT_SECRET'), { name: 'JWT_SECRET', type: 'inherit' });
  for(const name of ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY']) assert.deepEqual(state.metadata[1].bindings.find(b=>b.name===name),{name,type:'inherit'});
  assert.equal(result.adminCode,state.metadata[1].bindings.find(b=>b.name==='ADMIN_SETUP_TOKEN').text);
  assert.notEqual(result.adminCode,state.metadata[0].bindings.find(b=>b.name==='ADMIN_SETUP_TOKEN').text);
  assert.equal(state.metadata[1].migrations, undefined);
});

test('failed schema initialization resumes from a non-secret journal after process restart', async t => {
  const payloadDir = await fixture(t), { api, state } = mockCloudflare(), journalPath = join(payloadDir, 'journal');
  state.failOnce = `/accounts/${accountId}/d1/database/12345678-1234-1234-1234-123456789abc/query`;
  await assert.rejects(deploy({ api, accountId, name, payloadDir, journal: createJournal(journalPath), fetcher: health }));
  assert.equal(state.metadata.length, 0);
  const result = await deploy({ api, accountId, name, payloadDir, journal: createJournal(journalPath), fetcher: health });
  assert.equal(result.verified, true);
  assert.equal(state.calls.filter(c => c.path.endsWith('/d1/database') && c.method === 'POST').length, 1);
});

test('interrupted asset upload resumes with the existing database after restarting the installer', async t => {
  const payloadDir = await fixture(t), { api, state } = mockCloudflare(), journalPath = join(payloadDir, 'journal');
  state.failOnce = `/accounts/${accountId}/workers/scripts/${name}/assets-upload-session`;
  await assert.rejects(deploy({ api, accountId, name, payloadDir, journal: createJournal(journalPath), fetcher: health }));
  assert.ok(state.db);
  assert.equal(state.metadata.length, 0);
  const databaseId = state.db.uuid;
  const result = await deploy({ api, accountId, name, payloadDir, journal: createJournal(journalPath), fetcher: health });
  assert.equal(result.verified, true);
  assert.equal(state.db.uuid, databaseId);
  assert.equal(state.calls.filter(c => c.path.endsWith('/d1/database') && c.method === 'POST').length, 1);
  assert.ok(state.manifest['/fonts/Vazir-Variable.woff2']);
});

test('refuses unrelated Workers, databases, missing prior database, and API failures without overwriting resources', async t => {
  const payloadDir = await fixture(t);
  for (const variant of ['worker', 'database', 'missing-db', 'permissions']) {
    const { api, state } = mockCloudflare();
    if (variant === 'worker') state.settings = { bindings: [] };
    if (variant === 'database') state.db = { uuid: 'other-db', name: name + '-db' };
    if (variant === 'missing-db') state.settings = { bindings: [{ name: 'WIHM_INSTALLER', text: APP_MARKER }, { name: 'DB', type: 'd1', id: 'missing' }, { name: 'JWT_SECRET', type: 'secret_text' }, { name: 'CHAT_ROOM', type: 'durable_object_namespace', class_name: 'ChatRoom' }] };
    if (variant === 'permissions') state.failOnce = `/accounts/${accountId}/workers/scripts/${name}/settings`;
    await assert.rejects(deploy({ api, accountId, name, payloadDir, journal: createJournal(join(payloadDir, variant)), fetcher: health }));
    assert.equal(state.metadata.length, 0);
    assert.equal(state.calls.filter(c => c.path.endsWith('/d1/database') && c.method === 'POST').length, 0);
  }
});

test('creates first-use workers.dev address and distinguishes publication from reachable deployment', async t => {
  const payloadDir = await fixture(t), { api, state } = mockCloudflare(); state.subdomain = null;
  let attempts = 0;
  const result = await deploy({ api, accountId, name, payloadDir, journal: createJournal(join(payloadDir, 'journal')), fetcher: async () => { attempts++; throw new Error('DNS not propagated'); }, pause: async () => {} });
  assert.equal(attempts, 12); assert.equal(result.verified, false);
  assert.equal(result.url, `https://${name}.${name}-${accountId.slice(0, 8)}.workers.dev`);
});

test('API client paginates accounts and does not expose echoed provider secrets', async () => {
  let calls = 0;
  const api = new Cloudflare(token, async () => { calls++; return Response.json({ success: true, result: [{ id: calls }], result_info: { total_pages: 2 } }); });
  assert.deepEqual(await api.list('/accounts'), [{ id: 1 }, { id: 2 }]);
  const denied = new Cloudflare(token, async () => failure(403, 10000));
  await assert.rejects(denied.request('/accounts'), e => e instanceof CloudflareError && !e.message.includes(token) && e.message.includes('403'));
});

test('loopback wizard rejects foreign origins, untrusted Host, absent session, bad JSON and overlapping installs', async t => {
  const uiDir = join(await fixture(t), 'ui'); await mkdir(uiDir); await writeFile(join(uiDir, 'index.html'), '<html>installer</html>');
  const { api } = mockCloudflare(); let releaseDeploy;
  const app = await startServer({ uiDir, payloadDir: '', journal: {}, makeApi: () => api, runDeploy: () => new Promise(resolve => { releaseDeploy = resolve; }) });
  t.after(() => app.close());
  const headers = { Authorization: 'Bearer ' + app.session, Origin: app.origin, 'Content-Type': 'application/json' };
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal((await fetch(app.origin + '/api/status')).status, 401);
  assert.equal((await fetch(app.origin + '/api/status', { headers: { ...headers, Origin: 'https://malicious.example' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    // fetch normalizes Host; use the HTTP client to actually test DNS-rebinding defense.
    const request = httpRequest(app.origin + '/api/status', { headers: { ...headers, Host: 'malicious.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(app.origin + '/api/start', { method: 'POST', headers, body: '{' })).status, 400);
  const connect = await fetch(app.origin + '/api/connect', { method: 'POST', headers, body: JSON.stringify({ token }) });
  assert.equal(connect.status, 200); assert.ok(!(await connect.text()).includes(token));
  const plan = await fetch(app.origin + '/api/plan', { method: 'POST', headers, body: JSON.stringify({ name, accountId }) });
  assert.equal(plan.status, 200);
  assert.deepEqual(await plan.json(), { mode: 'new', name, installedVersion: null, targetVersion: 'development' });
  const request = () => fetch(app.origin + '/api/start', { method: 'POST', headers, body: JSON.stringify({ name, accountId }) });
  assert.equal((await request()).status, 202); assert.equal((await request()).status, 409);
  const status = await (await fetch(app.origin + '/api/status', { headers })).json();
  assert.equal(status.state, 'running'); assert.equal(status.connected, true); assert.ok(!JSON.stringify(status).includes(token));
  releaseDeploy({ url: 'https://example.account.workers.dev', verified: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await (await fetch(app.origin + '/api/status', { headers })).json()).state, 'done');
  const page = await fetch(app.origin); assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal((await fetch(app.origin + '/.dev.vars')).status, 404);
});

test('1.0 installer-managed app upgrades its marker and version while retaining DB, JWT and migration history', async t => {
  const payloadDir = await fixture(t), { api, state } = mockCloudflare();
  await mkdir(join(payloadDir, 'migrations'));
  const migration = '0001_reliable_delivery.sql', daily = '0002_daily_use.sql';
  await writeFile(join(payloadDir, 'migrations', daily), await readFile(new URL('../migrations/' + daily, import.meta.url), 'utf8'));
  await writeFile(join(payloadDir, 'migrations', migration), await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
  await writeFile(join(payloadDir, 'release.json'), JSON.stringify({ appVersion: '1.2.3', migrations: [migration,daily] }));
  state.db = { uuid: 'existing-database', name: name + '-db' };
  state.settings = { bindings: [
    { name: 'WIHM_INSTALLER', type: 'plain_text', text: 'wihm-cloudflare-v1' },
    { name: 'DB', type: 'd1', id: 'existing-database' },
    { name: 'JWT_SECRET', type: 'secret_text' },
    { name: 'CHAT_ROOM', type: 'durable_object_namespace', class_name: 'ChatRoom' },
  ] };
  const journal = createJournal(join(payloadDir, 'journal'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deploy({ api, accountId, name, payloadDir, journal, fetcher: health });
    assert.equal(result.mode, 'update'); assert.equal(result.version, '1.2.3');
  }
  assert.ok(state.applied.has(migration));
  assert.equal(state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/d1/database')).length, 0);
  assert.equal(state.calls.filter(call => call.options.body && typeof call.options.body === 'string' && JSON.parse(call.options.body).sql?.startsWith('INSERT OR IGNORE INTO schema_migrations')).length, 2);
  for (const metadata of state.metadata) {
    assert.deepEqual(metadata.bindings.find(binding => binding.name === 'JWT_SECRET'), { name: 'JWT_SECRET', type: 'inherit' });
    assert.equal(metadata.bindings.find(binding => binding.name === 'WIHM_INSTALLER').text, APP_MARKER);
    assert.equal(metadata.bindings.find(binding => binding.name === 'WIHM_VERSION').text, '1.2.3');
    assert.equal(metadata.migrations, undefined);
  }
  state.settings.bindings.find(binding => binding.name === 'WIHM_VERSION').text = '9.0.0';
  const before = state.calls.length;
  await assert.rejects(deploy({ api, accountId, name, payloadDir, journal, fetcher: health }), /جدیدتر/);
  assert.ok(state.calls.slice(before).every(call => call.method === 'GET'));
});
test('1.1 deployment applies only the daily-use migration and creates push keys without rotating JWT',async t=>{
  const payloadDir=await fixture(t),{api,state}=mockCloudflare();await mkdir(join(payloadDir,'migrations'));
  for(const migration of ['0001_reliable_delivery.sql','0002_daily_use.sql'])await writeFile(join(payloadDir,'migrations',migration),await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8'));
  await writeFile(join(payloadDir,'release.json'),JSON.stringify({appVersion:'1.2.3',migrations:['0001_reliable_delivery.sql','0002_daily_use.sql']}));
  state.applied.add('0001_reliable_delivery.sql');state.db={uuid:'existing-database',name:name+'-db'};
  state.settings={bindings:[{name:'WIHM_INSTALLER',type:'plain_text',text:APP_MARKER},{name:'WIHM_VERSION',type:'plain_text',text:'1.1.0'},{name:'DB',type:'d1',id:'existing-database'},{name:'JWT_SECRET',type:'secret_text'},{name:'CHAT_ROOM',type:'durable_object_namespace',class_name:'ChatRoom'}]};
  const result=await deploy({api,accountId,name,payloadDir,journal:createJournal(join(payloadDir,'journal')),fetcher:health});assert.equal(result.version,'1.2.3');
  assert.deepEqual(state.metadata[0].bindings.find(row=>row.name==='JWT_SECRET'),{name:'JWT_SECRET',type:'inherit'});
  assert.equal(state.metadata[0].bindings.find(row=>row.name==='VAPID_PRIVATE_KEY').type,'secret_text');
  const changes=state.calls.filter(call=>typeof call.options.body==='string'&&JSON.parse(call.options.body).sql?.startsWith('INSERT OR IGNORE INTO schema_migrations'));
  assert.equal(changes.length,1);assert.deepEqual(JSON.parse(changes[0].options.body).params[0],'0002_daily_use.sql');
});
