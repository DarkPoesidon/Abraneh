const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const vm = require('node:vm');

const SOURCES = [
  ...['index.html', 'app.js', 'extras.js', 'admin.js', 'calls.js', 'media.js', 'security.js', 'backup.js', 'secure.js', 'updates.js'].map(name => 'public/' + name),
  ...readdirSync('src').filter(name => name.endsWith('.ts')).map(name => 'src/' + name),
];
const source = readFileSync('public/i18n.js', 'utf8');
const dictionary = source.slice(source.indexOf('const EN = {') + 'const EN = '.length, source.indexOf('\n  };', source.indexOf('const EN = {')) + 4);
const EN = vm.runInNewContext('(' + dictionary + ')');
const FA = /[؀-ۿ]/;

// Every interface fragment must either have a translation or be made of words that do.
const keys = Object.keys(EN).filter(key => key.length > 1).sort((a, b) => b.length - a.length);
const words = new RegExp('(?<![\\u0600-\\u06ff\\u200c])(?:' + keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\u0600-\\u06ff\\u200c])', 'g');
function fragments(file) {
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  const found = [];
  for (const raw of text.split(/\$\{[^{}]*\}|<[^>]*>|['"`]|\$\{|\}/)) for (const line of raw.split(/\r?\n/)) { const piece = line.trim(); if (FA.test(piece) && piece.length < 900) found.push(piece); }
  for (const match of text.matchAll(/(?:title|placeholder|aria-label|alt)="([^"$]*[؀-ۿ][^"$]*)"/g)) found.push(match[1].trim());
  return found;
}
test('the English dictionary covers the interface', () => {
  const missing = new Set();
  for (const file of SOURCES) for (const piece of fragments(file)) {
    if (/replace\(|\[يى\]|ك\//.test(piece)) continue; // Code that normalizes Persian text.
    if (Object.hasOwn(EN, piece)) continue;
    if (FA.test(piece.replace(words, ''))) missing.add(piece);
  }
  const known = new Set(['،', '؟', 'از', 'در', 'این', 'ک', 'ی', 'ی پیدا نشد.', '«', '»', 'Language / زبان', 'فارسی', 'فارسی / English']);
  const left = [...missing].filter(piece => !known.has(piece));
  assert.deepEqual(left, [], left.length + ' strings have no English');
});
test('no translation still contains Persian', () => {
  assert.deepEqual(Object.entries(EN).filter(([, value]) => FA.test(value)).map(([key]) => key), []);
});
test('signed-in people stay in Persian, and choosing English makes the page left to right', () => {
  assert.match(source, /let language = 'fa';/);
  assert.match(source, /navigator\.languages/, 'a new device follows its own language');
  assert.match(source, /root\.dir = 'ltr'/);
  assert.match(readFileSync('public/index.html', 'utf8'), /<script src="\/i18n\.js"><\/script>[\s\S]*<\/head>/, 'it must run before the page is drawn');
});

// Runs the real translator, with only what it needs from a page.
function englishTranslator() {
  const documentElement = { nodeType: 0 };
  const window = { WihmI18n: {}, alert() {}, confirm() {}, prompt() {} };
  const context = { window, localStorage: { getItem: key => key === 'wihm_language' ? 'en' : null, setItem() {} }, navigator: { languages: ['en'] }, location: { reload() {} }, document: { documentElement, addEventListener() {} }, MutationObserver: class { observe() {} }, Node: {}, NodeFilter: {}, console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return window.WihmI18n.translate;
}
test('text built from values reads as English, not word by word', () => {
  const translate = englishTranslator();
  const cases = {
    '۲ عضو · نقش شما: مالک': '2 members · Your role: Owner',
    '1 عضو · نقش شما: عضو': '1 member · Your role: Member',
    'ذخیرهٔ نام گروه': 'Save group name',
    'ذخیرهٔ نام کانال': 'Save channel name',
    'نام گروه': 'Group name',
    'خروج از کانال': 'Leave channel',
    'تیم طراحی، ۳ پیام نخوانده': 'تیم طراحی, 3 unread messages',
    '۱ پیام نخوانده': '1 unread message',
    '۵ مشترک': '5 subscribers',
    'sara در حال نوشتن': 'sara is typing',
    'مالکیت به «سارا» منتقل شود؟': 'Transfer ownership to "سارا"?',
    '«سارا» از گروه حذف شود؟': 'Remove "سارا" from the group?',
    'سرور به نسخهٔ 1.7.14 به‌روزرسانی شود؟': 'Update the server to version 1.7.14?',
    'پاسخ به سارا احمدی': 'Reply to سارا احمدی',
    '⌖ پیام سنجاق‌شده · از گروه خارج شو': '⌖ Pinned message · از گروه خارج شو',
    'دریافت فایل گزارش گروه.pdf': 'Download file گزارش گروه.pdf',
    'ضبط پیام صوتی': 'Record a voice message',
  };
  for (const [fa, en] of Object.entries(cases)) assert.equal(translate(fa), en);
});
