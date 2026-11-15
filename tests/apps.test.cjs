const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');

let appsResponse;
before(async () => {
  const result = await build({ entryPoints: ['src/apps.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  ({ appsResponse } = module.exports);
});

// A fake GitHub. `renamed` adds the repository-rename hop; `named` false makes the name stop resolving.
function github({ renamed = false, named = true } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push(url);
    const { hostname, pathname } = new URL(url);
    if (hostname === 'api.github.com') return Response.json({ tag_name: 'installer-v1.8.0' });
    if (!named) return new Response('Not Found', { status: 404 });
    if (pathname === '/DarkPoesidon/Abraneh/releases/latest') {
      assert.equal(init.redirect, 'manual');
      return renamed ? new Response(null, { status: 301, headers: { Location: 'https://github.com/New/Abraneh/releases/latest' } })
        : new Response(null, { status: 302, headers: { Location: 'https://github.com/DarkPoesidon/Abraneh/releases/tag/installer-v1.7.27' } });
    }
    if (pathname === '/New/Abraneh/releases/latest') return new Response(null, { status: 302, headers: { Location: '/New/Abraneh/releases/tag/installer-v1.7.28' } });
    const file = pathname.match(/^\/DarkPoesidon\/Abraneh\/releases\/download\/(installer-v[\d.]+)\/(.+)$/);
    if (file) return new Response('bytes of ' + file[2] + ' ' + file[1], { headers: { 'Content-Length': '99' } });
    throw new Error('unexpected ' + url);
  };
  return { calls, fetcher };
}
const get = (path, fake) => appsResponse(new URL('https://chat.example' + path), fake.fetcher);

test('latest.json points every app file at this server, pinned to the latest tag', async () => {
  const fake = github();
  const release = await (await get('/apps/latest.json', fake)).json();
  assert.equal(release.tag_name, 'installer-v1.7.27');
  const apk = release.assets.find(asset => asset.name === 'wihm-messenger-android-universal.apk');
  assert.equal(apk.browser_download_url, 'https://chat.example/apps/installer-v1.7.27/wihm-messenger-android-universal.apk');
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), ['SHA256SUMS', 'SHA256SUMS.sig', 'wihm-messenger-android-universal.apk', 'wihm-messenger-windows-setup.exe']);
  assert.ok(fake.calls.every(url => !url.includes('api.github.com')), 'the redirect is enough while the name works');
});

test('a rename hop is followed, and the API by number is the last resort', async () => {
  assert.equal((await (await get('/apps/latest.json', github({ renamed: true }))).json()).tag_name, 'installer-v1.7.28');
  const gone = github({ named: false });
  assert.equal((await (await get('/apps/latest.json', gone)).json()).tag_name, 'installer-v1.8.0');
  assert.ok(gone.calls.some(url => url.includes('/repositories/1436869002/')));
});

test('a file streams from the same release, as a download', async () => {
  const response = await get('/apps/installer-v1.7.27/wihm-messenger-windows-setup.exe', github());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'bytes of wihm-messenger-windows-setup.exe installer-v1.7.27');
  assert.match(response.headers.get('Content-Disposition'), /attachment; filename="wihm-messenger-windows-setup.exe"/);
  assert.equal(response.headers.get('Content-Length'), '99');
  const stable = await get('/apps/wihm-messenger-android-universal.apk', github());
  assert.equal(stable.status, 302);
  assert.equal(stable.headers.get('Location'), '/apps/installer-v1.7.27/wihm-messenger-android-universal.apk');
});

test('only release files and real tags are served, and other paths are left alone', async () => {
  const fake = github();
  for (const path of ['/apps/installer-v1.7.27/wihm-update.json', '/apps/installer-v1.7.27/..%2Fsecret', '/apps/wihm-installer.zip']) assert.equal((await get(path, fake)).status, 404, path);
  assert.equal((await get('/apps/v1.7.27/SHA256SUMS', fake)).status, 404);
  assert.equal((await get('/apps/installer-v1.7/SHA256SUMS', fake)).status, 404);
  assert.equal(await get('/api/apps', fake), null);
  assert.equal(await get('/apps/a/b/c', fake), null);
  assert.ok(fake.calls.every(url => !url.includes('wihm-update.json') && !url.includes('secret')));
});
