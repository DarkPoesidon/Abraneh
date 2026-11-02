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

test('a dropped socket keeps an accepted call alive because media does not use it', async t => {
  const f = fixture(t); await f.signal(alice, 'invite', { video: false }); await f.signal(bob, 'accept');
  const delivered = f.events.length;
  await closeCall(f.sql, alice, f.deliver);
  assert.equal(f.events.length, delivered, 'the other side must not be told the call ended');
  await f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0' } });
  await closeCall(f.sql, bob, f.deliver);
  await f.signal(bob, 'answer', { payload: { type: 'answer', sdp: 'v=0' } });
  await f.signal(alice, 'end');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM room_meta').get().n, 0);
});

test('a participant whose call was lost can call again instead of waiting for it to expire', async t => {
  const f = fixture(t); await f.signal(alice, 'invite', { video: false }); await f.signal(bob, 'accept');
  await assert.rejects(f.signal({ ...alice, sessionId: 'other-device' }, 'invite', { callId: 'call-2', video: false }), /در جریان/);
  await f.signal(alice, 'invite', { callId: 'call-2', video: false });
  const [ended, invited] = f.events.slice(-2);
  assert.equal(ended.kind, 'end'); assert.equal(ended.callId, 'call-1'); assert.equal(ended.toUserId, bob.userId);
  assert.equal(invited.kind, 'invite'); assert.equal(invited.callId, 'call-2');
});

function browser({ media, play, getIceServers, send, audioContext } = {}) {
  const peers = [];
  const nodes = [], packets = [], notices = [], timers = new Map(); let timer = 0, captures = 0, stopped = 0, closed = 0;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  function element(tag) {
    const node = { tag, children: [], style: {}, listeners: {}, hidden: false, open: false,
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, setAttribute() {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; }, play: play || (async () => {}),
    }; nodes.push(node); return node;
  }
  class Peer {
    constructor(config) { assert.equal(config.iceServers[0].urls, 'stun:stun.l.google.com:19302'); peers.push(this); }
    transceivers = []; addTrack() {} addTransceiver(kind, options) { this.transceivers.push({ kind, ...options }); } close() { closed++; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate() {}
  }
  const sandbox = { window: { addEventListener() {}, ...(audioContext ? { AudioContext: audioContext } : {}) }, document: { createElement: element, body: element('body') },
    navigator: { mediaDevices: { async getUserMedia(constraints) { captures++; assert.equal(constraints.audio, true); return media ? media() : stream; } } },
    RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } }, crypto: { randomUUID: () => 'browser-call' }, Date, confirm: () => true,
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); }, setInterval(fn) { timers.set(++timer, fn); return timer; }, clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(readFileSync('public/calls.js', 'utf8'), sandbox);
  const client = sandbox.window.WihmCalls.create({ getChat: () => ({ id: 'room', type: 'dm', title: 'Bob' }), getUser: () => ({ id: 'bob' }), ...(getIceServers ? { getIceServers } : {}), send: send ? data => send(data, packets) : data => packets.push(data), notify: text => notices.push(text) });
  const invite = { event: 'call_signal', kind: 'invite', chatId: 'room', callId: 'incoming', from: 'alice', video: true, expiresAt: Date.now() + 45_000 };
  return { client, nodes, packets, notices, invite, stats: () => ({ captures, stopped, closed }), stream, peers };
}

test('incoming call requires acceptance; decline captures nothing and hangup stops every track', async () => {
  const f = browser(); await f.client.receive(f.invite);
  assert.equal(f.stats().captures, 0);
  f.nodes.find(node => node.textContent === 'رد تماس').onclick();
  assert.equal(f.packets.at(-1).kind, 'decline'); assert.equal(f.stats().captures, 0);
  await f.client.receive({ ...f.invite, callId: 'second' });
  await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  assert.equal(f.stats().captures, 1); assert.equal(f.packets.at(-1).kind, 'accept');
  f.client.reset();
  assert.equal(f.packets.at(-1).kind, 'end'); assert.equal(f.stats().stopped, 1); assert.equal(f.stats().closed, 1);
});

