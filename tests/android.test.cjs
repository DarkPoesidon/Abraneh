const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
let fixture;
before(async () => { fixture = await (await import('./browser/fixture.mjs')).createNavigationFixture(); });
after(async () => { await fixture?.close(); });

test('the server vouches for the Android app without a login, so Chrome can open it full screen', async () => {
  const response = await fixture.mf.dispatchFetch(fixture.origin + '/.well-known/assetlinks.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  const [statement] = await response.json();
  assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(statement.target.package_name, 'com.wihm.messenger');
  assert.deepEqual(statement.target.sha256_cert_fingerprints, ['04:B3:31:40:AF:1D:FC:33:36:63:F1:9A:C5:66:2B:9E:F2:A3:14:7B:11:05:FB:24:31:16:FF:6A:24:3A:2C:99']);
});
