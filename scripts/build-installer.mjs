import { build } from 'esbuild';
import { mkdir, cp, copyFile, chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = 'dist/WIHM-Installer';
await mkdir(join(output, 'payload/public'), { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: join(output, 'payload/worker.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'], minify: true });
await cp('public', join(output, 'payload/public'), { recursive: true });
await copyFile('schema.sql', join(output, 'payload/schema.sql'));
for (const name of ['start.mjs', 'server.mjs', 'cloudflare.mjs', 'deploy.mjs', 'journal.mjs', 'install.ps1', 'install.sh', 'Start-Windows.cmd', 'Start-Mac.command', 'Start-Linux.sh']) {
  await copyFile(join('installer', name), join(output, name));
}
await cp('installer/ui', join(output, 'ui'), { recursive: true });
await copyFile('public/icon.svg', join(output, 'ui/icon.svg'));
await copyFile('docs/EASY-INSTALL.fa.md', join(output, 'راهنما.md'));
for (const name of ['install.sh', 'Start-Mac.command', 'Start-Linux.sh']) await chmod(join(output, name), 0o755);
const workerHash = createHash('sha256').update(await readFile(join(output, 'payload/worker.mjs'))).digest('hex');
await writeFile(join(output, 'build.json'), JSON.stringify({ installerVersion: '1.0.0', workerSha256: workerHash }, null, 2) + '\n');
console.log(`Installer built: ${output} (no runtime npm dependencies)`);
