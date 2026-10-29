import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cloudflare } from '../installer/cloudflare.mjs';
import { APP_MARKER } from '../installer/deploy.mjs';
import { normalizeHostname, inspectDomain, connectDomain } from '../installer/domains.mjs';
import { startServer } from '../installer/server.mjs';

const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), name = 'family-chat', hostname = 'chat.example.com';
const token = 'test_token_'.repeat(5);
function mock() {
  const state = { calls: [], zones: [{ id: zoneId, name: 'example.com', status: 'active', account: { id: accountId } }], records: [], domains: [], fail: false, unrelated: false };
  const api = new Cloudflare(token, async (url, options) => {
    const path = new URL(url).pathname.replace('/client/v4', '');
    state.calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
    let result;
    if (path === '/accounts') result = [{ id: accountId, name: 'test' }];
    else if (path === '/zones') result = state.zones;
    else if (path.endsWith('/dns_records')) result = state.records;
    else if (path.endsWith('/workers/domains')) result = state.domains;
    else if (path.endsWith('/settings')) result = { bindings: state.unrelated ? [] : [
      { name: 'WIHM_INSTALLER', text: APP_MARKER }, { name: 'DB', type: 'd1' },
      { name: 'CHAT_ROOM', type: 'durable_object_namespace', class_name: 'ChatRoom' }, { name: 'JWT_SECRET', type: 'secret_text' },
    ] };
    else if (path.endsWith('/d1/database')) result = [];
    else if (path.endsWith('/domains/records')) {
      const body = JSON.parse(options.body);
      assert.equal(body.override_scope, false); assert.equal(body.override_existing_origin, false); assert.equal(body.override_existing_dns_record, false);
      if (state.fail) return Response.json({ success: false, errors: [{ code: 1000, message: token + ' secret echoed' }] }, { status: 403 });
      state.domains.push({ hostname, service: name, zone_id: zoneId, cert_id: 'certificate', enabled: true });
      result = {};
    } else throw new Error('Unexpected test request: ' + path);
    return Response.json({ success: true, result });
  });
  return { state, api };
}

test('optional hostname is normalized and rejects URLs, wildcards, paths, ports and malformed labels', () => {
  assert.equal(normalizeHostname(' CHAT.Example.com '), hostname);
  for (const invalid of ['https://chat.example.com', '*.example.com', 'chat.example.com/path', 'chat.example.com:443', '127.0.0.1', 'a..example.com', '-chat.example.com', [], null]) {
    assert.throws(() => normalizeHostname(invalid), /دامنه/);
  }
});

test('blank hostname makes no extra API request', async () => {
  const { api, state } = mock();
  assert.equal(await inspectDomain(api, accountId, name, ''), null);
  assert.equal(await connectDomain(api, accountId, name, ''), null);
  assert.equal(state.calls.length, 0);
});

test('inactive/foreign zones, DNS and other Worker domains fail without mutation', async () => {
  for (const variant of ['inactive', 'foreign', 'wrong-suffix', 'dns', 'domain', 'disabled']) {
    const { api, state } = mock();
    if (variant === 'inactive') state.zones[0].status = 'pending';
    if (variant === 'foreign') state.zones[0].account.id = 'c'.repeat(32);
    if (variant === 'wrong-suffix') state.zones[0].name = 'ample.com';
    if (variant === 'dns') state.records.push({ type: 'CNAME', name: hostname });
    if (variant === 'domain' || variant === 'disabled') state.domains.push({ hostname, service: variant === 'domain' ? 'other-app' : name, zone_id: zoneId, enabled: variant !== 'disabled' });
    await assert.rejects(connectDomain(api, accountId, name, hostname));
    assert.ok(state.calls.every(call => call.method === 'GET'));
  }
});

test('guarded attach preserves other hostnames, confirms mapping, and retry sends no write', async () => {
  const { api, state } = mock();
  const previous = { hostname: 'other.example.com', service: 'other-worker', zone_id: zoneId };
  state.domains.push(previous);
  const result = await connectDomain(api, accountId, name, hostname);
  assert.equal(result.url, 'https://' + hostname); assert.equal(result.connected, true); assert.equal(result.certificateIssued, true);
  await connectDomain(api, accountId, name, hostname);
  assert.equal(state.calls.filter(call => call.method === 'PUT').length, 1);
  assert.deepEqual(state.domains[0], previous);
  assert.ok(!state.calls.some(call => call.path.endsWith('/subdomain')));
});

test('unrelated app is rejected before domain attachment', async () => {
  const { api, state } = mock(); state.unrelated = true;
  await assert.rejects(connectDomain(api, accountId, name, hostname), /متعلق/);
  assert.ok(state.calls.every(call => call.method === 'GET'));
});

test('wizard preserves deployed URL and setup code when optional domain API fails without exposing provider errors', async t => {
  const { api, state } = mock(); state.fail = true;
  const app = await startServer({ uiDir: '', payloadDir: '', journal: {}, makeApi: () => api,
    runDeploy: async () => ({ url: 'https://family-chat.test.workers.dev', verified: true, adminCode: 'keep-code' }),
  });
  t.after(() => app.close());
  const headers = { Authorization: 'Bearer ' + app.session, Origin: app.origin, 'Content-Type': 'application/json' };
  const post = async (path, body) => fetch(app.origin + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('connect', { token })).status, 200);
  const plan = await (await post('plan', { accountId, name, hostname })).json();
  assert.equal(plan.domain.hostname, hostname); assert.equal(plan.domain.connected, false);
  assert.equal((await post('start', { accountId, name, hostname })).status, 202);
  let status;
  for (let attempt = 0; attempt < 30; attempt++) {
    status = await (await fetch(app.origin + '/api/status', { headers })).json();
    if (status.state === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.state, 'done'); assert.equal(status.result.adminCode, 'keep-code');
  assert.equal(status.result.url, 'https://family-chat.test.workers.dev'); assert.equal(status.result.domain.connected, false);
  assert.ok(!JSON.stringify(status).includes(token)); assert.ok(!JSON.stringify(status).includes('secret echoed'));
});
