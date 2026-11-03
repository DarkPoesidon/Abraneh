const { app, dialog, net, shell } = require('electron');
const { createHash } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { newestRelease, checksumFor } = require('./rules');

const RELEASES = 'https://api.github.com/repos/DarkPoesidon/WIHM-Cloudflare/releases?per_page=40';

/** interactive says whether to report "no update" and errors, which a check at startup keeps quiet. */
async function checkForUpdate(t, interactive) {
  try {
    const response = await net.fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'WIHM-Windows' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const release = newestRelease(await response.json(), app.getVersion());
    if (!release) {
      if (interactive) await dialog.showMessageBox({ message: t('noUpdate') });
      return;
    }
    const { response: choice } = await dialog.showMessageBox({ message: t('updateReady', release.version), buttons: [t('update'), t('later')], defaultId: 0, cancelId: 1 });
    if (choice !== 0) return;
    const expected = checksumFor(await (await net.fetch(release.sumsUrl)).text(), release.name);
    const download = await net.fetch(release.setupUrl);
    if (!download.ok) throw new Error('HTTP ' + download.status);
    const bytes = Buffer.from(await download.arrayBuffer());
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
  }
}

module.exports = { checkForUpdate };
