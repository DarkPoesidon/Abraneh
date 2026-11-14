/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env } from './types.js';

export async function allowRequest(env: Env, scope: string, identity: string, maximum: number, windowMs: number): Promise<boolean> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope + ':' + identity));
  const key = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now(), start = Math.floor(now / windowMs) * windowMs;
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key,window_start,count,expires_at) VALUES (?,?,1,?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
    window_start = excluded.window_start, expires_at = excluded.expires_at RETURNING count`)
    .bind(key, start, start + windowMs).first<{ count: number }>();
  // Cleanup is bounded by a time index; no IP addresses or plaintext names are retained.
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now - 86400_000).run();
  return !!row && row.count <= maximum;
}
