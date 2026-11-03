// Pure rules, free of Electron so they can be unit tested.
const TAG_PREFIX = 'windows-v';
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Returns the server's origin, or null. Plain http is only for this computer. */
function serverOrigin(input) {
  const text = String(input || '').trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.origin;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/** Returns Chromium's proxy rule, or null for an invalid proxy. */
function proxyRule({ type, host, port } = {}) {
  const number = Number(port);
  if (!['socks5', 'http'].includes(type) || !HOST.test(String(host || '')) || !Number.isInteger(number) || number < 1 || number > 65535) return null;
  return `${type}://${host}:${number}`;
}

function versionParts(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match && match.slice(1).map(Number);
}

function isNewer(latest, current) {
  const a = versionParts(latest), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** This repository also holds server and Android releases, so "latest" can't be used here. */
function newestRelease(releases, current) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release.draft || release.prerelease || !String(release.tag_name).startsWith(TAG_PREFIX)) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length), name = `wihm-messenger-windows-v${version}-setup.exe`;
    const setup = release.assets?.find(asset => asset.name === name), sums = release.assets?.find(asset => asset.name === 'SHA256SUMS.txt');
    if (setup && sums && isNewer(version, best ? best.version : current)) best = { version, name, setupUrl: setup.browser_download_url, sumsUrl: sums.browser_download_url };
  }
  return best;
}

function checksumFor(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64}) [ *](.+)$/i);
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

module.exports = { serverOrigin, proxyRule, isNewer, newestRelease, checksumFor };
