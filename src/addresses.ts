/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env } from './types.js';
import { InputError, inputJson, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';
import { serviceAdmin } from './management.js';
import { serverOrigin } from './server-identity.js';

// When one address is filtered, the apps move to another address of the same server.
// They pin this key on first contact and move only to an address that signs their fresh challenge with it,
// so a lapsed or hijacked alternate domain can't take users over. P-256, because Android 5 has no Ed25519.
export const MAX_ADDRESSES = 5;
const CHALLENGE = /^[A-Za-z0-9_-]{22,88}$/;
export const addressMessage = (challenge: string, addresses: string[]) => new TextEncoder().encode(`wihm-addresses/1\n${challenge}\n${addresses.join('\n')}`);
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const;

async function addressKey(env: Env) {
  const read = async () => {
    const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key='address_key'").first<{ value: string }>();
    return row ? JSON.parse(row.value) as { privateKey: JsonWebKey; publicKey: string } : null;
  };
  let stored = await read();
  if (!stored) {
    const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
    const value = { privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey, publicKey: b64(await crypto.subtle.exportKey('spki', pair.publicKey) as ArrayBuffer) };
    // INSERT OR IGNORE keeps two first requests from leaving two different keys.
    await env.DB.prepare("INSERT OR IGNORE INTO site_settings(key,value) VALUES ('address_key',?)").bind(JSON.stringify(value)).run();
    stored = await read();
  }
  return { publicKey: stored!.publicKey, privateKey: await crypto.subtle.importKey('jwk', stored!.privateKey, algorithm, false, ['sign']) };
}

/** The canonical address, the one this request came in on, then the ones the admin added. */
export async function serverAddresses(env: Env, origin: string) {
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key='server_addresses'").first<{ value: string }>();
  let extra: string[] = []; try { extra = JSON.parse(row?.value || '[]'); } catch { /* An unreadable list is an empty one. */ }
  // A request only reaches this Worker through one of its own routes, so its origin is an address of this server.
  return [...new Set([await serverOrigin(env, origin), origin, ...extra])].slice(0, MAX_ADDRESSES + 2);
}

export function validAddress(value: unknown): string {
  let url: URL; try { url = new URL(String(value).trim()); } catch { throw new InputError('نشانی معتبر نیست؛ مثل https://chat.example.com بنویسید.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.')) throw new InputError('نشانی باید HTTPS و بدون مسیر، پورت یا رمز باشد؛ مثل https://chat.example.com.');
  return url.origin;
}

export async function handleAddresses(request: Request, env: Env, auth?: { userId: string }): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/addresses' && request.method === 'GET') {
    const challenge = url.searchParams.get('challenge') || '';
    if (!CHALLENGE.test(challenge)) throw new InputError('چالش معتبر نیست.');
    if (!await allowRequest(env, 'addresses', request.headers.get('CF-Connecting-IP') || 'unknown', 120, 3600_000)) throw new InputError('درخواست زیاد است.', 429);
    const addresses = await serverAddresses(env, url.origin), key = await addressKey(env);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, addressMessage(challenge, addresses));
    return jsonResponse({ format: 'wihm-addresses/1', publicKey: key.publicKey, addresses, signature: b64(signature) });
  }
  if (url.pathname !== '/api/service/addresses' || !auth) return null;
  await serviceAdmin(env, auth.userId);
  if (request.method === 'GET') return jsonResponse({ addresses: await serverAddresses(env, url.origin) });
  if (request.method !== 'PUT') throw new InputError('روش درخواست معتبر نیست.', 405);
  const body = await inputJson(request, 4096);
  if (!Array.isArray(body.addresses) || body.addresses.length > MAX_ADDRESSES + 2) throw new InputError('حداکثر پنج نشانی دیگر مجاز است.');
  const canonical = await serverOrigin(env, url.origin);
  // The canonical address always leads the list, so sending it back is allowed and adds nothing.
  const extra = [...new Set(body.addresses.filter((value: unknown) => value !== canonical).map(validAddress))].filter(address => address !== canonical);
  if (extra.length > MAX_ADDRESSES) throw new InputError('حداکثر پنج نشانی دیگر مجاز است.');
  await env.DB.prepare("INSERT INTO site_settings(key,value) VALUES ('server_addresses',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(extra)).run();
  return jsonResponse({ addresses: await serverAddresses(env, url.origin) });
}
