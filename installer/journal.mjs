/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Contains resource identifiers only. Tokens and JWT secrets are never written here.
export function createJournal(directory) {
  const path = (accountId, name) => join(directory, `${accountId}-${name}.json`);
  return {
    async get(accountId, name) {
      try { return JSON.parse(await readFile(path(accountId, name), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async set(accountId, name, value) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path(accountId, name);
      const temporary = destination + '.' + randomBytes(6).toString('hex') + '.tmp';
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    },
  };
}
