import { Env } from './types.js';
import { chatAccess, isBlocked, validId } from './access.js';
import { corsResponse, InputError, jsonResponse } from './http.js';
import { allowRequest } from './limits.js';

const MiB = 1024 * 1024;
// Roughly the recorder's bitrate for the longest allowed message, with headroom for browsers that ignore it.
const KINDS: Record<string, { maxBytes: number; maxMs: number; text: string; types: string[] }> = {
  voice: { maxBytes: 4 * MiB, maxMs: 5 * 60_000, text: '🎤 پیام صوتی', types: ['audio/webm', 'audio/ogg', 'audio/mp4'] },
  video: { maxBytes: 16 * MiB, maxMs: 60_000, text: '🎥 پیام تصویری', types: ['video/webm', 'video/mp4'] },
};

function matchesContainer(mime: string, bytes: Uint8Array) {
  const start = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime.endsWith('/webm')) return start(0x1a, 0x45, 0xdf, 0xa3);
  if (mime.endsWith('/ogg')) return start(0x4f, 0x67, 0x67, 0x53);
  return new TextDecoder().decode(bytes.subarray(4, 8)) === 'ftyp';
}

async function readBody(request: Request, maximum: number) {
  if (Number(request.headers.get('Content-Length') || 0) > maximum) throw new InputError('حجم پیام بیش از حد مجاز است.', 413);
  const reader = request.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
  if (!reader) throw new InputError('محتوای پیام خالی است.');
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new InputError('حجم پیام بیش از حد مجاز است.', 413); }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export async function handleMedia(request: Request, env: Env, auth: { userId: string; sid: string; displayName: string }) {
  const url = new URL(request.url), match = url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/media(?:\/([a-zA-Z0-9_-]+))?$/);
  if (!match) return null;
  const [, chatId, messageId] = match;
  if (!await chatAccess(env, chatId, auth.userId)) throw new InputError('دسترسی به این گفتگو ممکن نیست.', 403);
  const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));

  if (request.method === 'GET' && messageId) {
    const stored = await room.fetch('https://room/media?id=' + encodeURIComponent(messageId));
    if (!stored.ok) throw new InputError('این پیام دیگر در دسترس نیست.', 404);
    return corsResponse(stored.body, 200, { 'Content-Type': stored.headers.get('Content-Type') || 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' });
  }
  if (request.method !== 'POST' || messageId) throw new InputError('روش درخواست معتبر نیست.', 405);

  if (await isBlocked(env, chatId, auth.userId)) throw new InputError('این گفتگوی خصوصی مسدود است.', 403);
  const kind = KINDS[url.searchParams.get('kind') || ''], mime = String(url.searchParams.get('mime') || '').split(';')[0].toLowerCase();
  const durationMs = Number(url.searchParams.get('durationMs')), clientMsgId = url.searchParams.get('clientMsgId') || '', replyToId = url.searchParams.get('replyToId') || '';
  if (!kind || !kind.types.includes(mime)) throw new InputError('قالب این پیام پشتیبانی نمی‌شود.', 415);
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > kind.maxMs + 5000) throw new InputError('مدت این پیام بیش از حد مجاز است.');
  if (clientMsgId && !/^[a-zA-Z0-9_-]{1,100}$/.test(clientMsgId)) throw new InputError('شناسهٔ پیام معتبر نیست.');
  if (replyToId && !validId(replyToId)) throw new InputError('پیام مورد پاسخ معتبر نیست.');
  if (!await allowRequest(env, 'media', auth.userId, 60, 3600_000)) throw new InputError('تعداد پیام‌های صوتی و تصویری زیاد است؛ کمی بعد دوباره تلاش کنید.', 429);
  const bytes = await readBody(request, kind.maxBytes);
  if (bytes.byteLength < 16 || !matchesContainer(mime, bytes)) throw new InputError('فایل این پیام معتبر نیست.');

  const target = new URL('https://room/media-upload');
  for (const [name, value] of Object.entries({ chatId, userId: auth.userId, displayName: auth.displayName, kind: url.searchParams.get('kind')!, mime, durationMs: String(durationMs), clientMsgId, replyToId, text: kind.text })) target.searchParams.set(name, value);
  const stored = await room.fetch(target.toString(), { method: 'POST', body: bytes });
  return jsonResponse(await stored.json(), stored.status);
}
