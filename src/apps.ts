/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { RELEASE_ROOT, REPOSITORY_ID, validVersion } from './update-bundle.js';

// Where GitHub is filtered, the apps and their updates come through this server instead.
// Nothing is stored here: each file streams from the official release, so the 115 MiB Windows setup fits.
// Android only installs an update signed by the same key, and Windows checks SHA256SUMS.sig, so this server can't swap a file in.
export const APP_FILES: Record<string, string> = {
  'wihm-messenger-android-universal.apk': 'application/vnd.android.package-archive',
  'wihm-messenger-windows-setup.exe': 'application/vnd.microsoft.portable-executable',
  'SHA256SUMS': 'text/plain; charset=utf-8',
  'SHA256SUMS.sig': 'text/plain; charset=utf-8',
};
const TAG = /^installer-v(.+)$/;
// A function, because Workers forbid timers in global scope.
const options = () => ({ headers: { 'User-Agent': 'WIHM-Cloudflare-Apps' }, signal: AbortSignal.timeout(20_000) });

/** The latest release tag, read from GitHub's redirect so no rate-limited API call is needed while the name works. */
export async function latestTag(fetcher: typeof fetch = fetch): Promise<string> {
  let url = RELEASE_ROOT + '/latest';
  // A renamed repository adds one redirect before the release one.
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetcher(url, { ...options(), redirect: 'manual' });
    await response.body?.cancel();
    const location = response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    const tag = new URL(location, url).pathname.match(/\/releases\/tag\/([^/]+)$/)?.[1];
    if (tag) return checkedTag(decodeURIComponent(tag));
    url = new URL(location, url).toString();
  }
  const response = await fetcher(`https://api.github.com/repositories/${REPOSITORY_ID}/releases/latest`, { ...options(), headers: { ...options().headers, Accept: 'application/vnd.github+json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('release not found'); }
  return checkedTag(String((await response.json<any>())?.tag_name));
}
function checkedTag(tag: string) {
  if (!validVersion(tag.match(TAG)?.[1])) throw new Error('release tag is invalid');
  return tag;
}

/** Serves /apps/latest.json, /apps/<file> and /apps/<tag>/<file>; null for any other path. */
export async function appsResponse(url: URL, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const parts = url.pathname.split('/').slice(1);
  if (parts[0] !== 'apps' || parts.length < 2 || parts.length > 3) return null;
  try {
    if (parts.length === 2 && parts[1] === 'latest.json') {
      const tag = await latestTag(fetcher);
      // Shaped like GitHub's release, so the apps read it with the parser they already use.
      return Response.json({
        tag_name: tag, draft: false, prerelease: false, html_url: `${RELEASE_ROOT}/tag/${tag}`,
        assets: Object.keys(APP_FILES).map(name => ({ name, browser_download_url: `${url.origin}/apps/${tag}/${name}` })),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const name = parts.at(-1)!;
    if (!Object.hasOwn(APP_FILES, name)) return new Response('Not found', { status: 404 });
    if (parts.length === 2) {
      // A stable link for guides and messages, pinned to one release by the redirect.
      return new Response(null, { status: 302, headers: { Location: `/apps/${await latestTag(fetcher)}/${name}`, 'Cache-Control': 'no-store' } });
    }
    const tag = parts[1];
    if (!validVersion(tag.match(TAG)?.[1])) return new Response('Not found', { status: 404 });
    const upstream = await fetcher(`${RELEASE_ROOT}/download/${tag}/${name}`, { headers: options().headers, redirect: 'follow' });
    if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); return new Response('Not found', { status: upstream.status === 404 ? 404 : 502 }); }
    const headers = new Headers({ 'Content-Type': APP_FILES[name], 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
    const length = upstream.headers.get('Content-Length');
    if (length) headers.set('Content-Length', length);
    return new Response(upstream.body, { headers });
  } catch {
    return new Response('The release could not be reached. Try again later.', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
