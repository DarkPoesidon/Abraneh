const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverOrigin, proxyRule, isNewer, newestRelease, checksumFor } = require('../windows/rules.js');

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

test('the newest Windows release ignores the server, Android, drafts and incomplete ones', () => {
  const release = (tag, extra = {}) => {
    const version = tag.replace('windows-v', '');
    return { tag_name: tag, assets: [{ name: `wihm-messenger-windows-v${version}-setup.exe`, browser_download_url: 'setup/' + version }, { name: 'SHA256SUMS.txt', browser_download_url: 'sums/' + version }], ...extra };
  };
  const found = newestRelease([release('installer-v9.0.0'), release('android-v9.0.0'), release('windows-v3.0.0', { draft: true }), release('windows-v2.5.0', { prerelease: true }), release('windows-v2.1.0', { assets: [] }), release('windows-v2.0.0'), release('windows-v1.5.0')], '1.0.0');
  assert.equal(found.version, '2.0.0');
  assert.equal(found.setupUrl, 'setup/2.0.0');
  assert.equal(newestRelease([release('windows-v1.0.0')], '1.0.0'), null);
  assert.equal(newestRelease({ message: 'rate limited' }, '1.0.0'), null);
});

test('checksums are matched by the exact file name', () => {
  const hash = 'a'.repeat(64), other = 'b'.repeat(64);
  assert.equal(checksumFor(`${other}  other.exe\n${hash} *setup.exe\r\n`, 'setup.exe'), hash);
  assert.equal(checksumFor(`${hash}  setup.exe.bak`, 'setup.exe'), null);
});
