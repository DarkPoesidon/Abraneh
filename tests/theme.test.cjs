const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const FILES = ['public/style.css', 'public/index.html', 'public/manifest.json', 'public/app.js', 'public/media.js', 'public/calls.js', 'public/admin.js', 'android/app/src/main/res/values/colors.xml'];

function hue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 25) return null; // Too grey to read as a color.
  if (max === r) return (60 * ((g - b) / d) + 360) % 360;
  return max === g ? 60 * ((b - r) / d) + 120 : 60 * ((r - g) / d) + 240;
}

test('no purple anywhere in the app', () => {
  const found = [];
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/#([0-9a-f]{6})\b/gi)) {
      const [r, g, b] = [0, 2, 4].map(at => parseInt(match[1].slice(at, at + 2), 16)), h = hue(r, g, b);
      if (h !== null && h >= 240 && h <= 320) found.push(file + ' ' + match[0]);
    }
    for (const match of text.matchAll(/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/g)) {
      const h = hue(+match[1], +match[2], +match[3]);
      if (h !== null && h >= 240 && h <= 320) found.push(file + ' ' + match[0]);
    }
  }
  assert.deepEqual(found, []);
});

test('avatar colors leave out violet', () => {
  const hues = readFileSync('public/app.js', 'utf8').match(/AVATAR_HUES=\[([\d,]+)\]/)[1].split(',').map(Number);
  assert.ok(hues.length > 3);
  for (const value of hues) assert.ok(value < 240 || value > 320, String(value));
});
