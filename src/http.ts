export function corsResponse(body: BodyInit | null, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(headers);
  merged.set('Access-Control-Allow-Origin', '*');
  merged.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  merged.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  merged.set('Cache-Control', 'no-store');
  return new Response(body, { status, headers: merged });
}
export const jsonResponse = (data: unknown, status = 200) => corsResponse(JSON.stringify(data), status, { 'Content-Type': 'application/json; charset=utf-8' });
export const errorResponse = (message: string, status = 400) => jsonResponse({ error: message }, status);
export class InputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export async function inputJson(request: Request): Promise<any> {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('محتوای درخواست خالی است.');
  const decoder = new TextDecoder(); let size = 0, text = '';
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 64_000) { await reader.cancel(); throw new InputError('حجم درخواست بیش از حد مجاز است.', 413); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode(); let value;
  try { value = JSON.parse(text); } catch { throw new InputError('فرمت درخواست معتبر نیست.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('فرمت درخواست معتبر نیست.');
  return value;
}
