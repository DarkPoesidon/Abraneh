const { app, BrowserWindow, Menu, Tray, ipcMain, net, session, shell } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { serverOrigin, proxyRule } = require('./rules');
const { checkForUpdate } = require('./updates');

const STRINGS = {
  fa: {
    dir: 'rtl', title: 'سرور و پروکسی', intro: 'نشانی سروری که ابرانه روی آن اجرا می‌شود.', server: 'نشانی سرور', useProxy: 'استفاده از پروکسی', proxyType: 'نوع پروکسی', host: 'نشانی پروکسی (مثل 127.0.0.1)', port: 'پورت', proxyHelp: 'پروکسی SOCKS5 یا HTTP بدون نام کاربری و رمز. پروکسی MTProto فقط با تلگرام کار می‌کند.', connect: 'ذخیره و اتصال', back: 'بازگشت',
    badServer: 'نشانی سرور معتبر نیست. باید با https باشد.', badProxy: 'نشانی یا پورت پروکسی معتبر نیست.', noServer: 'اتصال برقرار نشد. نشانی سرور، اینترنت و پروکسی را بررسی کنید.', notServer: 'این نشانی سرور ابرانه نیست.', loadFailed: 'سرور باز نشد. اینترنت و نشانی را بررسی کنید.',
    open: 'باز کردن ابرانه', changeServer: 'سرور و پروکسی', checkUpdates: 'بررسی به‌روزرسانی', quit: 'خروج', noUpdate: 'آخرین نسخه را دارید.', updateReady: 'نسخهٔ {0} آماده است. دریافت و نصب شود؟', update: 'نصب', later: 'بعداً', badUpdate: 'فایل به‌روزرسانی معتبر نیست.', updateFailed: 'به‌روزرسانی انجام نشد',
  },
  en: {
    dir: 'ltr', title: 'Server and proxy', intro: 'The address of the server running Abraneh.', server: 'Server address', useProxy: 'Use a proxy', proxyType: 'Proxy type', host: 'Proxy address (like 127.0.0.1)', port: 'Port', proxyHelp: 'A SOCKS5 or HTTP proxy with no username or password. MTProto proxies only work with Telegram.', connect: 'Save and connect', back: 'Back',
    badServer: 'The server address is invalid. It must use https.', badProxy: 'The proxy address or port is invalid.', noServer: 'Could not connect. Check the server address, the internet and the proxy.', notServer: 'This address is not an Abraneh server.', loadFailed: 'The server did not open. Check the internet and the address.',
    open: 'Open Abraneh', changeServer: 'Server and proxy', checkUpdates: 'Check for updates', quit: 'Quit', noUpdate: 'You have the latest version.', updateReady: 'Version {0} is ready. Download and install it?', update: 'Install', later: 'Later', badUpdate: 'The update file is not valid.', updateFailed: 'The update failed',
  },
};
const t = (key, value = '') => (STRINGS[app.getLocale().startsWith('fa') ? 'fa' : 'en'][key]).replace('{0}', value);

let window = null, tray = null, config = {}, setupError = '';
const configFile = () => join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { config = JSON.parse(readFileSync(configFile(), 'utf8')); } catch { config = {}; }
}
const onServerPage = frameUrl => { try { return !!config.server && new URL(frameUrl).origin === config.server; } catch { return false; } };
const onSetupPage = frameUrl => String(frameUrl).startsWith('file:') && String(frameUrl).split('?')[0].endsWith('/setup.html');

