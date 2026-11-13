// Pure rules, free of Electron so they can be unit tested.
const TAG_PREFIX = 'installer-v';
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

function availableUpdate(release, current) {
  if (!release || release.draft || release.prerelease || !String(release.tag_name).startsWith(TAG_PREFIX)) return null;
  const version = release.tag_name.slice(TAG_PREFIX.length);
  if (!isNewer(version, current) || !Array.isArray(release.assets)) return null;
  const name = 'wihm-messenger-windows-setup.exe';
  const setup = release.assets.find(asset => asset.name === name);
  const sums = release.assets.find(asset => asset.name === 'SHA256SUMS');
  if (!setup?.browser_download_url || !sums?.browser_download_url) return null;
  return { version, name, setupUrl: setup.browser_download_url, sumsUrl: sums.browser_download_url };
}

function checksumFor(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64}) [ *](.+)$/i);
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

/** The saved window place, if it still fits on a connected screen; otherwise the default size, centred. */
function windowBounds(saved, workAreas) {
  const fallback = { width: 1100, height: 760 };
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || saved.width < 360 || saved.height < 560) return fallback;
  // Enough of the title bar must be on a screen to grab, or a removed monitor would hide the window.
  const reachable = (workAreas || []).some(area => saved.x + saved.width - 80 > area.x && saved.x + 80 < area.x + area.width && saved.y >= area.y - 8 && saved.y + 40 < area.y + area.height);
  return reachable ? { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) } : fallback;
}

/** The unread count as shown, or '' when there is nothing to show. */
function unreadLabel(count) {
  const value = Math.floor(Number(count));
  if (!Number.isFinite(value) || value <= 0) return '';
  return value > 99 ? '99+' : String(value);
}

module.exports = { serverOrigin, proxyRule, isNewer, availableUpdate, checksumFor, windowBounds, unreadLabel };
