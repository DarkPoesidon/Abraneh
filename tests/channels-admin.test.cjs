const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
let fixture, sockets = [];
async function call(account, path, method = 'GET', body) {
  const response = await fixture.mf.dispatchFetch(fixture.origin + path, { method, headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => null) };
}
async function ok(account, path, method, body) { const result = await call(account, path, method, body); assert.ok(result.status < 300, path + ' ' + JSON.stringify(result)); return result.data; }
async function socket(account, chatId) {
  const response = await fixture.mf.dispatchFetch(`${fixture.origin}/ws?chatId=${chatId}&token=${account.token}`, { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket; ws.accept(); sockets.push(ws); const events = []; ws.addEventListener('message', event => events.push(JSON.parse(event.data)));
  return { ws, events };
}
async function until(check, what) { for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail('Timed out: ' + what); }
const upload = (account, chatId, query, bytes, mime) => fixture.mf.dispatchFetch(`${fixture.origin}/api/chats/${chatId}/media?${new URLSearchParams(query)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': mime }, body: bytes });

before(async () => { fixture = await (await import('./browser/fixture.mjs')).createNavigationFixture(); await ok(fixture.owner, '/api/service/claim', 'POST', { code: 'local-fixture-owner-code' }); });
after(async () => { for (const ws of sockets) try { ws.close(); } catch {} await fixture?.close(); });

test('a username can change once it is valid and free, and sign-in follows it', async () => {
  assert.equal((await call(fixture.peer, '/api/profile/username', 'POST', { username: 'no spaces' })).status, 400);
  assert.equal((await call(fixture.peer, '/api/profile/username', 'POST', { username: fixture.owner.user.username })).status, 409);
  assert.deepEqual(await ok(fixture.peer, '/api/profile/username', 'POST', { username: 'New_Name' }), { username: 'new_name' });
  assert.equal((await ok(fixture.peer, '/api/profile')).username, 'new_name');
  await ok(fixture.peer, '/api/profile/username', 'POST', { username: fixture.peer.user.username });
});

let channel;
test('only managers post in a channel, and subscribers stay hidden from each other', async () => {
  assert.equal((await call(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'خبر', visibility: 'public', handle: 'x' })).status, 400);
  channel = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'خبر', visibility: 'public', handle: 'news_room', description: 'اخبار' })).id;
  assert.equal((await call(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'تکراری', visibility: 'public', handle: 'NEWS_ROOM' })).status, 409);

  const found = await ok(fixture.peer, '/api/public-channels?q=news');
  assert.deepEqual(found.map(row => [row.id, row.handle, row.members, row.joined]), [[channel, 'news_room', 1, 0]]);
  assert.equal((await call(fixture.peer, `/api/chats/${channel}/details`)).status, 403);
  await ok(fixture.peer, `/api/public-channels/${channel}/join`, 'POST');

  const listed = (await ok(fixture.peer, '/api/chats')).find(row => row.id === channel);
  assert.equal(listed.isChannel, true); assert.equal(listed.handle, 'news_room'); assert.equal(listed.role, 'member');
  const details = await ok(fixture.peer, `/api/chats/${channel}/details`);
  assert.equal(details.isChannel, true); assert.equal(details.memberCount, 2);
  assert.deepEqual(details.members.map(row => row.id), [fixture.owner.user.id], 'a subscriber sees only the managers');
  assert.equal((await ok(fixture.owner, `/api/chats/${channel}/details`)).members.length, 2);

  const owner = await socket(fixture.owner, channel), subscriber = await socket(fixture.peer, channel);
  subscriber.ws.send(JSON.stringify({ action: 'send_message', chatId: channel, text: 'پست غیرمجاز', clientMsgId: 'sub-1' }));
  await until(() => subscriber.events.find(event => event.event === 'error' && event.clientMsgId === 'sub-1'), 'the refusal');
  assert.equal((await upload(fixture.peer, channel, { kind: 'file', mime: 'text/plain', durationMs: '0', name: 'a.txt' }, new Uint8Array(4), 'text/plain')).status, 403);
  owner.ws.send(JSON.stringify({ action: 'send_message', chatId: channel, text: 'پست مدیر', clientMsgId: 'own-1' }));
  const post = await until(() => subscriber.events.find(event => event.event === 'new_message' && event.message.clientMsgId === 'own-1'), 'the post');
  assert.ok(!owner.events.concat(subscriber.events).some(event => event.event === 'presence'), 'nobody learns who is online');

  const reacted = await ok(fixture.peer, `/api/chats/${channel}/messages/${post.message.id}/reaction`, 'POST', { emoji: '👍' });
  assert.equal(reacted.message.reactions[0].emoji, '👍');
  await until(async () => (await ok(fixture.peer, `/api/chats/${channel}/messages`)).length === 1, 'the history');
  await ok(fixture.owner, `/api/chats/${channel}/receipts`, 'POST', { messageId: post.message.id, read: true });
  const receipts = await ok(fixture.peer, `/api/chats/${channel}/receipts`);
  assert.ok(!receipts.some(row => row.userId === fixture.owner.user.id), 'receipts must not name other members');
});

test('a channel can turn private, and its invite link still works', async () => {
  await ok(fixture.owner, `/api/chats/${channel}/group`, 'PATCH', { action: 'channel', visibility: 'private', description: 'خصوصی' });
  assert.deepEqual(await ok(fixture.peer, '/api/public-channels?q=news'), []);
  await ok(fixture.peer, `/api/chats/${channel}/leave`, 'POST');
  assert.equal((await call(fixture.peer, `/api/public-channels/${channel}/join`, 'POST')).status, 404);
  const { token } = await ok(fixture.owner, `/api/chats/${channel}/invites`, 'POST', { hours: 24, uses: 5 });
  assert.equal((await ok(fixture.peer, `/api/invites/${token}/join`, 'POST')).chatId, channel);
});

test('images and files upload with their names and types checked', async () => {
  const chat = (await ok(fixture.owner, '/api/chats', 'POST', { targetUserId: fixture.peer.user.id })).id;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal((await upload(fixture.owner, chat, { kind: 'image', mime: 'image/png', durationMs: '0', name: 'x.png' }, new Uint8Array(32), 'image/png')).status, 400, 'bytes must match the type');
  assert.equal((await upload(fixture.owner, chat, { kind: 'image', mime: 'image/svg+xml', durationMs: '0', name: 'x.svg' }, png, 'image/svg+xml')).status, 415);
  assert.equal((await upload(fixture.owner, chat, { kind: 'file', mime: 'text/plain', durationMs: '0', name: '///' }, png, 'text/plain')).status, 400);
  const image = await (await upload(fixture.owner, chat, { kind: 'image', mime: 'image/png', durationMs: '0', name: 'photo.png' }, png, 'image/png')).json();
  assert.equal(image.message.media.kind, 'image'); assert.equal(image.message.text, '🖼 photo.png');
  const file = await (await upload(fixture.owner, chat, { kind: 'file', mime: 'application/pdf', durationMs: '0', name: 'a‮gnp.pdf', clientMsgId: 'file-1' }, new Uint8Array([1, 2, 3]), 'application/pdf')).json();
  assert.equal(file.message.text, '📎 agnp.pdf', 'direction controls must not disguise the name');
  const stored = await fixture.mf.dispatchFetch(`${fixture.origin}/api/chats/${chat}/media/${file.message.id}`, { headers: { Authorization: 'Bearer ' + fixture.peer.token } });
  assert.equal(stored.headers.get('Content-Disposition'), 'attachment'); assert.equal(stored.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await stored.arrayBuffer())], [1, 2, 3]);
});

test('the service admin handles reports, and can suspend, restore and delete chats', async () => {
  assert.equal((await call(fixture.peer, '/api/service/chats?kind=channel')).status, 403);
  assert.equal((await call(fixture.peer, '/api/service/messages', 'POST', { chatId: channel, messageId: 'x' })).status, 403);

  const channels = await ok(fixture.owner, '/api/service/chats?kind=channel');
  assert.deepEqual(channels.chats.map(row => [row.id, row.owner, row.members]), [[channel, fixture.owner.user.username, 2]]);
  assert.ok(!(await ok(fixture.owner, '/api/service/chats?kind=group')).chats.some(row => row.id === channel));

  const post = (await ok(fixture.peer, `/api/chats/${channel}/messages`))[0];
  await ok(fixture.peer, '/api/reports', 'POST', { userId: fixture.owner.user.id, reason: 'محتوای نامناسب', chatId: channel, messageId: post.id });
  const report = (await ok(fixture.owner, '/api/service/reports')).find(row => row.message_id === post.id);
  assert.equal(report.chatTitle, 'خبر'); assert.equal(report.isChannel, 1); assert.equal(report.snapshot, 'پست مدیر');
  assert.equal((await ok(fixture.owner, '/api/service/overview')).counts.openReports, 1);

  await ok(fixture.owner, '/api/service/messages', 'POST', { chatId: channel, messageId: post.id });
  assert.ok((await ok(fixture.peer, `/api/chats/${channel}/messages`))[0].deletedAt, 'the reported post is gone');
  await ok(fixture.owner, '/api/service/reports', 'PATCH', { id: report.id, status: 'resolved' });
  assert.equal((await ok(fixture.owner, '/api/service/overview')).counts.openReports, 0);

  await ok(fixture.owner, '/api/service/chats', 'PATCH', { chatId: channel, action: 'suspend', reason: 'تخلف' });
  assert.equal((await call(fixture.peer, `/api/chats/${channel}/messages`)).status, 403);
  assert.ok(!(await ok(fixture.peer, '/api/chats')).some(row => row.id === channel));
  assert.equal((await ok(fixture.owner, '/api/service/chats?kind=channel')).chats[0].reason, 'تخلف');
  await ok(fixture.owner, '/api/service/chats', 'PATCH', { chatId: channel, action: 'restore', reason: '' });
  assert.equal((await call(fixture.peer, `/api/chats/${channel}/messages`)).status, 200);

  const dm = (await ok(fixture.owner, '/api/chats', 'POST', { targetUserId: fixture.peer.user.id })).id;
  assert.equal((await call(fixture.owner, '/api/service/chats', 'PATCH', { chatId: dm, action: 'delete', reason: '' })).status, 404, 'private chats are out of reach');
  await ok(fixture.owner, '/api/service/chats', 'PATCH', { chatId: channel, action: 'delete', reason: '' });
  assert.equal((await call(fixture.peer, `/api/chats/${channel}/details`)).status, 403);
  assert.ok((await ok(fixture.owner, '/api/service/audit')).some(row => row.action === 'delete-chat'));
  const again = await ok(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'دوباره', visibility: 'public', handle: 'news_room' });
  assert.ok(again.id, 'the name of a deleted channel is free again');
});

test('an owner can delete their own group, and a member cannot', async () => {
  const id = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'group', title: 'گروه', memberIds: [fixture.peer.user.id] })).id;
  assert.equal((await call(fixture.peer, `/api/chats/${id}/group`, 'PATCH', { action: 'delete' })).status, 403);
  await ok(fixture.owner, `/api/chats/${id}/group`, 'PATCH', { action: 'delete' });
  assert.equal((await call(fixture.owner, `/api/chats/${id}/details`)).status, 403);
});

test('a private chat can be deleted for one side, or for both', async () => {
  const third = await (await fixture.mf.dispatchFetch(fixture.origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'third_user', password: 'a-long-password', displayName: 'سوم' }) })).json();
  const chat = (await ok(fixture.owner, '/api/chats', 'POST', { targetUserId: third.user.id })).id;
  const owner = await socket(fixture.owner, chat);
  owner.ws.send(JSON.stringify({ action: 'send_message', chatId: chat, text: 'پیام اول', clientMsgId: 'del-1' }));
  await until(async () => (await ok(third, `/api/chats/${chat}/messages`)).length === 1 && (await ok(third, '/api/chats')).some(row => row.id === chat && row.lastMessage), 'the first message');

  await ok(third, `/api/chats/${chat}/delete`, 'POST', { forEveryone: false });
  assert.ok(!(await ok(third, '/api/chats')).some(row => row.id === chat), 'it leaves the list of the side that deleted it');
  assert.equal((await ok(third, `/api/chats/${chat}/messages`)).length, 0, 'and its history');
  assert.equal((await ok(fixture.owner, `/api/chats/${chat}/messages`)).length, 1, 'the other side keeps theirs');

  owner.ws.send(JSON.stringify({ action: 'send_message', chatId: chat, text: 'پیام دوم', clientMsgId: 'del-2' }));
  const back = await until(async () => (await ok(third, '/api/chats')).find(row => row.id === chat), 'a new message to bring it back');
  assert.equal(back.lastMessage.text, 'پیام دوم');
  assert.deepEqual((await ok(third, `/api/chats/${chat}/messages`)).map(row => row.text), ['پیام دوم']);

  await ok(third, `/api/chats/${chat}/delete`, 'POST', { forEveryone: false });
  assert.equal((await ok(third, '/api/chats', 'POST', { targetUserId: fixture.owner.user.id })).id, chat, 'starting it again finds the same chat');
  assert.ok((await ok(third, '/api/chats')).some(row => row.id === chat), 'and lists it again');

  await ok(third, `/api/chats/${chat}/delete`, 'POST', { forEveryone: true });
  assert.ok(!(await ok(fixture.owner, '/api/chats')).some(row => row.id === chat), 'deleting for both removes it from the other side');
  assert.equal((await call(fixture.owner, `/api/chats/${chat}/messages`)).status, 403);
  const again = (await ok(fixture.owner, '/api/chats', 'POST', { targetUserId: third.user.id })).id;
  assert.equal(again, chat, 'the pair can talk again');
  assert.deepEqual(await ok(fixture.owner, `/api/chats/${chat}/messages`), [], 'with nothing left of the old chat');
});
test('groups are left or deleted, not deleted through the private chat route', async () => {
  const id = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'group', title: 'گروه', memberIds: [fixture.peer.user.id] })).id;
  assert.equal((await call(fixture.peer, `/api/chats/${id}/delete`, 'POST', { forEveryone: true })).status, 400);
  assert.ok((await ok(fixture.owner, `/api/chats/${id}/details`)).members.length === 2);
});

test('a channel from the first version moves into the chat list once, with its posts and people', async () => {
  const db = await fixture.mf.getD1Database('DB'), now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO channels VALUES ('legacy-one',?,'مانترا','public','hash',?)").bind(fixture.owner.user.id, now - 5000),
    db.prepare("INSERT INTO channel_members VALUES ('legacy-one',?,'subscriber')").bind(fixture.peer.user.id),
    db.prepare("INSERT INTO channel_posts(id,channel_id,author_id,text,created_at,updated_at) VALUES ('legacy-post','legacy-one',?,'پست قدیمی',?,?)").bind(fixture.owner.user.id, now - 4000, now - 4000),
    db.prepare("INSERT INTO channel_posts(id,channel_id,author_id,text,created_at,updated_at,deleted_at) VALUES ('legacy-gone','legacy-one',?,'',?,?,?)").bind(fixture.owner.user.id, now - 3000, now - 3000, now - 3000),
  ]);
  assert.deepEqual(await ok(fixture.peer, '/api/channels/migrate', 'POST', {}), { migrated: 1 });
  assert.deepEqual(await ok(fixture.owner, '/api/channels/migrate', 'POST', {}), { migrated: 0 }, 'it moves only once');
  const owner = (await ok(fixture.owner, '/api/chats')).find(row => row.id === 'legacy-one');
  assert.equal(owner.isChannel, true); assert.equal(owner.role, 'owner'); assert.equal(owner.title, 'مانترا'); assert.ok(owner.handle);
  assert.deepEqual((await ok(fixture.peer, '/api/chats/legacy-one/messages')).map(row => [row.id, row.text]), [['legacy-post', 'پست قدیمی']]);
  assert.equal((await ok(fixture.peer, '/api/chats/legacy-one/details')).role, 'member');
});
test('a channel keeps a validated photo', async () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
  assert.equal((await call(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'بد', visibility: 'private', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  const id = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'عکس', visibility: 'private', avatar: png })).id;
  assert.equal((await ok(fixture.owner, '/api/chats')).find(row => row.id === id).avatar, png);
  assert.equal((await ok(fixture.owner, `/api/chats/${id}/details`)).avatar, png);
  await ok(fixture.owner, `/api/chats/${id}/group`, 'PATCH', { action: 'channel', visibility: 'private', description: '', avatar: '' });
  assert.equal((await ok(fixture.owner, `/api/chats/${id}/details`)).avatar, '');
});

test('a group can have a photo set by its managers only', async () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
  const id = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'group', title: 'با عکس', memberIds: [fixture.peer.user.id] })).id;
  assert.equal((await call(fixture.peer, `/api/chats/${id}/group`, 'PATCH', { action: 'photo', avatar: png })).status, 403);
  assert.equal((await call(fixture.owner, `/api/chats/${id}/group`, 'PATCH', { action: 'photo', avatar: 'data:text/html;base64,AA==' })).status, 400);
  await ok(fixture.owner, `/api/chats/${id}/group`, 'PATCH', { action: 'photo', avatar: png });
  assert.equal((await ok(fixture.peer, '/api/chats')).find(row => row.id === id).avatar, png);
  assert.equal((await ok(fixture.peer, `/api/chats/${id}/details`)).avatar, png);
  await ok(fixture.owner, `/api/chats/${id}/group`, 'PATCH', { action: 'photo', avatar: '' });
  assert.equal((await ok(fixture.peer, `/api/chats/${id}/details`)).avatar, '');
});
test('another server can read public channels, and only public ones', async () => {
  const pub = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'سراسری', visibility: 'public', handle: 'world_news' })).id;
  const hidden = (await ok(fixture.owner, '/api/chats', 'POST', { type: 'channel', title: 'پنهان', visibility: 'private' })).id;
  const owner = await socket(fixture.owner, pub);
  owner.ws.send(JSON.stringify({ action: 'send_message', chatId: pub, text: 'خبر عمومی', clientMsgId: 'pub-1' }));
  const anonymous = path => fixture.mf.dispatchFetch(fixture.origin + path);
  await until(async () => (await (await anonymous('/api/discovery/channels/world_news/posts')).json()).posts?.length === 1, 'the public post');
  const list = await (await anonymous('/api/discovery/channels?q=world')).json();
  assert.deepEqual(list.channels.map(row => [row.handle, row.title]), [['world_news', 'سراسری']]);
  assert.ok(!JSON.stringify(await (await anonymous('/api/discovery/channels')).json()).includes('پنهان'), 'a private channel stays hidden');
  assert.notEqual((await anonymous('/api/discovery/channels/' + hidden + '/posts')).status, 200);
  assert.equal((await (await anonymous('/.well-known/wihm')).json()).capabilities.channels, true);
  await ok(fixture.owner, '/api/service/chats', 'PATCH', { chatId: pub, action: 'suspend', reason: '' });
  assert.equal((await anonymous('/api/discovery/channels/world_news/posts')).status, 404, 'a suspended channel stays closed to other servers');
  await ok(fixture.owner, '/api/service/chats', 'PATCH', { chatId: pub, action: 'restore', reason: '' });
  const db = await fixture.mf.getD1Database('DB');
  await db.prepare("INSERT INTO site_settings VALUES ('discovery_enabled','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  assert.equal((await anonymous('/api/discovery/channels')).status, 404, 'the admin can close it');
  await db.prepare("DELETE FROM site_settings WHERE key='discovery_enabled'").run();
  assert.deepEqual(await ok(fixture.owner, '/api/network/channels/follows'), []);
  assert.equal((await call(fixture.owner, '/api/network/channels/search', 'POST', { server: 'localhost', q: '' })).status, 400, 'local addresses are refused');
});
