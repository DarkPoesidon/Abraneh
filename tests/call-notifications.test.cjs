const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
function worker(windows = []) {
  const listeners = {}, notifications = [], opened = [];
  const self = { location: { origin: 'https://chat.example' }, addEventListener: (name, fn) => { listeners[name] = fn; }, registration: { showNotification: async (title, options) => { notifications.push({ title, ...options }); } }, clients: { matchAll: async () => windows, openWindow: async url => { opened.push(url); } } };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, URL, Date });
  return { listeners, notifications, opened };
}
test('service worker suppresses expired call notifications and keeps active calls separate from message notifications', async () => {
  const w = worker(); let work;
  const push = payload => w.listeners.push({ data: { json: () => payload }, waitUntil: promise => { work = promise; } });
  push({ kind: 'call', chatId: 'private-chat', expiresAt: Date.now() - 1 }); assert.equal(w.notifications.length, 0);
  push({ kind: 'call', chatId: 'private-chat', expiresAt: Date.now() + 45000, title: 'Incoming call' }); await work;
  assert.equal(w.notifications[0].tag, 'call-private-chat'); assert.equal(w.notifications[0].data.kind, 'call');
  assert.equal(w.notifications[0].requireInteraction, true, 'a call must stay on screen until answered');
  push({ chatId: 'private-chat', title: 'Message' }); await work; assert.equal(w.notifications[1].requireInteraction, undefined);
});
test('call notification focuses an existing app without navigating away from a conversation, or opens the app', async () => {
  let focused = false, message, work;
  const w = worker([{ url: 'https://chat.example/', focus: async () => { focused = true; }, postMessage: data => { message = data; } }]);
  const click = { notification: { data: { kind: 'call', chatId: 'private-chat' }, close() {} }, waitUntil: promise => { work = promise; } };
  w.listeners.notificationclick(click); await work; assert.equal(focused, true); assert.equal(message.type, 'incoming-call'); assert.deepEqual(w.opened, []);
  const empty = worker(); empty.listeners.notificationclick(click); await work; assert.deepEqual(empty.opened, ['/?call=1']);
});
