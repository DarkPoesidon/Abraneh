const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Substitute only the platform base class to exercise a hibernated pre-upgrade attachment.
const source = require('node:fs').readFileSync('src/chatRoom.ts', 'utf8').replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { transformSync } = require('esbuild');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const moduleScope = { exports: {} };
vm.runInNewContext(code, { module: moduleScope, exports: moduleScope.exports, require: path => { if (['./history.js','./access.js','./http.js','./push.js','./maintenance.js','./room-backup.js','./calls.js'].includes(path)) return {}; throw new Error(path); }, console });

test('legacy sockets without a bound room fail closed before any database write or broadcast', async () => {
  let writes = 0, broadcasts = 0, closed = null;
  const ctx = { storage: { sql: { exec() { writes++; return { toArray: () => [] }; } }, transactionSync(fn) { return fn(); } }, getWebSockets() { broadcasts++; return []; } };
  const room = new moduleScope.exports.ChatRoom(ctx, { DB: { batch() { throw new Error('Must not reach D1'); } } });
  writes = 0;
  const socket = { deserializeAttachment: () => ({ userId: 'old-user', username: 'old', displayName: 'Old' }), close: (...args) => { closed = args; }, send() { throw new Error('Must not send a success'); } };
  await room.webSocketMessage(socket, JSON.stringify({ action: 'send_message', chatId: 'client-supplied', text: 'unsafe recovery' }));
  assert.equal(closed[0], 1008);
  assert.equal(writes, 0); assert.equal(broadcasts, 0);
});

test('call signals are handled in the order they arrive, however long their database checks take', async () => {
  // On real Cloudflare D1 latency varies, so a candidate could overtake its offer and end the caller's side.
  const handled = [], delays = [40, 0, 0];
  const scope = { exports: {} };
  vm.runInNewContext(code, { module: scope, exports: scope.exports, console, Date, JSON, setTimeout, require: path => {
    if (path === './maintenance.js') return { withOperation: (env, work) => work() };
    if (path === './access.js') return { SESSION_VERSION_SQL: '1', isBlocked: async () => false, chatAccess: () => new Promise(resolve => setTimeout(() => resolve(true), delays.shift())) };
    if (path === './calls.js') return { handleCall: async (env, sql, sender, data) => { handled.push(data.kind); return true; } };
    return {};
  } });
  const ctx = { storage: { sql: { exec() { return { toArray: () => [] }; } }, transactionSync(fn) { return fn(); } }, getWebSockets() { return []; } };
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'session', displayName: 'A' }) }) }) } };
  const room = new scope.exports.ChatRoom(ctx, env);
  const socket = { deserializeAttachment: () => ({ chatId: 'chat', userId: 'user', sessionId: 'session' }), serializeAttachment() {}, send() {}, close() {} };
  const frame = kind => JSON.stringify({ action: 'call_signal', chatId: 'chat', callId: 'call', kind });
  await Promise.all(['offer', 'ice', 'ice'].map(kind => room.webSocketMessage(socket, frame(kind))));
  assert.deepEqual(handled, ['offer', 'ice', 'ice']);
});