test('late permission result after logout cleanup cannot reopen microphone or peer connection', async () => {
  let resolveMedia;
  const f = browser({ media: () => new Promise(resolve => { resolveMedia = resolve; }) });
  await f.client.receive(f.invite);
  const permission = f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  await new Promise(setImmediate); f.client.reset(); resolveMedia(f.stream); await permission;
  assert.equal(f.stats().stopped, 1); assert.equal(f.client.active(), false);
  assert.ok(!f.packets.some(packet => packet.kind === 'accept'));
});
test('blocked autoplay provides an explicit playback button and successful retry clears it', async () => {
  let blocked = true;
  const f = browser({ play: async () => { if (blocked) { const error = Error('Autoplay blocked'); error.name = 'NotAllowedError'; throw error; } } });
  await f.client.receive(f.invite); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  f.peers[0].ontrack({ track: { kind: 'audio' }, streams: [f.stream] }); await new Promise(setImmediate);
  const button = f.nodes.find(node => node.textContent === 'پخش صدای مخاطب'); assert.equal(button.hidden, false);
  blocked = false; button.onclick(); await new Promise(setImmediate); assert.equal(button.hidden, true);
  f.client.reset(); assert.equal(f.stats().stopped, 1);
});
test('a video call without a usable camera continues as audio and can still receive video', async () => {
  const asked = [], stream = { getTracks: () => [{ stop() {} }] };
  const f = browser({ media: () => { const video = asked.length === 0; asked.push(video); if (video) { const error = Error('none'); error.name = 'NotFoundError'; throw error; } return stream; } });
  await f.client.receive(f.invite); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  assert.equal(f.packets.at(-1).kind, 'accept'); assert.equal(f.stats().captures, 2);
  assert.equal(f.nodes.find(node => node.className?.includes('call-camera')).hidden, true);
  assert.match(f.notices.at(-1), /دوربین/);
  f.client.reset();
});

