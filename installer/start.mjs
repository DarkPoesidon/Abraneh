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
  console.log('\nWIHM Cloudflare — نصب‌کننده\n');
  console.log('این پنجره را تا پایان نصب باز نگه دارید. نشانی زیر فقط روی همین دستگاه باز می‌شود:\n');
  console.log(app.url + '\n');
  const command = process.env.TERMUX_VERSION ? ['termux-open-url', [app.url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', app.url]]
    : process.platform === 'darwin' ? ['open', [app.url]] : ['xdg-open', [app.url]];
  if (!process.env.WIHM_NO_BROWSER) {
    const browser = spawn(command[0], command[1], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log('مرورگر خودکار باز نشد؛ نشانی بالا را در مرورگر باز کنید.'));
    browser.unref();
  }
  process.once('SIGINT', () => { app.close(); });
  process.once('SIGTERM', () => { app.close(); });
} catch {
  console.error('بستهٔ نصب آماده نیست. بستهٔ رسمی نصب‌کننده را دریافت کنید. برای توسعه: npm run installer:build');
  process.exitCode = 1;
}
