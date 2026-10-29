import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cloudflare } from './cloudflare.mjs';
import { deploy, inspect, validAccount, validName, isNewer } from './deploy.mjs';

const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'application/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/fonts/Vazir-Variable.woff2':['fonts/Vazir-Variable.woff2','font/woff2'] };

export async function startServer({ uiDir, payloadDir, journal, makeApi = token => new Cloudflare(token), runDeploy = deploy, port = 0, version = 'development' }) {
  const session = randomBytes(32).toString('hex');
  let api = null, accounts = [], busy = false;
  let status = { state: 'idle', phase: null, url: null, error: null, result: null };
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, origin).pathname;
      // Android Chrome marks navigation from the Termux app as cross-site.
      // Only the public entry document may use that top-level navigation path.
      const entryNavigation = req.method === 'GET' && path === '/'
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
          || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']) && !entryNavigation)) return send(403, { error: 'این صفحه از نشانی نصب‌کننده باز نشده است.' });
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' || !FILES[path]) return send(404, { error: 'یافت نشد.' });
        const [name, type] = FILES[path];
        const content = await readFile(join(uiDir, name));
        res.writeHead(200, { 'Content-Type': type }); return res.end(content);
      }
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (supplied.length !== session.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session))) return send(401, { error: 'نشست معتبر نیست. نشانی کامل نمایش‌داده‌شده در نصب‌کننده را باز کنید.' });
      if (path === '/api/status' && req.method === 'GET') return send(200, { ...status, connected: !!api, accounts, version });
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(403, { error: 'درخواست معتبر نیست.' });
      if (busy) return send(409, { error: 'نصب در حال انجام است. تا پایان این مرحله صبر کنید.' });
      let body = '', size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return send(413, { error: 'حجم درخواست بیش از حد مجاز است.' });
        body += chunk.toString('utf8');
      }
      let input;
      try { input = JSON.parse(body); } catch { return send(400, { error: 'محتوای درخواست معتبر نیست.' }); }
      if (busy) return send(409, { error: 'عملیات دیگری در حال انجام است. کمی صبر کنید.' });
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'درخواست معتبر نیست.' });
      if (path === '/api/connect') {
        // Drop previous credentials even when replacement authentication fails.
        api = null; accounts = [];
        const candidate = makeApi(typeof input.token === 'string' ? input.token.trim() : '');
        busy = true;
        try {
          accounts = (await candidate.list('/accounts')).filter(account => validAccount(account.id)).map(({ id, name }) => ({ id, name }));
          if (!accounts.length) throw new Error('حسابی در دسترس نیست. مجوز Account Settings: Read و محدودهٔ حساب توکن را بررسی کنید.');
          api = candidate;
          status = { state: 'idle', phase: null, url: null, error: null, result: null };
        } finally { busy = false; }
        return send(200, { accounts });
      }
      if (path === '/api/disconnect') { api = null; accounts = []; return send(200, { disconnected: true }); }
      if (path === '/api/stop') {
        api = null; accounts = []; send(200, { stopped: true });
        server.close(); server.closeIdleConnections(); return;
      }
      if (!api) return send(401, { error: 'ابتدا حساب کلادفلر را متصل کنید.' });
      if (!validName(input.name) || !validAccount(input.accountId) || !accounts.some(account => account.id === input.accountId)) return send(400, { error: 'حساب را انتخاب کنید و نامی با ۳ تا ۴۰ حرف کوچک انگلیسی، عدد یا خط تیره بنویسید؛ نام با حرف شروع شود و با خط تیره تمام نشود.' });
      if (path === '/api/plan') {
        busy = true;
        try {
          const plan = await inspect(api, input.accountId, input.name);
          if (plan.installedVersion && isNewer(plan.installedVersion, version)) throw new Error('این نصب‌کننده قدیمی‌تر از نسخهٔ نصب‌شده است. آخرین بسته را دریافت کنید.');
          // Check D1 read permission before asking the user to start installation.
          await api.request(`/accounts/${input.accountId}/d1/database?per_page=10`);
          return send(200, { mode: plan.mode, name: input.name, installedVersion: plan.installedVersion, targetVersion: version, updaterEnabled: !!plan.settings?.bindings?.some(b=>b.name==='UPDATER') });
        } finally { busy = false; }
      }
      if (path === '/api/start') {
        busy = true;
        status = { state: 'running', phase: 'check', url: null, error: null, result: null };
        const activeApi = api;
        send(202, { started: true });
        void runDeploy({ api: activeApi, accountId: input.accountId, name: input.name, payloadDir, journal, enableUpdater: input.enableUpdater===true,
          progress(phase, url) { status = { ...status, phase, ...(url ? { url } : {}) }; },
        }).then(result => { status = { ...status, state: 'done', url: result.url, result }; })
          .catch(error => { status = { ...status, state: 'error', error: safeError(error) }; })
          .finally(() => { busy = false; });
        return;
      }
      send(404, { error: 'یافت نشد.' });
    } catch (error) { if (!res.headersSent) send(400, { error: safeError(error) }); else res.end(); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, session, url: `${origin}/#${session}`, close: () => { api = null; accounts = []; server.close(); server.closeAllConnections(); } };
}

function safeError(error) {
  // Only our Persian user-facing errors may cross into the browser.
  return /[\u0600-\u06ff]/.test(error?.message ?? '') ? error.message : 'این مرحله کامل نشد. فضای خالی دستگاه و ارتباط اینترنت را بررسی و دوباره تلاش کنید.';
}