test('the caller can re-offer on a live call to restart ICE, but the callee and an unaccepted call cannot', async t => {
  const f = fixture(t); await f.signal(alice, 'invite', { video: false });
  await assert.rejects(f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0' } }), /ترتیب/);
  await f.signal(bob, 'accept'); await f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0' } }); await f.signal(bob, 'answer', { payload: { type: 'answer', sdp: 'v=0' } });
  await assert.rejects(f.signal(bob, 'offer', { payload: { type: 'offer', sdp: 'v=0' } }), /ترتیب/);
  for (let i = 0; i < 100; i++) await f.signal(alice, 'ice', { payload: { candidate: 'candidate' } });
  await f.signal(alice, 'offer', { payload: { type: 'offer', sdp: 'v=0' } });
  await f.signal(alice, 'ice', { payload: { candidate: 'after-restart' } });
  await f.signal(bob, 'answer', { payload: { type: 'answer', sdp: 'v=0' } });
  assert.equal(f.events.at(-1).kind, 'answer');
});

function toneRecorder() {
  const played = [], stopped = [];
  const audioContext = class {
    currentTime = 0; destination = {};
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { const oscillator = { frequency: {}, connect() {}, start() { played.push(oscillator.frequency.value); }, stop(when) { if (when === undefined) stopped.push(oscillator.frequency.value); } }; return oscillator; }
  };
  return { audioContext, played, stopped };
}

test('the person called hears a melody that stops on answering', async () => {
  const tones = toneRecorder(), f = browser({ audioContext: tones.audioContext });
  await f.client.receive(f.invite);
  assert.deepEqual(tones.played.slice(0, 3), [659, 880, 1047], 'incoming tone must be the melody');
  assert.ok(!tones.played.includes(425), 'the callee must not hear the caller beep');
  await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  assert.ok(tones.stopped.length > 0, 'answering must silence the ring');
  f.client.reset();
  await f.client.receive(f.invite); assert.equal(f.client.active(), true); f.client.reset();
});

test('the caller hears a plain beep, then the end or busy tone', async () => {
  const tones = toneRecorder(), f = browser({ audioContext: tones.audioContext });
  await f.client.start(false);
  assert.deepEqual(tones.played, [425], 'the caller must hear only the beep while waiting');
  await f.client.receive({ event: 'call_signal', kind: 'decline', chatId: 'room', callId: 'browser-call', from: 'alice' });
  assert.deepEqual(tones.played.slice(1), [480, 480, 480], 'a declined call plays the busy tone');
  assert.equal(f.client.active(), false);

  const hungUp = toneRecorder(), g = browser({ audioContext: hungUp.audioContext });
  await g.client.start(false); g.client.reset();
  assert.deepEqual(hungUp.played, [425, 660, 440], 'cancelling plays the end tone');
});

test('a voice call does not retry when the microphone is refused', async () => {
  const f = browser({ media: () => { const error = Error('denied'); error.name = 'NotAllowedError'; throw error; } });
  await f.client.receive({ ...f.invite, video: false }); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  assert.equal(f.stats().captures, 1); assert.equal(f.client.active(), false); assert.match(f.notices.at(-1), /مجوز/);
});

test('a TURN credential failure falls back to direct connection instead of ending the call', async () => {
  const f = browser({ getIceServers: async () => { throw Error('TURN unavailable'); } });
  await f.client.receive(f.invite); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  assert.equal(f.packets.at(-1).kind, 'accept'); assert.equal(f.peers.length, 1); assert.equal(f.client.active(), true);
  f.client.reset();
});

test('a lost signaling socket keeps an accepted call and resends its ICE after reconnecting', async () => {
  let online = true;
  const f = browser({ send: (data, packets) => { if (!online) throw Error('offline'); packets.push(data); } });
  await f.client.receive(f.invite); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  await f.client.receive({ event: 'call_signal', kind: 'offer', chatId: 'room', callId: 'incoming', from: 'alice', payload: { type: 'offer', sdp: 'v=0' } });
  await new Promise(setImmediate);
  online = false; f.client.connectionLost();
  assert.equal(f.client.active(), true);
  f.peers[0].onicecandidate({ candidate: { toJSON: () => ({ candidate: 'late' }) } });
  assert.equal(f.client.active(), true, 'one unsent candidate must not end the call');
  online = true; f.client.connectionRestored();
  assert.deepEqual([f.packets.at(-1).kind, f.packets.at(-1).payload.candidate], ['ice', 'late']);
  f.client.reset();
});

test('losing the socket before a call is accepted still clears the ringing call', async () => {
  const f = browser(); await f.client.receive(f.invite);
  f.client.connectionLost();
  assert.equal(f.client.active(), false);
});

test('remote audio and video use independent sinks and voice calls do not display unrequested video', async () => {
  const f = browser(); await f.client.receive(f.invite); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  const sound = { kind: 'audio' }, image = { kind: 'video' }, audio = f.nodes.find(node => node.tag === 'audio'), video = f.nodes.find(node => node.className === 'call-remote');
  f.peers[0].ontrack({ track: sound }); const soundStream = audio.srcObject;
  f.peers[0].ontrack({ track: image }); await new Promise(setImmediate);
  assert.equal(audio.srcObject, soundStream); assert.equal(soundStream.getTracks()[0], sound); assert.equal(video.srcObject.getTracks()[0], image); assert.equal(video.muted, true);
  f.client.reset(); await f.client.receive({ ...f.invite, video: false }); await f.nodes.find(node => node.textContent === 'پذیرش تماس').onclick();
  f.peers[1].ontrack({ track: image }); assert.equal(video.hidden, true); assert.equal(video.srcObject, null); f.client.reset();
});
