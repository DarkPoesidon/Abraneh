/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
export function historyOptions(params: URLSearchParams) {
  const limit = Number(params.get('limit') || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('تعداد پیام‌ها باید بین ۱ تا ۱۰۰ باشد.');
  const cursor = params.get('before');
  let beforeTime: number | null = null;
  let beforeId = '';
  if (cursor !== null) {
    const match = /^(\d+):([a-zA-Z0-9_-]+)$/.exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('نشانگر تاریخچه نامعتبر است.');
    beforeTime = Number(match[1]);
    beforeId = match[2];
  }
  return { limit, beforeTime, beforeId };
}
