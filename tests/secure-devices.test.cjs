// Runs the real secure client against an in-memory server that follows the same rules for lists and mailboxes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrivateKey, sign } = require('node:crypto');

let createSecureClient;
const HOST = 'chat.example.org';

function world() {
  const devices = new Map(), lists = new Map(), events = [], prekeys = new Map();
  let sequence = 0;
  const server = {
    devices, lists, events,
    handle(who, path, method, body) {
      if (path === '/api/secure/devices' && method === 'GET') return { devices: [...(devices.get(who) || new Map()).values()].filter(d => !d.revoked).map(d => ({ device: d.device, identityKey: d.identityKey, available: (prekeys.get(d.device) || []).length })) };
      if (path === '/api/secure/devices' && method === 'POST') {
        const mine = devices.get(who) || new Map(); devices.set(who, mine);
        if (!mine.has(body.device)) mine.set(body.device, { device: body.device, identityKey: body.identityKey });
        const packages = prekeys.get(body.device) || []; prekeys.set(body.device, packages); packages.push({ keyPackage: body.keyPackage, signature: body.signature });
        return { ok: true };
      }
      if (path === '/api/secure/devices' && method === 'DELETE') { const d = devices.get(who)?.get(body.device); if (d) d.revoked = true; return { ok: true }; }
      if (path === '/api/secure/device-list' && method === 'GET') return { list: lists.get(who) || null };
      if (path === '/api/secure/device-list' && method === 'PUT') { lists.set(who, body); return { ok: true }; }
      if (path === '/api/secure/device-lists') return { address: body.address, list: lists.get(body.address) || null };
      if (path === '/api/secure/keys') {
        const claimed = [];
        for (const d of (devices.get(body.address) || new Map()).values()) { if (d.revoked) continue; const item = (prekeys.get(d.device) || []).shift(); if (item) claimed.push({ device: d.device, identityKey: d.identityKey, ...item }); }
        return { address: body.address, devices: claimed };
      }
      if (path === '/api/secure/send') {
        const target = devices.get(body.to)?.get(body.toDevice);
        if (!target || target.revoked) { const error = new Error('مقصد در دسترس نیست یا پیام را نمی‌پذیرد.'); error.status = 404; throw error; }
        events.push({ sequence: ++sequence, envelope: body }); return { ok: true, id: body.id, queued: false };
      }
      if (path.startsWith('/api/secure/inbox')) {
        const url = new URL('http://x' + path), device = url.searchParams.get('device'), after = Number(url.searchParams.get('after'));
        return { events: events.filter(e => e.envelope.toDevice === device && e.sequence > after) };
      }
      throw new Error('unexpected ' + method + ' ' + path);
    },
  };
  return server;
}

async function device(server, who) {
  let saved = null;
  const client = await createSecureClient({ address: who, storage: { load: async () => saved && structuredClone(saved), save: async value => { saved = structuredClone(value); } }, request: async (path, method, body) => server.handle(who, path, method, body && structuredClone(body)) });
  const identity = await client.init();
  client.write = value => { saved = structuredClone(value); };
  return { client, ...identity, read: () => saved };
}
const texts = async (party, id) => (await party.client.view()).threads.find(t => t.id === id)?.messages.map(m => m.text) || [];
const everyone = async (...parties) => { for (let round = 0; round < 3; round++) for (const party of parties) await party.client.sync(); };

// Two people who verified each other's first device, in one conversation.
async function pair(server) {
  const alice = await device(server, 'alice@' + HOST), bob = await device(server, 'bob@' + HOST);
  const bobDevice = (await alice.client.lookup('bob@' + HOST)).find(d => d.device === bob.device);
  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  await bob.client.trust('alice@' + HOST, alice.device, alice.key, alice.fingerprint);
  const thread = await alice.client.start('bob@' + HOST, bobDevice);
  await everyone(alice, bob);
  return { alice, bob, thread };
}
// A person adds a device, with both sides checking the other's fingerprint.
async function link(existing, fresh) {
  await existing.client.link(fresh.device, fresh.key, fresh.fingerprint);
  await fresh.client.sync();
  assert.equal((await fresh.client.view()).pendingLink, existing.fingerprint);
  await fresh.client.confirmLink(existing.fingerprint);
}

test('load the client', async () => {
  ({ createSecureClient } = await import('../public/secure.js'));
  assert.equal(typeof createSecureClient, 'function');
});

