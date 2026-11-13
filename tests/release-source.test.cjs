const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { build } = require('esbuild');

let releaseFiles, REPOSITORY_ID;
before(async () => {
  const result = await build({ entryPoints: ['src/update-bundle.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  ({ releaseFiles, REPOSITORY_ID } = module.exports);
});

// A fake GitHub: `named` says whether the repository name still resolves, `api` whether lookup by number works.
function github({ named, api }) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const { hostname, pathname } = new URL(url);
    if (hostname === 'github.com') return named ? new Response(pathname.endsWith('.sig') ? 'signature' : 'payload') : new Response('Not Found', { status: 404 });
    if (hostname === 'api.github.com') {
      if (!api) return new Response('{}', { status: 404 });
      return Response.json({ assets: ['wihm-update.json', 'wihm-update.sig'].map(name => ({ name, browser_download_url: 'https://objects.example/' + name })) });
    }
    if (hostname === 'objects.example') return new Response(pathname.endsWith('.sig') ? 'moved-signature' : 'moved-payload');
    throw new Error('unexpected ' + url);
  };
  return { calls, fetcher };
}
const text = bytes => new TextDecoder().decode(bytes);

test('the release is fetched by name when the name works, with no API call', async () => {
  const { calls, fetcher } = github({ named: true, api: true });
  const [payload, signature] = await releaseFiles(undefined, fetcher);
  assert.equal(text(payload), 'payload'); assert.equal(text(signature), 'signature');
  assert.ok(calls.every(url => url.startsWith('https://github.com/')));
});

test('after a rename whose redirect is gone, the release is found by repository number', async () => {
  const { calls, fetcher } = github({ named: false, api: true });
  const [payload, signature] = await releaseFiles('1.2.3', fetcher);
  assert.equal(text(payload), 'moved-payload'); assert.equal(text(signature), 'moved-signature');
  assert.ok(calls.includes(`https://api.github.com/repositories/${REPOSITORY_ID}/releases/tags/installer-v1.2.3`));
  const { calls: latest, fetcher: latestFetcher } = github({ named: false, api: true });
  await releaseFiles(undefined, latestFetcher);
  assert.ok(latest.includes(`https://api.github.com/repositories/${REPOSITORY_ID}/releases/latest`));
});

test('when neither way works, the original failure is reported', async () => {
  await assert.rejects(releaseFiles(undefined, github({ named: false, api: false }).fetcher));
});

test('every updater looks releases up by the same repository number, never by name', () => {
  const sources = { server: 'src/update-bundle.ts', android: 'android/app/src/main/java/com/wihm/messenger/UpdateHelper.java', windows: 'windows/updates.js' };
  for (const [name, path] of Object.entries(sources)) {
    const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(String(REPOSITORY_ID)), name + ' must use repository ' + REPOSITORY_ID);
    assert.ok(!/api\.github\.com\/repos\//.test(source), name + ' must not look releases up by name in the API');
  }
});
