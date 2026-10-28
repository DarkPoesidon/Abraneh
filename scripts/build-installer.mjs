import { build } from 'esbuild';
import { mkdir, cp, copyFile, chmod, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = 'dist/WIHM-Installer';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!(await readFile('src/version.ts', 'utf8')).includes(`'${version}'`)) throw new Error('Application/package versions differ');
if (!(await readFile('public/index.html', 'utf8')).includes(`WIHM ${version}`) || !(await readFile('public/sw.js', 'utf8')).includes(`cloudflare-messenger-${version}`)) throw new Error('Browser shell/package versions differ');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'installer-v' + version) throw new Error('Release tag/package versions differ');
await mkdir(join(output, 'payload/public'), { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: join(output, 'payload/worker.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'], minify: true });
await cp('public', join(output, 'payload/public'), { recursive: true });
await copyFile('schema.sql', join(output, 'payload/schema.sql'));
await cp('migrations', join(output, 'payload/migrations'), { recursive: true });
await writeFile(join(output, 'payload/release.json'), JSON.stringify({ appVersion: version, migrations: (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort() }, null, 2) + '\n');
for (const name of ['start.mjs', 'server.mjs', 'cloudflare.mjs', 'deploy.mjs', 'journal.mjs', 'migrations.mjs', 'install.ps1', 'install.sh', 'Start-Windows.cmd', 'Start-Mac.command', 'Start-Linux.sh']) {
  await copyFile(join('installer', name), join(output, name));
}
await cp('installer/ui', join(output, 'ui'), { recursive: true });
await copyFile('public/icon.svg', join(output, 'ui/icon.svg'));
await copyFile('docs/EASY-INSTALL.fa.md', join(output, 'راهنما.md'));
await mkdir(join(output, 'docs/releases'), { recursive: true });
for (const name of ['EASY-INSTALL.fa.md', 'UPDATE.fa.md', 'ROADMAP.fa.md', 'ENCRYPTION-DESIGN.fa.md']) await copyFile(join('docs', name), join(output, 'docs', name));
await copyFile(join('docs/releases', version + '.fa.md'), join(output, 'docs/releases', version + '.fa.md'));
await mkdir(join(output, 'assets'), { recursive: true });
await copyFile('docs/assets/installer-preview.png', join(output, 'assets/installer-preview.png'));
await mkdir(join(output, 'docs/assets'), { recursive: true });
await copyFile('docs/assets/installer-preview.png', join(output, 'docs/assets/installer-preview.png'));
const html = await readFile(join(output, 'ui/index.html'), 'utf8');
await writeFile(join(output, 'ui/index.html'), html.replaceAll('__INSTALLER_VERSION__', version));
for (const name of ['install.sh', 'Start-Mac.command', 'Start-Linux.sh']) await chmod(join(output, name), 0o755);
const workerHash = createHash('sha256').update(await readFile(join(output, 'payload/worker.mjs'))).digest('hex');
await writeFile(join(output, 'build.json'), JSON.stringify({ installerVersion: version, appVersion: version, workerSha256: workerHash }, null, 2) + '\n');
console.log(`Installer built: ${output} (no runtime npm dependencies)`);
