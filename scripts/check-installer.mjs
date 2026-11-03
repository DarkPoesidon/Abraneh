// Exercise the shipped launchers and server without developer dependencies or cloud credentials.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'dist/WIHM-Installer');
for(const guide of ['راهنما.md','docs/START-HERE.fa.md','docs/EASY-INSTALL.fa.md','docs/DAILY-USE.fa.md','docs/ADVANCED.fa.md','docs/GUIDE-ADMIN.fa.md','docs/GUIDE-USER.fa.md']){
  for(const [,target]of (await readFile(resolve(directory,guide),'utf8')).matchAll(/\]\(([^)]+)\)/g))if(!/^(?:https?:|mailto:|#)/.test(target))await readFile(resolve(directory,guide,'..',decodeURIComponent(target.split('#')[0])));
}
const metadata = JSON.parse(await readFile(directory + '/build.json', 'utf8'));
const digest = createHash('sha256').update(await readFile(directory + '/payload/worker.mjs')).digest('hex');
assert.equal(digest, metadata.workerSha256);
const command = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', directory + '/install.ps1']]
  : ['bash', [directory + '/install.sh']];
const child = spawn(command[0], command[1], { env: { ...process.env, WIHM_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '', errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
const url = await new Promise((resolveUrl, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged launcher did not start: ' + errors)); }, 120_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); if (!output.match(/http:\/\/127\.0\.0\.1:\d+\/#/)) reject(new Error('Launcher exited with ' + code + ': ' + errors + output)); });
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}/);
    if (match) { clearTimeout(timer); resolveUrl(match[0]); }
  });
});
try {
  const parsed = new URL(url);
  const page = await fetch(parsed.origin);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('اتصال حساب'));
  const client = await fetch(parsed.origin + '/app.js'); assert.equal(client.status, 200);
  const headers = { Origin: parsed.origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + parsed.hash.slice(1) };
  const status = await (await fetch(parsed.origin + '/api/status', { headers })).json();
  assert.equal(status.connected, false);
  const stopped = await fetch(parsed.origin + '/api/stop', { method: 'POST', headers, body: '{}' });
  assert.equal(stopped.status, 200);
  if (child.exitCode === null) await once(child, 'exit');
  assert.equal(child.exitCode, 0, errors);
  assert.match(output, /Keep this window open until installation is complete/);
  assert.doesNotMatch(output + errors, /[\u0600-\u06ff]/, 'Terminal messages must remain readable without Persian support.');
  console.log('Packaged launcher, English terminal, Persian UI, session isolation and clean shutdown passed.');
} finally { if (child.exitCode === null) child.kill(); }
