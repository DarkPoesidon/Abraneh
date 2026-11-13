const { app, dialog, net, shell } = require('electron');
const { createHash } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { availableUpdate, checksumFor } = require('./rules');

const RELEASES = 'https://api.github.com/repos/DarkPoesidon/WIHM-Cloudflare/releases/latest';
let busy = false;

async function download(url, window) {
  const response = await net.fetch(url);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const total = Number(response.headers.get('content-length')), chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    chunks.push(part.value);
    received += part.value.length;
    window.setProgressBar(total ? received / total : 2);
  }
  return Buffer.concat(chunks);
}

/** interactive says whether to report "no update" and errors, which a background check keeps quiet. */
async function checkForUpdate(t, interactive, window) {
  if (busy) return;
  busy = true;
  try {
    const response = await net.fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'WIHM-Windows' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const release = availableUpdate(await response.json(), app.getVersion());
    if (!release) {
      if (interactive) await dialog.showMessageBox({ message: t('noUpdate') });
      return;
    }
    const { response: choice } = await dialog.showMessageBox({ message: t('updateReady', release.version), buttons: [t('update'), t('later')], defaultId: 0, cancelId: 1 });
    if (choice !== 0) return;
    dialog.showMessageBox({ message: t('downloading') });
    const expected = checksumFor(await (await net.fetch(release.sumsUrl)).text(), release.name);
    const bytes = await download(release.setupUrl, window);
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(t('badUpdate'));
    const file = join(app.getPath('temp'), release.name);
    await writeFile(file, bytes);
    const failure = await shell.openPath(file);
    if (failure) throw new Error(failure);
    app.isQuitting = true;
    app.quit();
  } catch (error) {
    if (interactive) dialog.showErrorBox(t('updateFailed'), error.message);
    else console.warn('Update check failed:', error.message);
  } finally {
    busy = false;
    window.setProgressBar(-1);
  }
}

module.exports = { checkForUpdate };
