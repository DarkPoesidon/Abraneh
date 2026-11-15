/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
// Signs a release's SHA256SUMS with the update key, so apps that fetch files through a server can trust them.
// Usage: WIHM_UPDATE_SIGNING_KEY=<PEM> node scripts/sign-sums.mjs installer-v1.2.3 SHA256SUMS > SHA256SUMS.sig
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The prefix keeps this signature from ever passing as one over an update bundle, which the same key signs.
// The tag stops a server from relabelling an older signed release as a newer one. windows/rules.js checks the same message.
export const sumsMessage = (tag, sums) => Buffer.concat([Buffer.from(`wihm-sha256sums/1 ${tag}\n`), Buffer.from(sums)]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, file] = process.argv.slice(2);
  if (!/^installer-v\d+\.\d+\.\d+$/.test(tag || '')) throw Error('A release tag like installer-v1.2.3 is required');
  const secret = process.env.WIHM_UPDATE_SIGNING_KEY;
  if (!secret) throw Error('WIHM_UPDATE_SIGNING_KEY is required');
  const anchor = readFileSync(fileURLToPath(new URL('../src/update-key.ts', import.meta.url)), 'utf8').match(/UPDATE_PUBLIC_KEY = '([^']+)'/)[1];
  const message = sumsMessage(tag, readFileSync(file)), signature = sign(null, message, createPrivateKey(secret));
  // A key that doesn't match the apps' trust anchor would publish a signature no app accepts.
  if (!verify(null, message, createPublicKey({ key: Buffer.from(anchor, 'base64'), format: 'der', type: 'spki' }), signature)) throw Error('The signing key does not match UPDATE_PUBLIC_KEY');
  process.stdout.write(signature.toString('base64') + '\n');
}