function applyProxy(proxy) {
  const rule = proxy?.enabled ? proxyRule(proxy) : null;
  return session.defaultSession.setProxy(rule ? { proxyRules: rule } : { mode: 'direct' }).then(() => session.defaultSession.closeAllConnections());
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Same flag as the Android app: a hidden page must not mark messages as read.
function reportHidden() {
  if (!window || !onServerPage(window.webContents.getURL())) return;
  const hidden = !window.isVisible() || window.isMinimized();
  window.webContents.executeJavaScript(`window.wihmAppHidden=${hidden};window.dispatchEvent(new Event('wihm-app-visibility'));`).catch(() => {});
}

function openPage() {
  if (config.server) window.loadURL(config.server);
  else window.loadFile(join(__dirname, 'setup.html'));
}

function openSetup(error = '') {
  setupError = error;
  window.loadFile(join(__dirname, 'setup.html'));
  showWindow();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1100, height: 760, minWidth: 360, minHeight: 560, backgroundColor: '#1d2733', autoHideMenuBar: true, show: !process.argv.includes('--hidden'), icon: join(__dirname, 'tray.png'),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false },
  });
  window.on('close', event => { if (!app.isQuitting) { event.preventDefault(); window.hide(); } });
  for (const state of ['show', 'hide', 'minimize', 'restore']) window.on(state, reportHidden);
  const contents = window.webContents;
  contents.on('did-finish-load', reportHidden);
  contents.on('did-fail-load', (_event, code, _text, _url, isMainFrame) => { if (isMainFrame && code !== -3) openSetup(t('loadFailed')); });
  contents.on('will-navigate', (event, url) => {
    if (onServerPage(url) || onSetupPage(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  openPage();
}

function openExternal(url) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}

function createTray() {
  tray = new Tray(join(__dirname, 'tray.png'));
  tray.setToolTip('Abraneh');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('open'), click: showWindow },
    { label: t('changeServer'), click: () => openSetup() },
    { label: t('checkUpdates'), click: () => checkForUpdate(t, true) },
    { type: 'separator' },
    { label: t('quit'), click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

ipcMain.on('is-server-origin', (event, origin) => { event.returnValue = !!config.server && origin === config.server && onServerPage(event.senderFrame?.url); });
ipcMain.on('show-window', event => { if (onServerPage(event.senderFrame?.url)) showWindow(); });
ipcMain.on('open-setup', event => { if (onServerPage(event.senderFrame?.url)) openSetup(); });
ipcMain.on('setup-back', event => { if (onSetupPage(event.senderFrame?.url) && config.server) openPage(); });
ipcMain.handle('setup-load', event => {
  if (!onSetupPage(event.senderFrame?.url)) return null;
  const error = setupError;
  setupError = '';
  const language = app.getLocale().startsWith('fa') ? 'fa' : 'en';
  return { strings: STRINGS[language], language, server: config.server || '', proxy: config.proxy || {}, error };
});
ipcMain.handle('setup-connect', async (event, input) => {
  if (!onSetupPage(event.senderFrame?.url)) return { error: 'denied' };
  const server = serverOrigin(input?.server);
  if (!server) return { error: t('badServer') };
  const proxy = { enabled: input?.proxy?.enabled === true, type: input?.proxy?.type, host: String(input?.proxy?.host || '').trim(), port: Number(input?.proxy?.port) };
  if (proxy.enabled && !proxyRule(proxy)) return { error: t('badProxy') };
  await applyProxy(proxy);
  try {
    const response = await net.fetch(server + '/api/health', { signal: AbortSignal.timeout(10000) });
    const health = await response.json().catch(() => null);
    if (health?.app !== 'wihm-cloudflare') { await applyProxy(config.proxy); return { error: t('notServer') }; }
  } catch {
    await applyProxy(config.proxy);
    return { error: t('noServer') };
  }
  config = { server, proxy };
  writeFileSync(configFile(), JSON.stringify(config));
  openPage();
  return {};
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('com.wihm.messenger.desktop');
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { app.isQuitting = true; });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    loadConfig();
    const allowed = ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'];
    session.defaultSession.setPermissionRequestHandler((contents, permission, grant, details) => grant(allowed.includes(permission) && onServerPage(details.requestingUrl || contents.getURL())));
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => allowed.includes(permission) && onServerPage(origin));
    await applyProxy(config.proxy);
    createWindow();
    createTray();
    if (app.isPackaged) checkForUpdate(t, false);
  });
}
