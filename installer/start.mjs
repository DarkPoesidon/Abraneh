/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createJournal } from './journal.mjs';
import { startServer } from './server.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Node.js 22 or newer is required. Run the launcher to set it up.');
  process.exit(1);
}
const directory = dirname(fileURLToPath(import.meta.url));
try {
  await access(join(directory, 'payload', 'worker.mjs'));
  const manifest = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'));
  const app = await startServer({ uiDir: join(directory, 'ui'), payloadDir: join(directory, 'payload'), journal: createJournal(join(homedir(), '.wihm-cloudflare', 'installations')), version: manifest.appVersion });
  console.log('\nWIHM Cloudflare Installer\n');
  console.log('Keep this window open until installation is complete.');
  console.log('The address below works only on this device. Open it in your browser:\n');
  console.log(app.url + '\n');
  const isTermux = process.platform === 'android' || process.env.TERMUX_VERSION || process.env.PREFIX?.startsWith('/data/data/com.termux/');
  const command = isTermux ? ['termux-open-url', [app.url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', app.url]]
    : process.platform === 'darwin' ? ['open', [app.url]] : ['xdg-open', [app.url]];
  if (!process.env.WIHM_NO_BROWSER) {
    const browser = spawn(command[0], command[1], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log('Could not open the browser automatically. Open the address above in your browser.'));
    browser.unref();
  }
  process.once('SIGINT', () => { app.close(); });
  process.once('SIGTERM', () => { app.close(); });
} catch {
  console.error('The installation package is not ready. Download and extract the official installer. For development: npm run installer:build');
  process.exitCode = 1;
}
