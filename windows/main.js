/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, ipcMain, nativeImage, nativeTheme, net, screen, session, shell } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { serverOrigin, proxyRule, windowBounds, unreadLabel } = require('./rules');
const { checkForUpdate } = require('./updates');

const STRINGS = {
  fa: {
    dir: 'rtl', title: 'سرور و پروکسی', intro: 'نشانی سروری که ابرانه روی آن اجرا می‌شود.', server: 'نشانی سرور', useProxy: 'استفاده از پروکسی', proxyType: 'نوع پروکسی', host: 'نشانی پروکسی (مثل 127.0.0.1)', port: 'پورت', proxyHelp: 'پروکسی SOCKS5 یا HTTP بدون نام کاربری و رمز. پروکسی MTProto فقط با تلگرام کار می‌کند.', connect: 'ذخیره و اتصال', back: 'بازگشت',
    badServer: 'نشانی سرور معتبر نیست. باید با https باشد.', badProxy: 'نشانی یا پورت پروکسی معتبر نیست.', noServer: 'اتصال برقرار نشد. نشانی سرور، اینترنت و پروکسی را بررسی کنید.', notServer: 'این نشانی سرور ابرانه نیست.', loadFailed: 'سرور باز نشد. اینترنت و نشانی را بررسی کنید.',
    open: 'باز کردن ابرانه', changeServer: 'سرور و پروکسی', checkUpdates: 'بررسی به‌روزرسانی', quit: 'خروج', noUpdate: 'آخرین نسخه را دارید.', updateReady: 'نسخهٔ {0} آماده است. دریافت و نصب شود؟', update: 'نصب', later: 'بعداً', badUpdate: 'فایل به‌روزرسانی معتبر نیست.', updateFailed: 'به‌روزرسانی انجام نشد', downloading: 'در حال دریافت نسخهٔ جدید. پیشرفت آن روی نوار وظیفه دیده می‌شود و بعد از پایان، نصب شروع می‌شود.',
    cut: 'برش', copy: 'کپی', paste: 'چسباندن', selectAll: 'انتخاب همه', copyLink: 'کپی نشانی پیوند', addWord: 'افزودن به فرهنگ لغت', unread: '{0} پیام نخوانده',
  },
  en: {
    dir: 'ltr', title: 'Server and proxy', intro: 'The address of the server running Abraneh.', server: 'Server address', useProxy: 'Use a proxy', proxyType: 'Proxy type', host: 'Proxy address (like 127.0.0.1)', port: 'Port', proxyHelp: 'A SOCKS5 or HTTP proxy with no username or password. MTProto proxies only work with Telegram.', connect: 'Save and connect', back: 'Back',
    badServer: 'The server address is invalid. It must use https.', badProxy: 'The proxy address or port is invalid.', noServer: 'Could not connect. Check the server address, the internet and the proxy.', notServer: 'This address is not an Abraneh server.', loadFailed: 'The server did not open. Check the internet and the address.',
    open: 'Open Abraneh', changeServer: 'Server and proxy', checkUpdates: 'Check for updates', quit: 'Quit', noUpdate: 'You have the latest version.', updateReady: 'Version {0} is ready. Download and install it?', update: 'Install', later: 'Later', badUpdate: 'The update file is not valid.', updateFailed: 'The update failed', downloading: 'Downloading the new version. The taskbar shows its progress, and installation starts when it ends.',
    cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', copyLink: 'Copy link address', addWord: 'Add to dictionary', unread: '{0} unread messages',
  },
};
const t = (key, value = '') => (STRINGS[app.getLocale().startsWith('fa') ? 'fa' : 'en'][key]).replace('{0}', value);

let window = null, tray = null, config = {}, setupError = '';
// Windows drops a notification's click if nothing holds on to it.
const notifications = new Set();
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

// document.hasFocus() stays true in a hidden window, so only this process can tell.
function notify({ title, body, chatId } = {}) {
  if (window.isVisible() && !window.isMinimized() && window.isFocused()) return;
  const notification = new Notification({ title: String(title).slice(0, 200), body: String(body || '').slice(0, 500), icon: join(__dirname, 'tray.png') });
  notifications.add(notification);
  const forget = () => notifications.delete(notification);
  notification.on('close', forget);
  notification.on('failed', (_event, error) => { forget(); console.warn('Notification failed:', error); });
  notification.on('click', () => {
    forget();
    showWindow();
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(chatId)) return;
    const contents = window.webContents;
    const server = config.server;
    const openLegacy = () => {
      if (!contents.isDestroyed() && config.server === server) contents.loadURL(server + '/?chat=' + encodeURIComponent(chatId)).catch(() => {});
    };
    if (!onServerPage(contents.getURL()) || contents.isLoadingMainFrame()) {
      openLegacy();
      return;
    }
    contents.executeJavaScript(`window.wihmOpenNotifiedChat?.(${JSON.stringify(chatId)})`)
      .then(opened => { if (!opened) openLegacy(); }, openLegacy);
  });
  notification.show();
}

