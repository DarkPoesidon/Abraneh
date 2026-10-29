const $ = id => document.getElementById(id);
// Official Cloudflare template URL: the account owner still approves the token.
const tokenTemplate = new URL('https://dash.cloudflare.com/profile/api-tokens');
tokenTemplate.searchParams.set('permissionGroupKeys', JSON.stringify([
  { key: 'account_settings', type: 'read' }, { key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' },
]));
tokenTemplate.searchParams.set('accountId', '*');
tokenTemplate.searchParams.set('zoneId', 'all');
tokenTemplate.searchParams.set('name', 'WIHM Installer');
$('token-link').href = tokenTemplate.href;
const session = location.hash.slice(1) || sessionStorage.getItem('wihm-session') || '';
if (location.hash) { sessionStorage.setItem('wihm-session', session); history.replaceState(null, '', '/'); }
let config = null;
try { config = JSON.parse(sessionStorage.getItem('wihm-config') || 'null'); } catch { sessionStorage.removeItem('wihm-config'); }
let pollTimer, currentResult;
const phases = ['check', 'address', 'database', 'schema', 'assets', 'publish', 'verify'];

async function api(path, data) {
  let response;
  try {
    response = await fetch('/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + session, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch { throw new Error('ارتباط با نصب‌کننده قطع شد. پنجرهٔ نصب را باز نگه دار و دوباره تلاش کن.'); }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'درخواست انجام نشد. دوباره تلاش کن.');
  return body;
}
function panel(name, focus = true) {
  for (const id of ['connect', 'configure', 'progress', 'closed']) $(id + '-panel').hidden = id !== name;
  const index = ['connect', 'configure', 'progress'].indexOf(name);
  [...$('steps').children].forEach((step, i) => { if (i === index) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current'); });
  if (focus) $(name + '-panel').querySelector('h1').focus();
}
function errorAt(id, error) { $(id).textContent = error.message; $(id).hidden = false; }
function busy(button, value, message, original) { button.disabled = value; button.textContent = value ? message : original; button.setAttribute('aria-busy', String(value)); }
function fillAccounts(accounts) {
  $('account').replaceChildren(...accounts.map(account => { const option = document.createElement('option'); option.value = account.id; option.textContent = account.name; return option; }));
  if (config && accounts.some(account => account.id === config.accountId)) $('account').value = config.accountId;
  if (config?.name) $('name').value = config.name;
}
function invalidatePlan() { $('review').hidden = true; $('configure-error').hidden = true; }
$('configure-form').addEventListener('input', invalidatePlan);
$('configure-form').addEventListener('change', invalidatePlan);
$('toggle-token').onclick = () => { const show = $('token').type === 'password'; $('token').type = show ? 'text' : 'password'; $('toggle-token').textContent = show ? 'پنهان' : 'نمایش'; $('toggle-token').setAttribute('aria-pressed', String(show)); };
$('connect-form').onsubmit = async event => {
  event.preventDefault(); $('connect-error').hidden = true; $('token').removeAttribute('aria-invalid');
  busy($('connect-button'), true, 'در حال اتصال…', 'اتصال حساب');
  const token = $('token').value;
  try { const result = await api('connect', { token }); $('token').value = ''; fillAccounts(result.accounts); panel('configure'); }
  catch (error) { errorAt('connect-error', error); $('token').setAttribute('aria-invalid', 'true'); }
  finally { busy($('connect-button'), false, '', 'اتصال حساب'); }
};
$('change-account').onclick = async () => {
  try { await api('disconnect', {}); invalidatePlan(); panel('connect'); }
  catch (error) { errorAt('configure-error', error); }
};
$('configure-form').onsubmit = async event => {
  event.preventDefault(); invalidatePlan(); $('name').removeAttribute('aria-invalid');
  busy($('plan-button'), true, 'در حال بررسی…', 'بررسی نام و حساب');
  const candidate = { accountId: $('account').value, name: $('name').value.trim() };
  try {
    const plan = await api('plan', candidate);
    // If input changed during a request, its response no longer describes the form.
    if (candidate.accountId !== $('account').value || candidate.name !== $('name').value.trim()) return;
    config = candidate; sessionStorage.setItem('wihm-config', JSON.stringify(config));
    $('review-name').textContent = config.name;
    $('review-title').textContent = plan.mode === 'update' ? `به‌روزرسانی از ${plan.installedVersion} به ${plan.targetVersion}` : `نصب نسخهٔ ${plan.targetVersion}`;
    $('review-description').textContent = plan.mode === 'update' ? 'نصب قبلی پیدا شد. نسخهٔ برنامه به‌روزرسانی می‌شود و پیام‌ها و حساب‌های قبلی باقی می‌مانند.' : 'با زدن دکمهٔ زیر، پیام‌رسان و دیتابیس آن روی حساب شما ساخته می‌شود.';
    $('review-data').textContent = plan.mode === 'update' ? 'حفظ دیتابیس و کلید قبلی' : 'ساخت خودکار';
    $('install-button').textContent = plan.mode === 'update' ? 'به‌روزرسانی پیام‌رسان' : 'نصب پیام‌رسان';
    $('review').hidden = false; $('install-button').focus();
  } catch (error) { errorAt('configure-error', error); $('name').setAttribute('aria-invalid', 'true'); }
  finally { busy($('plan-button'), false, '', 'بررسی نام و حساب'); }
};
async function start() {
  if (!config) { panel('configure'); return; }
  $('install-error').hidden = true; $('result').hidden = true;
  $('install-button').disabled = true; $('retry').disabled = true;
  try { await api('start', config); panel('progress'); await poll(); }
  catch (error) { panel('progress'); showFailure(error.message); }
  finally { $('install-button').disabled = false; $('retry').disabled = false; }
}
$('install-button').onclick = start;
$('retry').onclick = start;
$('back-configure').onclick = () => { clearTimeout(pollTimer); invalidatePlan(); panel('configure'); };
function showFailure(message) { $('install-error-text').textContent = message; $('install-error').hidden = false; $('progress-title').textContent = 'نصب متوقف شد.'; $('progress-intro').textContent = 'مشکل را برطرف کن و از همین‌جا ادامه بده.'; }
function renderStatus(status) {
  const current = phases.indexOf(status.phase);
  [...$('progress-list').children].forEach((item, i) => {
    item.dataset.state = i < current || status.state === 'done' ? 'done' : i === current ? (status.state === 'error' ? 'error' : 'active') : '';
  });
  if (status.state === 'running') {
    $('progress-title').textContent = 'در حال آماده‌کردن پیام‌رسان…';
    $('current-status').textContent = $('progress-list').children[current]?.textContent ?? 'در حال نصب…';
  } else $('current-status').textContent = '';
  if (status.state === 'error') showFailure(status.error);
  if (status.state === 'done') {
    currentResult = status.result;
    $('progress-title').textContent = status.result.verified ? 'نصب تمام شد.' : 'منتشر شد؛ بررسی اتصال باقی ماند.';
    $('progress-intro').textContent = status.result.verified ? 'سرور و دیتابیس پاسخ می‌دهند. حالا می‌توانی وارد پیام‌رسان شوی.' : 'کلادفلر انتشار را تأیید کرده، اما این دستگاه هنوز پاسخ سالم نگرفته است.';
    $('result-title').textContent = status.result.verified ? `نسخهٔ ${status.result.version || ''} آماده است.` : 'لینک پیام‌رسان را بررسی کن.';
    $('result-description').textContent = status.result.verified ? status.result.mode === 'update' ? 'سرور به‌روز شد و اطلاعات قبلی حفظ شدند. پیام‌رسان را روی دستگاه‌ها کامل ببند و دوباره باز کن تا رابط تازه هم دریافت شود؛ در صورت نیاز صفحه را یک بار نوسازی کن.' : 'لینک را باز کن و حساب کاربری پیام‌رسانت را بساز. برای دعوت دیگران همین لینک را بفرست.' : 'ممکن است فعال‌شدن آدرس کمی زمان ببرد یا شبکهٔ فعلی به workers.dev دسترسی نداشته باشد. لینک را با شبکهٔ دیگر هم بررسی کن. نصب دوباره با همین نام اطلاعات را حفظ می‌کند.';
    // URLs come only from our fixed workers.dev deployment path; never render API HTML.
    if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(status.result.url)) return showFailure('آدرس خروجی معتبر نیست.');
    for (const id of ['app-url', 'open-app']) $(id).href = status.result.url;
    $('app-url').textContent = status.result.url;
    $('admin-code').value = status.result.adminCode || '';
    $('result').hidden = false;
    if (!status.result.verified) $('progress-list').lastElementChild.dataset.state = 'error';
  }
}
async function poll() {
  clearTimeout(pollTimer);
  try {
    const status = await api('status'); renderStatus(status);
    if (status.state === 'running') pollTimer = setTimeout(poll, 1000);
  } catch (error) {
    $('current-status').textContent = error.message + ' نصب ممکن است هنوز در حال اجرا باشد؛ منتظر اتصال مجدد می‌مانیم.';
    pollTimer = setTimeout(poll, 2500);
  }
}
$('copy-url').onclick = async () => {
  try { await navigator.clipboard.writeText(currentResult.url); $('copy-status').textContent = 'لینک کپی شد.'; }
  catch { $('copy-status').textContent = 'روی لینک نگه دار و «کپی» را انتخاب کن.'; }
};
$('save-receipt').onclick = () => {
  const receipt = `WIHM Cloudflare\n${currentResult.url}\nAccount: ${config?.accountId ?? ''}\nWorker: ${config?.name ?? ''}\nServer check: ${currentResult.verified ? 'passed' : 'pending'}\n`;
  const url = URL.createObjectURL(new Blob([receipt], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'WIHM-installation.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('finish').onclick = async () => {
  try { await api('stop', {}); clearTimeout(pollTimer); sessionStorage.removeItem('wihm-session'); panel('closed'); }
  catch (error) { $('copy-status').textContent = error.message; }
};
async function init() {
  if (!/^[a-f0-9]{64}$/.test(session)) { $('session-error').hidden = false; $('connect-button').disabled = true; return; }
  try {
    const status = await api('status');
    if (status.connected) fillAccounts(status.accounts);
    if (['running', 'error', 'done'].includes(status.state)) { panel('progress', false); await poll(); }
    else if (status.connected) panel('configure', false);
  } catch (error) { errorAt('connect-error', error); }
}
init();

$('copy-admin-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('admin-code').value); $('copy-status').textContent = 'کد مدیریت کپی شد؛ فقط در حساب خودتان وارد کنید.'; } catch { $('admin-code').select(); } });
