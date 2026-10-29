const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(data)) });
const message = (id, text = id, createdAt = 1) => ({ id, text, createdAt, senderId: 'other', senderName: 'Other' });
const initialChats = () => [{ id: 'a', title: 'Chat A', type: 'dm', updatedAt: 1 }, { id: 'b', title: 'Chat B', type: 'dm', updatedAt: 1 }];

function harness(handler, { storageEntries = [], failStorage = false, online = true } = {}) {
  function element() {
    let html = '', text = ''; const classes=new Set(),attributes={};
    return {
      style: {}, dataset:{}, setAttribute(key,value){attributes[key]=value;},getAttribute(key){return attributes[key];}, children: [], listeners: {}, value: '', hidden: false, disabled: false, scrollTop: 0,
      classList: { add(...values){values.forEach(value=>classes.add(value));},remove(...values){values.forEach(value=>classes.delete(value));},contains(value){return classes.has(value);} },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      appendChild(child) { this.children.push(child); }, focus() {},
      get scrollHeight() { return this.children.length * 40; },
      set innerHTML(value) { html = value; text = ''; this.children = []; }, get innerHTML() { return html; },
      set textContent(value) { text = String(value); html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); this.children = []; }, get textContent() { return text; },
    };
  }
  const elements = new Map([...readFileSync('public/index.html', 'utf8').matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
  const sockets = [], timers = new Map(), intervals = new Map(), windowEvents = {}, documentEvents = {}, calls = [];
  let timerId = 0;
  class WebSocket {
    static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const storage = new Map([['cf_msg_token', 'session-token'], ['cf_msg_user', JSON.stringify({ id: 'self', username: 'self', displayName: 'Self' })], ...storageEntries]);
  const navigator = { onLine: online };
  const document = { visibilityState: 'visible', getElementById: id => elements.get(id) || null, createElement: element, addEventListener: (type, fn) => { documentEvents[type] = fn; } };
  const sandbox = {
    console, URLSearchParams, WebSocket, navigator, document,
    window: { innerWidth: 1200, addEventListener: (type, fn) => { windowEvents[type] = fn; } },
    location: { protocol: 'http:', host: 'localhost', reload() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => { if (failStorage) throw new Error('QuotaExceededError'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; intervals.set(id, { fn, delay }); return id; }, clearInterval: id => intervals.delete(id),
    fetch: (path, options) => { calls.push({ path, options }); return handler(path, options); },
    alert() {}, confirm: () => true,
  };
  vm.runInNewContext(readFileSync('public/app.js', 'utf8'), sandbox);
  return {
    elements, sockets, timers, intervals, windowEvents, documentEvents, document, calls, storage, navigator, window:sandbox.window,
    el: id => elements.get(id),
    click: id => elements.get(id).listeners.click(),
    open: index => elements.get('chats-list').children[index].listeners.click(),
    texts: () => elements.get('messages-container').children.map(child => child.innerHTML).join(''),
    async timeout(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `Expected timeout ${delay}`); timers.delete(entry[0]); await entry[1].fn(); await settle(); },
    async poll() { for (const interval of [...intervals.values()]) if (interval.delay === 5000) await interval.fn(); await settle(); },
  };
}

test('late history never overwrites the active room, and live messages survive snapshot delivery', async () => {
  const pending = new Map();
  const app = harness(path => path === '/api/chats' ? reply(initialChats()) : new Promise(resolve => pending.set(path, resolve)));
  await settle();
  const a = app.open(0), b = app.open(1);
  pending.get('/api/chats/b/messages?limit=50')(reply([message('b1', 'History B')])); await b;
  pending.get('/api/chats/a/messages?limit=50')(reply([message('a1', 'History A')])); await a;
  assert.equal(app.el('active-chat-title').textContent, 'Chat B');
  assert.match(app.texts(), /History B/); assert.doesNotMatch(app.texts(), /History A/);
  const reopening = app.open(1);
  app.sockets.at(-1).onmessage({ data: JSON.stringify({ event: 'new_message', message: { ...message('live', 'Live message', 2), chatId: 'b' } }) });
  pending.get('/api/chats/b/messages?limit=50')(reply([message('b1', 'History B')])); await reopening;
  assert.match(app.texts(), /History B/); assert.match(app.texts(), /Live message/);
  app.sockets.at(-1).onmessage({ data: JSON.stringify({ event: 'new_message', message: { ...message('live', 'Live message', 2), chatId: 'b' } }) });
  assert.equal(app.el('messages-container').children.length, 2);
});

test('socket reconnects with backoff, catches up history, and old callbacks cannot affect a new room', async () => {
  let history = [message('one')];
  const app = harness(path => reply(path === '/api/chats' ? initialChats() : history));
  await settle(); await app.open(0);
  const old = app.sockets.at(-1), oldClose = old.onclose;
  old.onclose(); await app.timeout(1000);
  assert.equal(app.sockets.length, 2);
  app.sockets.at(-1).onclose(); await app.timeout(2000);
  assert.equal(app.sockets.length, 3);
  history = [message('one'), message('missed', 'Recovered while disconnected', 2)];
  app.sockets.at(-1).onopen(); await settle();
  assert.match(app.texts(), /Recovered while disconnected/);
  await app.open(1); oldClose();
  assert.equal(app.timers.size, 0);
  assert.equal(app.el('active-chat-title').textContent, 'Chat B');
  old.onmessage({ data: JSON.stringify({ event: 'new_message', message: { ...message('stale', 'Stale socket event'), chatId: 'a' } }) });
  assert.doesNotMatch(app.texts(), /Stale socket event/);
});

test('polling discovers new chats and inactive previews without reloading and preserves filtering', async () => {
  let chats = initialChats();
  const app = harness(path => reply(path === '/api/chats' ? chats : []));
  await settle();
  chats = [...chats, { id: 'new', title: 'New group', type: 'group', updatedAt: 5, lastMessage: { id: 'new-msg', text: 'Incoming elsewhere', createdAt: 5 } }];
  await app.poll();
  assert.equal(app.el('chats-list').children.length, 3);
  assert.match(app.el('chats-list').children[0].innerHTML, /Incoming elsewhere/);
  app.el('chat-filter-input').value = 'Chat A';
  app.el('chat-filter-input').listeners.input(); await app.poll();
  assert.equal(app.el('chats-list').children.length, 1);
  const before = app.calls.length; app.document.visibilityState = 'hidden'; await app.poll();
  assert.equal(app.calls.length, before);
});

test('older pages merge without duplicates and stop at the end', async () => {
  const latest = Array.from({ length: 50 }, (_, i) => message(`m${String(i + 10).padStart(3, '0')}`, `Text ${i + 10}`, 100));
  const older = Array.from({ length: 10 }, (_, i) => message(`m${String(i).padStart(3, '0')}`, `Text ${i}`, 100));
  const app = harness(path => reply(path === '/api/chats' ? initialChats() : path.includes('&before=') ? older : latest));
  await settle(); await app.open(0);
  assert.equal(app.el('btn-load-older').hidden, false);
  app.click('btn-load-older'); await settle();
  assert.equal(app.el('messages-container').children.length, 60);
  assert.equal(app.el('btn-load-older').hidden, true);
  assert.ok(app.calls.some(call => call.path.endsWith('before=100%3Am010')));
});

test('group picker creates a group and adds members to the selected group', async () => {
  let chats = initialChats();
  const posts = [];
  const users = [{ id: 'friend', username: 'friend', displayName: 'دوست' }];
  const app = harness((path, options) => {
    if (options.method === 'POST') {
      posts.push({ path, body: JSON.parse(options.body) });
      if (path === '/api/chats') { chats = [...chats, { id: 'group', title: 'گروه ما', type: 'group', role: 'owner', updatedAt: 5 }]; return reply({ id: 'group' }, 201); }
      return reply(users);
    }
    if (path === '/api/chats') return reply(chats);
    if (path.includes('/users/search')) return reply(users);
    if (path.endsWith('/members')) return reply([{ id: 'self' }]);
    return reply([]);
  });
  await settle(); app.click('btn-open-search'); app.click('btn-group-mode');
  assert.equal(app.el('group-title-input').hidden, false);
  app.el('group-title-input').value = 'گروه ما';
  app.el('modal-search-input').value = 'friend'; app.el('modal-search-input').listeners.input({ target: { value: 'friend' } }); await app.timeout(300);
  await app.el('search-results-list').children[0].listeners.click();
  assert.equal(app.el('btn-save-group').disabled, false);
  await app.click('btn-save-group'); await settle();
  assert.deepEqual(posts[0], { path: '/api/chats', body: { type: 'group', title: 'گروه ما', memberIds: ['friend'] } });
  assert.equal(app.el('active-chat-title').textContent, 'گروه ما');
  assert.equal(app.el('btn-add-members').style.display, 'inline-flex');
  await app.click('btn-add-members');
  app.el('modal-search-input').listeners.input({ target: { value: 'friend' } }); await app.timeout(300);
  await app.el('search-results-list').children[0].listeners.click(); await app.click('btn-save-group');
  assert.deepEqual(posts[1], { path: '/api/chats/group/members', body: { userIds: ['friend'] } });
});

test('expired sessions stop polling and reconnecting', async () => {
  let expired = false;
  const app = harness(path => expired ? reply({ error: 'Expired' }, 401) : reply(path === '/api/chats' ? initialChats() : []));
  await settle(); await app.open(0); expired = true; await app.poll();
  assert.equal(app.el('auth-overlay').style.display, 'flex');
  assert.equal(app.intervals.size, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.sockets.at(-1).readyState, 3);
});

test('offline outbox survives a reload and a server acknowledgement replaces the pending bubble exactly once', async () => {
  const handler = path => reply(path === '/api/chats' ? initialChats() : []);
  const offline = harness(handler, { online: false });
  await settle(); await offline.open(0);
  offline.el('message-input').value = 'پیام آفلاین'; offline.click('btn-send-message');
  assert.equal(offline.el('message-input').value, '');
  const stored = JSON.parse(offline.storage.get('cf_msg_outbox_self'));
  assert.equal(stored.length, 1); assert.equal(stored[0].text, 'پیام آفلاین');
  assert.match(offline.texts(), /در انتظار اتصال/);
  const restored = harness(handler, { online: false, storageEntries: [...offline.storage] });
  await settle(); await restored.open(0);
  assert.match(restored.texts(), /پیام آفلاین/);
  restored.navigator.onLine = true; restored.windowEvents.online(); await settle();
  const socket = restored.sockets.at(-1);
  const sent = socket.sent.find(action => action.action === 'send_message');
  assert.equal(sent.clientMsgId, stored[0].clientMsgId);
  const confirmed = { id: 'server-message', chatId: 'a', senderId: 'self', senderName: 'Self', text: sent.text, createdAt: Date.now(), clientMsgId: sent.clientMsgId };
  socket.onmessage({ data: JSON.stringify({ event: 'new_message', message: confirmed }) });
  socket.onmessage({ data: JSON.stringify({ event: 'new_message', message: confirmed }) });
  assert.equal(restored.el('messages-container').children.length, 1);
  assert.match(restored.texts(), /ارسال شد/);
  assert.deepEqual(JSON.parse(restored.storage.get('cf_msg_outbox_self')), []);
});

test('outbox storage failure preserves the composer and does not attempt an untracked send', async () => {
  const app = harness(path => reply(path === '/api/chats' ? initialChats() : []), { failStorage: true });
  await settle(); await app.open(0);
  app.el('message-input').value = 'متن باید بماند'; app.click('btn-send-message');
  assert.equal(app.el('message-input').value, 'متن باید بماند');
  assert.match(app.el('chat-error').textContent, /فضای ذخیره/);
  assert.ok(app.sockets.every(socket => !socket.sent.some(action => action.action === 'send_message')));
});

test('hidden tabs report delivery but not reading; visibility and receipts update sender status', async () => {
  const posts = [];
  const history = [{ ...message('mine', 'Own message', 1), chatId: 'a', senderId: 'self' }];
  const app = harness((path, options = {}) => {
    if (path === '/api/chats') return reply(initialChats());
    if (path.endsWith('/receipts') && options.method === 'POST') { const body = JSON.parse(options.body); posts.push(body); return reply({ userId: 'self', readAt: body.read ? 1 : 0 }); }
    if (path.endsWith('/receipts')) return reply([]);
    return reply(history);
  });
  await settle(); await app.open(0); await settle(); posts.length = 0;
  app.document.visibilityState = 'hidden';
  app.sockets.at(-1).onmessage({ data: JSON.stringify({ event: 'new_message', message: { ...message('incoming', 'Received hidden', 2), chatId: 'a' } }) });
  await settle(); assert.ok(posts.length); assert.ok(posts.every(post => post.read === false));
  app.document.visibilityState = 'visible'; app.documentEvents.visibilitychange(); await settle();
  assert.ok(posts.some(post => post.read === true));
  app.sockets.at(-1).onmessage({ data: JSON.stringify({ event: 'receipt', chatId: 'a', userId: 'other', deliveredAt: 1, deliveredId: 'mine', readAt: 0, readId: '' }) });
  assert.match(app.texts(), /تحویل شد/);
  app.sockets.at(-1).onmessage({ data: JSON.stringify({ event: 'receipt', chatId: 'a', userId: 'other', deliveredAt: 1, deliveredId: 'mine', readAt: 1, readId: 'mine' }) });
  assert.match(app.texts(), /خوانده شد/);
});

test('explicit logout clears this account outbox even if the server has already expired the session', async () => {
  const queued = [{ chatId: 'a', clientMsgId: 'logout-queued', text: 'private pending text', createdAt: 1 }];
  const app = harness(path => path === '/api/auth/logout' ? reply({ error: 'نشست پایان یافته' }, 401) : reply(path === '/api/chats' ? initialChats() : []), {
    online: false, storageEntries: [['cf_msg_outbox_self', JSON.stringify(queued)], ['cf_msg_outbox_someone_else', 'other-account-data']],
  });
  await settle(); await app.click('btn-logout');
  assert.equal(app.storage.has('cf_msg_outbox_self'), false);
  assert.equal(app.storage.get('cf_msg_outbox_someone_else'), 'other-account-data');
  assert.equal(app.storage.has('cf_msg_token'), false);
});
test('a delayed history response cannot resurrect edited/deleted text or stale reply quotes', async () => {
  let historyResolve;
  const original={...message('original','متن قدیمی'),chatId:'a',revision:0};
  const replyMessage={...message('reply','پاسخ',2),chatId:'a',revision:0,replyToId:'original',replyTo:{id:'original',text:'متن قدیمی',senderName:'Other'}};
  const app=harness(path=>path==='/api/chats'?reply(initialChats()):path.includes('/messages')?new Promise(resolve=>historyResolve=resolve):reply([]));
  await settle();app.open(0);await settle();
  const socket=app.sockets.at(-1);
  socket.onmessage({data:JSON.stringify({event:'new_message',message:original})});
  socket.onmessage({data:JSON.stringify({event:'new_message',message:replyMessage})});
  socket.onmessage({data:JSON.stringify({event:'message_changed',message:{...original,text:'ویرایش تازه',revision:1,editedAt:3}})});
  assert.ok(app.texts().includes('ویرایش تازه'));assert.ok(!app.texts().includes('متن قدیمی'));
  socket.onmessage({data:JSON.stringify({event:'message_changed',message:{...original,text:'',revision:2,deletedAt:4}})});
  historyResolve(reply([original,replyMessage]));await settle();
  assert.ok(!app.texts().includes('متن قدیمی'));assert.ok(!app.texts().includes('ویرایش تازه'));assert.ok(app.texts().includes('حذف شده'));
});

test('chat access revocation preserves account login and fails pending messages without reconnecting the room',async()=>{
  const app=harness(path=>reply(path==='/api/chats'?initialChats():[]));await settle();await app.open(0);await settle();
  app.el('message-input').value='پیام صف';await app.click('btn-send-message');
  const socket=app.sockets.at(-1);socket.onmessage({data:JSON.stringify({event:'chat_access_revoked',chatId:'a'})});await settle();
  assert.equal(app.storage.get('cf_msg_token'),'session-token');assert.ok(app.el('chat-error').textContent.includes('تغییر'));
  const pending=JSON.parse(app.storage.get('cf_msg_outbox_self'));assert.equal(pending[0].failed,true);
  assert.equal([...app.timers.values()].filter(timer=>timer.delay===1000).length,0);
});
test('membership removed while offline fails that room outbox after polling, without ending the account session',async()=>{
  let list=initialChats();const app=harness(path=>reply(path==='/api/chats'?list:[]));await settle();await app.open(0);await settle();
  app.el('message-input').value='بعد از قطع دسترسی';await app.click('btn-send-message');list=list.filter(chat=>chat.id!=='a');await app.poll();
  assert.equal(JSON.parse(app.storage.get('cf_msg_outbox_self'))[0].failed,true);assert.equal(app.storage.get('cf_msg_token'),'session-token');
});


test('desktop rail preserves the draft and selected chat, persists across reload, and restores mobile list navigation',async()=>{
  const handler=path=>reply(path==='/api/chats'?initialChats():[]),app=harness(handler);
  await settle();await app.open(0);app.el('message-input').value='پیش‌نویس من';
  await app.click('btn-toggle-sidebar');assert.equal(app.el('sidebar').classList.contains('collapsed'),true);
  assert.equal(app.storage.get('cf_msg_sidebar_compact'),'1');assert.equal(app.el('message-input').value,'پیش‌نویس من');
  await app.open(0);assert.equal(app.el('message-input').value,'پیش‌نویس من');
  app.window.innerWidth=375;app.windowEvents.resize();assert.equal(app.el('sidebar').classList.contains('collapsed'),false);assert.equal(app.el('sidebar').classList.contains('hidden'),true);
  await app.click('btn-back-to-chats');assert.equal(app.el('sidebar').classList.contains('hidden'),false);
  app.window.innerWidth=1200;app.windowEvents.resize();assert.equal(app.el('sidebar').classList.contains('collapsed'),true);
  const reopened=harness(handler,{storageEntries:[...app.storage]});await settle();assert.equal(reopened.el('sidebar').classList.contains('collapsed'),true);assert.equal(reopened.storage.get('cf_msg_token'),'session-token');
});
