const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverOrigin, proxyRule, isNewer, availableUpdate, checksumFor } = require('../windows/rules.js');

test('only https servers, or plain http on this computer', () => {
  assert.equal(serverOrigin(' chat.workers.dev '), 'https://chat.workers.dev');
  assert.equal(serverOrigin('https://chat.workers.dev/a?b=1'), 'https://chat.workers.dev');
  assert.equal(serverOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const bad of ['http://chat.workers.dev', 'file:///c:/a', 'javascript:alert(1)', 'https://user:pass@chat.workers.dev', '', 'https://']) assert.equal(serverOrigin(bad), null, bad);
});

test('proxy rules', () => {
  assert.equal(proxyRule({ type: 'socks5', host: '127.0.0.1', port: '1080' }), 'socks5://127.0.0.1:1080');
  assert.equal(proxyRule({ type: 'http', host: 'proxy.example', port: 8080 }), 'http://proxy.example:8080');
  for (const bad of [{ type: 'mtproto', host: 'a', port: 1 }, { type: 'http', host: 'a;b', port: 1 }, { type: 'http', host: 'a', port: 70000 }, { type: 'http', host: '', port: 1 }, {}]) assert.equal(proxyRule(bad), null);
});

test('versions compare as numbers', () => {
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(!isNewer('1.0.0', '1.0.0'));
  assert.ok(!isNewer('0.9.0', '1.0.0'));
  assert.ok(!isNewer('bad', '1.0.0'));
});

test('updates come from a complete newer shared release', () => {
  const setup = { name: 'wihm-messenger-windows-setup.exe', browser_download_url: 'setup' };
  const sums = { name: 'SHA256SUMS', browser_download_url: 'sums' };
  const release = { tag_name: 'installer-v1.8.0', assets: [setup, sums] };
  assert.deepEqual(availableUpdate(release, '1.7.22'), {
    version: '1.8.0', name: setup.name, setupUrl: 'setup', sumsUrl: 'sums',
  });
  for (const invalid of [
    { tag_name: 'windows-v1.8.0' }, { draft: true }, { prerelease: true },
    { tag_name: 'installer-v1.8.0-rc.1' }, { assets: [setup] }, { assets: [sums] },
  ]) assert.equal(availableUpdate({ ...release, ...invalid }, '1.7.22'), null);
  assert.equal(availableUpdate(release, '1.8.0'), null);
  assert.equal(availableUpdate({ message: 'rate limited' }, '1.7.22'), null);
});

test('checksums are matched by the exact file name', () => {
  const hash = 'a'.repeat(64), other = 'b'.repeat(64);
  assert.equal(checksumFor(`${other}  other.exe\n${hash} *setup.exe\r\n`, 'setup.exe'), hash);
  assert.equal(checksumFor(`${hash}  setup.exe.bak`, 'setup.exe'), null);
});
