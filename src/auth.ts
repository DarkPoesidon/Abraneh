/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { JwtPayload } from './types.js';

export function hasJwtSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && new TextEncoder().encode(secret).length >= 32;
}

// Generate a random hex salt
export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Hash password with PBKDF2 using Web Crypto API
export async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const saltBytes = new Uint8Array(
    salt.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );

  const derivedKey = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hashBytes = new Uint8Array(derivedKey);
  return Array.from(hashBytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Verify password
export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const calculatedHash = await hashPassword(password, salt);
  return calculatedHash === hash;
}

// Helper: base64url encode/decode
function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), char => char.charCodeAt(0));
}

const encodeJson = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
const decodeJson = (value: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(value)));

// Sign JWT
export async function signJwt(payload: Omit<JwtPayload, 'exp'>, secret: string | undefined, expiresInSec = 60 * 60 * 24 * 7): Promise<string> {
  if (!hasJwtSecret(secret)) throw new Error('JWT_SECRET must contain at least 32 bytes');
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  const fullPayload: JwtPayload = { ...payload, exp };

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = encodeJson(header);
  const payloadB64 = encodeJson(fullPayload);
  const dataToSign = `${headerB64}.${payloadB64}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(dataToSign));
  const sigBytes = new Uint8Array(signature);
  const sigB64 = base64UrlEncode(sigBytes);

  return `${dataToSign}.${sigB64}`;
}

// Verify JWT
export async function verifyJwt(token: string, secret: string | undefined): Promise<JwtPayload | null> {
  if (!hasJwtSecret(secret)) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const header = decodeJson(headerB64);
    if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null;
    const dataToVerify = `${headerB64}.${payloadB64}`;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = base64UrlDecode(sigB64);

    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(dataToVerify));
    if (!isValid) return null;

    const payload: JwtPayload = decodeJson(payloadB64);
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)
      || typeof payload.userId !== 'string' || !payload.userId
      || typeof payload.username !== 'string' || !payload.username
      || typeof payload.displayName !== 'string') {
      return null; // Expired
    }
    if (payload.sid !== undefined && (typeof payload.sid !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.sid))) return null;

    return payload;
  } catch {
    return null;
  }
}