test('two devices still talk, in one conversation', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  await alice.client.send(thread, 'سلام');
  await everyone(alice, bob);
  assert.deepEqual(await texts(bob, thread), ['سلام']);
  await bob.client.send(thread, 'علیک');
  await everyone(alice, bob);
  assert.deepEqual(await texts(alice, thread), ['سلام', 'علیک']);
});

test('a new device gets new messages from a contact and from the other device, not old ones', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  await alice.client.send(thread, 'قبل از دستگاه تازه');
  await everyone(alice, bob);
  const bob2 = await device(server, 'bob@' + HOST);
  assert.equal((await bob2.client.view()).linked, false);
  await link(bob, bob2);
  assert.equal((await bob2.client.view()).linked, true);

  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  await alice.client.send(thread, 'برای هر دو دستگاه');
  await everyone(alice, bob, bob2);
  assert.deepEqual(await texts(bob, thread), ['قبل از دستگاه تازه', 'برای هر دو دستگاه']);
  assert.deepEqual(await texts(bob2, thread), ['برای هر دو دستگاه']);

  await bob.client.send(thread, 'از دستگاه اول باب');
  await everyone(alice, bob, bob2);
  assert.ok((await texts(alice, thread)).includes('از دستگاه اول باب'));
  assert.ok((await texts(bob2, thread)).includes('از دستگاه اول باب'), 'your other device sees what you sent');

  await bob2.client.send(thread, 'از دستگاه دوم باب');
  await everyone(alice, bob, bob2);
  for (const party of [alice, bob]) assert.ok((await texts(party, thread)).includes('از دستگاه دوم باب'));
  const seen = await texts(alice, thread);
  assert.equal(seen.length, new Set(seen).size, 'a message appears once');
});

test('a contact is told when a new device joins', async () => {
  const server = world(), { alice, bob } = await pair(server);
  const bob2 = await device(server, 'bob@' + HOST);
  await link(bob, bob2);
  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  const view = await alice.client.view();
  assert.ok(view.trusted['bob@' + HOST + '|' + bob2.device], 'a list signed by a verified device is followed');
  assert.ok(view.alerts.some(a => a.message.includes('دستگاه تازه')));
});

test('a removed device gets no new messages', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  const bob2 = await device(server, 'bob@' + HOST);
  await link(bob, bob2);
  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  await alice.client.send(thread, 'قبل از حذف');
  await everyone(alice, bob, bob2);
  assert.deepEqual(await texts(bob2, thread), ['قبل از حذف']);

  await bob.client.revoke(bob2.device);
  const before = server.events.length;
  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  assert.equal((await alice.client.view()).trusted['bob@' + HOST + '|' + bob2.device], undefined);
  await alice.client.send(thread, 'بعد از حذف');
  await bob.client.sync(); await alice.client.sync();
  assert.ok((await texts(bob, thread)).includes('بعد از حذف'));
  assert.ok(!server.events.slice(before).some(e => e.envelope.toDevice === bob2.device), 'nothing is sealed for it');
  await bob2.client.sync();
  assert.deepEqual(await texts(bob2, thread), ['قبل از حذف'], 'the removed device cannot read it');
});

