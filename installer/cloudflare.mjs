// No Wrangler, workerd, npm dependencies, or native extensions at install time.
const BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(status, codes = []) {
    const hint = status === 401 || status === 403
      ? 'دسترسی کافی نیست. مجوزهای توکن و حساب انتخاب‌شده را بررسی کنید.'
      : status === 429 ? 'کلادفلر درخواست‌های زیادی دریافت کرده است. کمی صبر کنید و دوباره تلاش کنید.'
      : status >= 500 ? 'سرویس کلادفلر موقتاً پاسخ مناسبی نداد. دوباره تلاش کنید.'
      : 'کلادفلر درخواست را نپذیرفت. مجوزها، نام انتخاب‌شده و فعال بودن Workers را بررسی کنید.';
    super(`${hint} (HTTP ${status}${codes.length ? `؛ کد ${codes.join(', ')}` : ''})`);
    this.status = status;
    this.codes = codes;
  }
}

export class Cloudflare {
  constructor(token, fetcher = fetch) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) {
      throw new Error('توکن کامل کلادفلر را کپی کنید؛ ایمیل یا رمز حساب لازم نیست.');
    }
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(path, { method = 'GET', json, form, token = this.token } = {}) {
    let response;
    try {
      response = await this.fetcher(BASE + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(form ? 120_000 : 45_000),
        headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
      });
    } catch {
      throw new Error('ارتباط با کلادفلر برقرار نشد یا زمان انتظار تمام شد. اینترنت را بررسی و دوباره تلاش کنید.');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.success === false) {
      // Never expose response text: providers may echo credentials or uploaded secrets.
      throw new CloudflareError(response.status, (body?.errors ?? []).map(e => e.code).filter(Number.isInteger));
    }
    return { result: body.result, info: body.result_info };
  }

  async list(path) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const { result, info } = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`);
      if (!Array.isArray(result)) throw new Error('فهرست دریافت‌شده از کلادفلر معتبر نیست. دوباره تلاش کنید.');
      all.push(...result);
      if (info?.total_pages !== undefined ? page >= info.total_pages : result.length < 50) return all;
    }
    throw new Error('تعداد منابع این حساب بیش از ظرفیت این نسخهٔ نصب‌کننده است.');
  }

  async query(accountId, databaseId, sql, params = []) {
    const { result } = await this.request(`/accounts/${accountId}/d1/database/${databaseId}/query`, { method: 'POST', json: { sql, params } });
    if (!Array.isArray(result) || result.some(item => item.success === false)) {
      throw new Error('اجرای دستور دیتابیس کامل نشد. دوباره تلاش کنید؛ اطلاعات قبلی حذف نمی‌شوند.');
    }
    return result;
  }
}
