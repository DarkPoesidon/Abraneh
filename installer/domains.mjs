/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { inspect, validAccount, validName } from './deploy.mjs';

export function normalizeHostname(value = '') {
  if (typeof value !== 'string') throw new Error('دامنه را بدون https، مسیر، پورت یا ستاره بنویسید.');
  const hostname = value.trim().toLowerCase();
  if (!hostname) return '';
  if (hostname.length > 253 || !hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname)
      || !/^[a-z]{2,63}$/.test(hostname.split('.').at(-1))
      || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('دامنهٔ کامل را با حروف انگلیسی و بدون https، مسیر، پورت یا ستاره بنویسید؛ مثل chat.example.com.');
  }
  return hostname;
}

export async function inspectDomain(api, accountId, name, value) {
  const hostname = normalizeHostname(value);
  if (!hostname) return null;
  if (!validAccount(accountId) || !validName(name)) throw new Error('حساب و نام برنامه معتبر نیست.');
  const zones = await api.list(`/zones?account.id=${accountId}`);
  const zone = zones.filter(zone => zone.account?.id === accountId && validAccount(zone.id)
    && (hostname === zone.name || hostname.endsWith('.' + zone.name)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone || zone.status !== 'active') throw new Error('دامنه باید در یک Zone فعالِ همین حساب کلادفلر باشد. مجوز Zone: Read و محدودهٔ دامنهٔ توکن را بررسی کنید.');
  const { result: domains } = await api.request(`/accounts/${accountId}/workers/domains`);
  if (!Array.isArray(domains)) throw new Error('فهرست دامنه‌های کلادفلر معتبر نیست؛ دوباره بررسی کنید.');
  const existing = domains.find(domain => domain.hostname === hostname);
  if (existing && (existing.service !== name || existing.zone_id !== zone.id
      || (existing.environment && existing.environment !== 'production') || existing.enabled === false)) {
    throw new Error('این دامنه از قبل به تنظیمات یا برنامهٔ دیگری متصل است؛ نصب‌کننده آن را جایگزین نمی‌کند. یک زیردامنهٔ خالی انتخاب کنید.');
  }
  const records = await api.list(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
  if (!existing && records.length) throw new Error('برای این نام از قبل رکورد DNS وجود دارد؛ چیزی حذف یا جایگزین نمی‌شود. یک زیردامنهٔ خالی انتخاب کنید.');
  return { hostname, zoneId: zone.id, connected: !!existing, certificateIssued: !!existing?.cert_id };
}

export async function connectDomain(api, accountId, name, hostname) {
  const plan = await inspectDomain(api, accountId, name, hostname);
  if (!plan) return null;
  const worker = await inspect(api, accountId, name);
  if (worker.mode !== 'update') throw new Error('ابتدا انتشار پیام‌رسان باید کامل شود.');
  if (!plan.connected) {
    // shortcut: Wrangler's guarded endpoint, replace when the public API supports conditional attachment.
    await api.request(`/accounts/${accountId}/workers/scripts/${name}/domains/records`, {
      method: 'PUT', json: {
        override_scope: false, override_existing_origin: false, override_existing_dns_record: false,
        origins: [{ hostname: plan.hostname, zone_id: plan.zoneId, enabled: true, previews_enabled: false }],
      },
    });
  }
  const result = await inspectDomain(api, accountId, name, plan.hostname);
  if (!result?.connected) throw new Error('کلادفلر هنوز اتصال دامنه را تأیید نکرده است. آدرس workers.dev فعال می‌ماند؛ دوباره بررسی کنید.');
  return { ...result, url: `https://${result.hostname}` };
}
