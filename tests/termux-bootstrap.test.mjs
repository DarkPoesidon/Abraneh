// Exercise the real shell launcher with simulated Termux package commands.
// Android/Bionic execution is a separate on-device or emulator check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const prefixOnly of [false, true]) {
  test(`Termux launcher upgrades packages before installs (${prefixOnly ? 'PREFIX, existing Node' : 'TERMUX_VERSION, missing Node'})`, { skip: process.platform === 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'wihm-termux-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const commands = join(directory, 'commands'), packageDir = join(directory, 'installer with spaces');
    await mkdir(commands);
    await mkdir(join(packageDir, 'payload'), { recursive: true });
    await writeFile(join(packageDir, 'payload/worker.mjs'), '');
    await writeFile(join(packageDir, 'start.mjs'), '');
    await cp(new URL('../installer/install.sh', import.meta.url), join(packageDir, 'install.sh'));
    const interpreter = process.platform === 'android' ? '/data/data/com.termux/files/usr/bin/bash' : '/usr/bin/env bash';
    const executable = (name, text) => writeFile(join(commands, name), '#!' + interpreter + '\nset -eu\n' + text, { mode: 0o755 });
    await executable('apt-get', `
printf '%s\\n' "$*" >> "$QA_DIRECTORY/packages.log"
case "$*" in
  update) touch "$QA_DIRECTORY/updated" ;;
  '-y -o Dpkg::Options::=--force-confold dist-upgrade')
    test -f "$QA_DIRECTORY/updated"
    touch "$QA_DIRECTORY/upgraded" ;;
  'install -y curl tar termux-tools') test -f "$QA_DIRECTORY/upgraded" ;;
  'install -y nodejs-lts')
    test -f "$QA_DIRECTORY/upgraded"
    touch "$QA_DIRECTORY/node-ready" ;;
  *) exit 91 ;;
esac
`);
    await executable('node', `
test -f "$QA_DIRECTORY/node-ready" || exit 1
if [[ "$1" == '-e' ]]; then exit 0; fi
test "$1" == "$QA_PACKAGE/start.mjs"
printf 'Started Termux installer\\n'
`);
    // Any desktop runtime download or use of pkg's broken curl check is a failure.
    await executable('curl', 'exit 92\n');
    await executable('pkg', 'exit 93\n');
    if (prefixOnly) await writeFile(join(directory, 'node-ready'), '');
    const env = { ...process.env, HOME: directory, PATH: commands + ':' + process.env.PATH, QA_DIRECTORY: directory, QA_PACKAGE: packageDir };
    delete env.TERMUX_VERSION; delete env.PREFIX;
    if (prefixOnly) env.PREFIX = '/data/data/com.termux/files/usr';
    else env.TERMUX_VERSION = '0.118.3';
    const result = spawnSync('bash', [join(packageDir, 'install.sh')], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
    assert.match(result.stdout, /Started Termux installer/);
    assert.doesNotMatch(result.stdout + result.stderr, /[\u0600-\u06ff]/);
    const expected = ['update', '-y -o Dpkg::Options::=--force-confold dist-upgrade', 'install -y curl tar termux-tools'];
    if (!prefixOnly) expected.push('install -y nodejs-lts');
    assert.deepEqual((await readFile(join(directory, 'packages.log'), 'utf8')).trim().split('\n'), expected);
  });
}
