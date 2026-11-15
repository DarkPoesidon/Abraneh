/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
const { app, dialog, net, shell } = require('electron');
const { createHash } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { availableUpdate, checksumFor, sumsSigned } = require('./rules');

// By number, not name: GitHub keeps the number through a rename or a transfer. Same number as src/update-bundle.ts.
const RELEASES = 'https://api.github.com/repositories/1436869002/releases/latest';
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

/** GitHub first; where it is filtered, the same release through the user's server. */
async function latestRelease(server) {
  try {
    const response = await net.fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'WIHM-Windows' } });
    if (response.ok) return { release: await response.json(), viaServer: false };
  } catch (error) {
    if (!server) throw error;
  }
  if (!server) throw new Error('GitHub did not answer');
  const response = await net.fetch(server + '/apps/latest.json');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return { release: await response.json(), viaServer: true };
}

/** interactive says whether to report "no update" and errors, which a background check keeps quiet. */
async function checkForUpdate(t, interactive, window, server) {
  if (busy) return;
  busy = true;
  try {
    const { release: latest, viaServer } = await latestRelease(server);
    const release = availableUpdate(latest, app.getVersion());
    if (!release) {
      if (interactive) await dialog.showMessageBox({ message: t('noUpdate') });
      return;
    }
    const { response: choice } = await dialog.showMessageBox({ message: t('updateReady', release.version), buttons: [t('update'), t('later')], defaultId: 0, cancelId: 1 });
    if (choice !== 0) return;
    dialog.showMessageBox({ message: t('downloading') });
    const sums = await (await net.fetch(release.sumsUrl)).text();
    // A server only relays the files, so it must not be able to choose them: the release key signs the sums.
    if ((viaServer || release.sigUrl) && !(release.sigUrl && sumsSigned(release.tag, sums, await (await net.fetch(release.sigUrl)).text()))) throw new Error(t('badUpdate'));
    const expected = checksumFor(sums, release.name);
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
