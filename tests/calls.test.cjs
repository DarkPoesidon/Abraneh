const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { buildSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const built = buildSync({ entryPoints: ['src/calls.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const scope = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module: scope, exports: scope.exports, require, Date });
const { handleCall, closeCall } = scope.exports;
const alice = { chatId: 'room', userId: 'alice', sessionId: 'session-a' }, bob = { chatId: 'room', userId: 'bob', sessionId: 'session-b' };

function fixture(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec('CREATE TABLE room_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE send_limits(user_id TEXT PRIMARY KEY,window_start INTEGER,count INTEGER);');
  const sql = { exec(query, ...params) { const rows = database.prepare(query).all(...params); return { toArray: () => rows }; } };
  const members = [{ user_id: 'alice', type: 'dm' }, { user_id: 'bob', type: 'dm' }], events = [];
  const env = { DB: { prepare() { return { bind: () => ({ all: async () => ({ results: members }) }) }; } } };
  const deliver = async event => events.push(JSON.parse(JSON.stringify(event)));
  const signal = (sender, kind, extra = {}, now = 1000) => handleCall(env, sql, sender, { action: 'call_signal', chatId: 'room', callId: 'call-1', kind, ...extra }, deliver, now);
  return { database, sql, members, events, deliver, signal };
}

test('signaling requires a two-member DM, matching room and bound caller session', async t => {
  const f = fixture(t);
  await assert.rejects(f.signal(alice, 'invite', { chatId: 'other', video: false }), /معتبر/);
  await assert.rejects(f.signal({ ...alice, userId: 'stranger' }, 'invite', { video: false }), /دونفره/);
  f.members[0].type = 'group';
  await assert.rejects(f.signal(alice, 'invite', { video: false }), /دونفره/);
  f.members[0].type = 'dm';
  await f.signal(alice, 'invite', { video: true });
  assert.equal(f.events[0].toUserId, 'bob'); assert.equal(f.events[0].video, true);
  await assert.rejects(f.signal({ ...alice, sessionId: 'other-session' }, 'end'), /نشست/);
  await assert.rejects(f.signal(bob, 'offer', { payload: { type: 'offer', sdp: 'v=0' } }), /ترتیب/);
  assert.equal(f.events.length, 1);
});

test('SDP and ICE relay only after consent, only to selected sessions, without persistent media metadata', async t => {
  const f = fixture(t);
  await f.signal(alice, 'invite', { video: false });
  await assert.rejects(f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0\r\nprivate-sdp' } }), /ترتیب/);
  await f.signal(bob, 'accept');
  await f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0\r\nprivate-sdp', injected: 'never-forward' } });
  assert.equal(f.events.at(-1).toSessionId, bob.sessionId);
  assert.equal(f.events.at(-1).payload.injected, undefined);
  await assert.rejects(f.signal({ ...bob, sessionId: 'second-device' }, 'answer', { payload: { type: 'answer', sdp: 'v=0' } }), /نشست/);
  await f.signal(bob, 'answer', { payload: { type: 'answer', sdp: 'v=0\r\nanswer' } });
  assert.equal(f.events.at(-1).toSessionId, alice.sessionId);
  await f.signal(alice, 'ice', { payload: { candidate: 'private-candidate', sdpMid: '0', sdpMLineIndex: 0, extra: 'drop' } });
  assert.equal(f.events.at(-1).payload.extra, undefined);
  const saved = f.database.prepare("SELECT value FROM room_meta WHERE key='call-v1'").get().value;
  assert.doesNotMatch(saved, /private-sdp|private-candidate|never-forward/);
  await f.signal(bob, 'end');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM room_meta').get().n, 0);
});

test('signaling bounds SDP/ICE, expires calls, and limits repeated ringing', async t => {
  const f = fixture(t);
  await f.signal(alice, 'invite', { video: false }); await f.signal(bob, 'accept');
  await assert.rejects(f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0' + 'x'.repeat(32_000) } }), /تنظیمات/);
  await f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0' } });
  await assert.rejects(f.signal(alice, 'ice', { payload: { candidate: 'x'.repeat(2049) } }), /مسیر/);
  for (let i = 0; i < 100; i++) await f.signal(alice, 'ice', { payload: { candidate: 'candidate' } });
  await assert.rejects(f.signal(alice, 'ice', { payload: { candidate: 'candidate' } }), /بیش از حد/);
  await assert.rejects(f.signal(bob, 'answer', { payload: { type: 'answer', sdp: 'v=0' } }, 902_000), /منقضی/);
  for (let i = 0; i < 4; i++) {
    await f.signal(alice, 'invite', { video: false }, 1_000_000);
    await f.signal(bob, 'decline', {}, 1_000_001);
  }
  await assert.rejects(f.signal(alice, 'invite', { video: false }, 1_000_002), /درخواست/);
});

test('disconnect from a different session cannot end a call', async t => {
  const f = fixture(t); await f.signal(alice, 'invite', { video: false });
  await closeCall(f.sql, { ...alice, sessionId: 'different' }, f.deliver);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM room_meta').get().n, 1);
  await closeCall(f.sql, alice, f.deliver);
  assert.equal(f.events.at(-1).kind, 'end'); assert.equal(f.events.at(-1).toUserId, bob.userId);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM room_meta').get().n, 0);
});

function browser({ media } = {}) {
  const nodes = [], packets = [], notices = [], timers = new Map(); let timer = 0, captures = 0, stopped = 0, closed = 0;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  function element(tag) {
    const node = { tag, children: [], style: {}, listeners: {}, hidden: false, open: false,
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, setAttribute() {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; }, play: async () => {},
    }; nodes.push(node); return node;
  }
  class Peer {
    constructor(config) { assert.equal(config.iceServers[0].urls, 'stun:stun.l.google.com:19302'); }
    addTrack() {} close() { closed++; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate() {}
  }
  const sandbox = { window: { addEventListener() {} }, document: { createElement: element, body: element('body') },
    navigator: { mediaDevices: { async getUserMedia(constraints) { captures++; assert.equal(constraints.audio, true); return media ? media() : stream; } } },
    RTCPeerConnection: Peer, crypto: { randomUUID: () => 'browser-call' }, Date, confirm: () => true,
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(readFileSync('public/calls.js', 'utf8'), sandbox);
  const client = sandbox.window.WihmCalls.create({ getChat: () => ({ id: 'room', type: 'dm', title: 'Bob' }), getUser: () => ({ id: 'bob' }), send: data => packets.push(data), notify: text => notices.push(text) });
  const invite = { event: 'call_signal', kind: 'invite', chatId: 'room', callId: 'incoming', from: 'alice', video: true, expiresAt: Date.now() + 45_000 };
  return { client, nodes, packets, notices, invite, stats: () => ({ captures, stopped, closed }), stream };
}

test('incoming call requires acceptance; decline captures nothing and hangup stops every track', async () => {
  const f = browser(); await f.client.receive(f.invite);
  assert.equal(f.stats().captures, 0);
  f.nodes.find(node => node.textContent === 'رد تماس').onclick();
  assert.equal(f.packets.at(-1).kind, 'decline'); assert.equal(f.stats().captures, 0);
  await f.client.receive({ ...f.invite, callId: 'second' });
  await f.nodes.find(node => node.textContent === 'پذیرش و اجازهٔ میکروفون / دوربین').onclick();
  assert.equal(f.stats().captures, 1); assert.equal(f.packets.at(-1).kind, 'accept');
  f.client.reset();
  assert.equal(f.packets.at(-1).kind, 'end'); assert.equal(f.stats().stopped, 1); assert.equal(f.stats().closed, 1);
});

test('late permission result after logout cleanup cannot reopen microphone or peer connection', async () => {
  let resolveMedia;
  const f = browser({ media: () => new Promise(resolve => { resolveMedia = resolve; }) });
  await f.client.receive(f.invite);
  const permission = f.nodes.find(node => node.textContent === 'پذیرش و اجازهٔ میکروفون / دوربین').onclick();
  f.client.reset(); resolveMedia(f.stream); await permission;
  assert.equal(f.stats().stopped, 1); assert.equal(f.client.active(), false);
  assert.ok(!f.packets.some(packet => packet.kind === 'accept'));
});
