const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Substitute only the platform base class to exercise a hibernated pre-upgrade attachment.
const source = require('node:fs').readFileSync('src/chatRoom.ts', 'utf8').replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { transformSync } = require('esbuild');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const moduleScope = { exports: {} };
vm.runInNewContext(code, { module: moduleScope, exports: moduleScope.exports, require: path => { if (path === './history.js') return {}; throw new Error(path); }, console });

test('legacy sockets without a bound room fail closed before any database write or broadcast', async () => {
  let writes = 0, broadcasts = 0, closed = null;
  const ctx = { storage: { sql: { exec() { writes++; } } }, getWebSockets() { broadcasts++; return []; } };
  const room = new moduleScope.exports.ChatRoom(ctx, { DB: { batch() { throw new Error('Must not reach D1'); } } });
  writes = 0;
  const socket = { deserializeAttachment: () => ({ userId: 'old-user', username: 'old', displayName: 'Old' }), close: (...args) => { closed = args; }, send() { throw new Error('Must not send a success'); } };
  await room.webSocketMessage(socket, JSON.stringify({ action: 'send_message', chatId: 'client-supplied', text: 'unsafe recovery' }));
  assert.equal(closed[0], 1008);
  assert.equal(writes, 0); assert.equal(broadcasts, 0);
});