test('a device the server adds is not trusted', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  const evil = await device(server, 'bob@' + HOST);
  // The server shows a list naming its own device, first with a bad signature and then properly signed by that device.
  const honest = server.lists.get('bob@' + HOST), devices = [...honest.devices, { device: evil.device, key: evil.key }], version = honest.version + 1;
  server.lists.set('bob@' + HOST, { version, devices, signer: evil.key, signature: honest.signature });
  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  assert.equal((await alice.client.view()).trusted['bob@' + HOST + '|' + evil.device], undefined, 'a bad signature is refused');
  const data = JSON.stringify(['wihm-device-list/1', 'bob@' + HOST, version, devices.map(d => [d.device, d.key]), evil.key]);
  server.lists.set('bob@' + HOST, { version, devices, signer: evil.key, signature: sign(null, Buffer.from(data), createPrivateKey({ key: Buffer.from(evil.read().device.private, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64') });
  await alice.client.trust('bob@' + HOST, bob.device, bob.key, bob.fingerprint);
  assert.equal((await alice.client.view()).trusted['bob@' + HOST + '|' + evil.device], undefined, 'a signer nobody verified is refused');
  await alice.client.send(thread, 'محرمانه');
  assert.ok(!server.events.some(e => e.envelope.toDevice === evil.device && e.envelope.kind === 'message'), 'nothing is sealed for that device');
});

test('a list signed by an unverified device is refused, and a new device checks who approved it', async () => {
  const server = world(), { bob } = await pair(server);
  const stranger = await device(server, 'bob@' + HOST);
  await bob.client.link(stranger.device, stranger.key, stranger.fingerprint);
  await stranger.client.sync();
  await assert.rejects(stranger.client.confirmLink('00'.repeat(32)), /مطابقت ندارد/);
  assert.equal((await stranger.client.view()).linked, false);
  await assert.rejects(bob.client.link(stranger.device, stranger.key, '00'), /مطابقت ندارد/);
});

test('an older saved conversation keeps working after the upgrade', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  await alice.client.send(thread, 'پیش از ارتقا');
  await everyone(alice, bob);
  // Rewrites the saved state the way version 1 kept it: the MLS group sits on the thread, keyed by the group's id.
  const state = bob.read(), [session] = Object.values(state.sessions);
  assert.equal(state.version, 2);
  state.version = 1;
  state.threads = { [session.id]: { ...state.threads[thread], id: session.id, state: session.state, seen: session.seen } };
  delete state.sessions; delete state.lists;
  await bob.client.write(state);
  await alice.client.send(thread, 'پس از ارتقا');
  await everyone(alice, bob);
  const view = await bob.client.view();
  assert.ok(view.threads.some(t => t.messages.some(m => m.text === 'پس از ارتقا')));
  assert.equal(view.threadOfSession[session.id] !== undefined, true);
});

test('replies, edits, deletes, reactions and read receipts travel encrypted to every device', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  const alice2 = await device(server, 'alice@' + HOST);
  await link(alice, alice2);
  await bob.client.trust('alice@' + HOST, alice.device, alice.key, alice.fingerprint);
  const message = id => party => party.client.view().then(view => view.threads.find(t => t.id === thread).messages.find(m => m.id === id));
  const first = await alice.client.send(thread, 'PLAIN-ONE');
  await everyone(alice, alice2, bob);
  const reply = await bob.client.send(thread, 'PLAIN-TWO', first);
  await everyone(alice, alice2, bob);
  assert.equal((await message(reply)(alice)).replyTo, first);

  await alice.client.edit(thread, first, 'PLAIN-EDITED');
  await bob.client.react(thread, first, '👍');
  await everyone(alice, alice2, bob);
  for (const party of [alice, alice2, bob]) {
    const seen = await message(first)(party);
    assert.equal(seen.text, 'PLAIN-EDITED'); assert.equal(seen.edited, true);
    assert.equal(seen.reactions['bob@' + HOST], '👍');
  }
  await bob.client.react(thread, first, '');
  await bob.client.markRead(thread);
  await alice.client.markRead(thread);
  await everyone(alice, alice2, bob);
  assert.deepEqual((await message(first)(alice)).reactions, {});
  assert.equal((await message(first)(alice)).delivery, 'read');
  assert.equal((await message(reply)(alice2)).read, true, 'your other device knows you read it');

  await alice.client.remove(thread, first);
  await everyone(alice, alice2, bob);
  for (const party of [alice, alice2, bob]) {
    const seen = await message(first)(party);
    assert.equal(seen.deleted, true); assert.equal(seen.text, '');
  }

  const wire = JSON.stringify(server.events);
  for (const text of ['PLAIN-ONE', 'PLAIN-TWO', 'PLAIN-EDITED', '👍']) assert.ok(!wire.includes(text), text);
  const kinds = server.events.map(e => e.envelope.kind);
  assert.ok(kinds.includes('control') && kinds.includes('message'), 'changes do not notify, messages do');
});

test('only the author can change a message', async () => {
  const server = world(), { alice, bob, thread } = await pair(server);
  const id = await alice.client.send(thread, 'mine');
  await everyone(alice, bob);
  await assert.rejects(bob.client.edit(thread, id, 'hacked'), /فقط پیام خودتان/);
  await assert.rejects(bob.client.remove(thread, id), /فقط پیام خودتان/);
  // A changed client claims the message is its own; the other side still refuses.
  const state = bob.read();state.threads[thread].messages[0].from = 'bob@' + HOST;bob.client.write(state);
  await bob.client.edit(thread, id, 'hacked');
  await bob.client.remove(thread, id);
  await everyone(alice, bob);
  assert.deepEqual(await texts(alice, thread), ['mine']);
});