const DARK_BACKGROUND = '#1d2733', LIGHT_BACKGROUND = '#ffffff';
// Windows draws the title bar from the app's theme, so it matches the page instead of the system.
function applyTheme(light) {
  nativeTheme.themeSource = light ? 'light' : 'dark';
  window?.setBackgroundColor(light ? LIGHT_BACKGROUND : DARK_BACKGROUND);
  if (config.light !== light) { config.light = light; saveConfig(); }
}

// A red dot on the taskbar button, with the count in the tray's tooltip.
let unreadDot = null;
function showUnread(count) {
  if (!window) return;
  const label = unreadLabel(count);
  // shortcut: a dot instead of the number, since Electron cannot draw text on an icon; draw digits if users ask for them.
  unreadDot ||= nativeImage.createFromBitmap(dotBitmap(16), { width: 16, height: 16 });
  window.setOverlayIcon(label ? unreadDot : null, label ? t('unread', label) : '');
  tray?.setToolTip(label ? 'Abraneh · ' + t('unread', label) : 'Abraneh');
}
function dotBitmap(size) {
  const pixels = Buffer.alloc(size * size * 4), middle = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - middle) ** 2 + (y - middle) ** 2 > (size / 2) ** 2) continue;
    pixels.set([0x3b, 0x3b, 0xe5, 0xff], (y * size + x) * 4); // BGRA red
  }
  return pixels;
}

function saveConfig() {
  try { writeFileSync(configFile(), JSON.stringify(config)); } catch (error) { console.warn('Settings were not saved:', error); }
}
function rememberBounds() {
  if (!window || window.isMinimized()) return;
  config.window = { ...window.getNormalBounds(), maximized: window.isMaximized() };
  saveConfig();
}

// Copy, paste and spelling, which a browser window gives for free and Electron does not.
function contextMenu(contents, params) {
  const items = [];
  for (const word of params.dictionarySuggestions || []) items.push({ label: word, click: () => contents.replaceMisspelling(word) });
  if (params.misspelledWord) items.push({ label: t('addWord'), click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
  if (params.linkURL && /^https?:/.test(params.linkURL)) items.push({ label: t('copyLink'), click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
  const flags = params.editFlags || {};
  if (params.isEditable) items.push({ label: t('cut'), role: 'cut', enabled: flags.canCut });
  if (params.isEditable || params.selectionText) items.push({ label: t('copy'), role: 'copy', enabled: flags.canCopy });
  if (params.isEditable) items.push({ label: t('paste'), role: 'paste', enabled: flags.canPaste });
  if (params.isEditable) items.push({ label: t('selectAll'), role: 'selectAll' });
  while (items.at(-1)?.type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window });
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
  nativeTheme.themeSource = config.light ? 'light' : 'dark';
  const bounds = windowBounds(config.window, screen.getAllDisplays().map(display => display.workArea));
  window = new BrowserWindow({
    ...bounds, minWidth: 360, minHeight: 560, backgroundColor: config.light ? LIGHT_BACKGROUND : DARK_BACKGROUND, autoHideMenuBar: true, show: !process.argv.includes('--hidden'), icon: join(__dirname, 'tray.png'),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false },
  });
  if (config.window?.maximized) window.maximize();
  window.on('close', event => { rememberBounds(); if (!app.isQuitting) { event.preventDefault(); window.hide(); } });
  for (const state of ['show', 'hide', 'minimize', 'restore']) window.on(state, reportHidden);
  const contents = window.webContents;
  contents.on('did-finish-load', reportHidden);
  contents.on('did-fail-load', (_event, code, _text, _url, isMainFrame) => { if (isMainFrame && code !== -3) openSetup(t('loadFailed')); });
  contents.on('will-navigate', (event, url) => {
    if (onServerPage(url) || onSetupPage(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('context-menu', (_event, params) => contextMenu(contents, params));
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
    { label: t('checkUpdates'), click: () => checkForUpdate(t, true, window) },
    { type: 'separator' },
    { label: t('quit'), click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

ipcMain.on('is-server-origin', (event, origin) => { event.returnValue = !!config.server && origin === config.server && onServerPage(event.senderFrame?.url); });
ipcMain.on('show-window', event => { if (onServerPage(event.senderFrame?.url)) showWindow(); });
ipcMain.on('app-version', event => { event.returnValue = app.getVersion(); });
ipcMain.on('check-updates', event => { if (onServerPage(event.senderFrame?.url)) checkForUpdate(t, true, window); });
ipcMain.on('notify', (event, message) => { if (onServerPage(event.senderFrame?.url)) notify(message); });
ipcMain.on('set-theme', (event, light) => { if (onServerPage(event.senderFrame?.url) && typeof light === 'boolean') applyTheme(light); });
ipcMain.on('set-unread', (event, count) => { if (onServerPage(event.senderFrame?.url)) showUnread(count); });
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
  config = { ...config, server, proxy };
  saveConfig();
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
    // The app can stay open in the tray for weeks, so one check at startup is not enough.
    if (app.isPackaged) {
      checkForUpdate(t, false, window);
      setInterval(() => checkForUpdate(t, false, window), 6 * 3600_000);
    }
  });
}
