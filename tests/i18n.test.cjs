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
  const known = new Set(['،', '؟', 'از', 'در', 'این', 'ک', 'ی', 'ی پیدا نشد.', '«', '»', 'Language / زبان', 'فارسی']);
  const left = [...missing].filter(piece => !known.has(piece));
  assert.deepEqual(left, [], left.length + ' strings have no English');
});
test('no translation still contains Persian', () => {
  assert.deepEqual(Object.entries(EN).filter(([, value]) => FA.test(value)).map(([key]) => key), []);
});
test('Persian is the default, and choosing English makes the page left to right', () => {
  assert.match(source, /let language = 'fa';/);
  assert.match(source, /root\.dir = 'ltr'/);
  assert.match(readFileSync('public/index.html', 'utf8'), /<script src="\/i18n\.js"><\/script>[\s\S]*<\/head>/, 'it must run before the page is drawn');
});
