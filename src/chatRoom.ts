import { DurableObject } from "cloudflare:workers";
import { Env, ClientWsAction, ServerWsEvent, Message } from "./types.js";
import { historyOptions } from "./history.js";

interface WsAttachment {
  chatId: string;
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
  typingAt?: number;
  typing?: boolean;
}

export class ChatRoom extends DurableObject<Env> {
  private sqlInitialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSql();
    if (this.ctx.blockConcurrencyWhile) this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.storage.sql.exec('SELECT 1 FROM sync_queue LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  private initSql() {
    if (this.sqlInitialized) return;
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          client_msg_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_do_msg_time ON messages(created_at ASC);
        CREATE TABLE IF NOT EXISTS message_keys (
          sender_id TEXT NOT NULL, client_msg_id TEXT NOT NULL, message_id TEXT NOT NULL,
          PRIMARY KEY (sender_id, client_msg_id)
        );
        CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sync_queue (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS send_limits (user_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
      `);
      if (!this.ctx.storage.sql.exec("SELECT 1 FROM room_meta WHERE key = 'dedupe-v1'").toArray().length) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO message_keys SELECT sender_id,client_msg_id,id FROM messages
            WHERE client_msg_id IS NOT NULL AND client_msg_id != '' ORDER BY created_at,id`);
          this.ctx.storage.sql.exec("INSERT INTO room_meta VALUES ('dedupe-v1','done')");
        });
      }
      this.sqlInitialized = true;
    } catch (err) {
      console.error("Failed to init DO SQLite:", err);
      throw err;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. WebSocket Upgrade Handler
    if (request.headers.get("Upgrade") === "websocket") {
      const userId = url.searchParams.get("userId") || "";
      const chatId = url.searchParams.get("chatId") || "";
      const username = url.searchParams.get("username") || "";
      const displayName = url.searchParams.get("displayName") || username || "کاربر";
      const sessionId = url.searchParams.get('sessionId') || '';

      if (!userId || !chatId || !sessionId) {
        return new Response("Missing room identity", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const attachment: WsAttachment = { chatId, userId, username, displayName, sessionId };
      server.serializeAttachment(attachment);

      this.ctx.acceptWebSocket(server, [userId]);
      for (const socket of await this.authorizedSockets()) {
        const online = socket.deserializeAttachment() as WsAttachment | null;
        if (socket !== server && online?.userId) {
          server.send(JSON.stringify({ event: 'presence', userId: online.userId, status: 'online' }));
        }
      }

      // Broadcast user online event to others
      await this.broadcast(
        { event: "presence", userId, status: "online" },
        server
      );

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (url.pathname === '/message') {
      const row = this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id = ?', url.searchParams.get('id') || '').toArray()[0];
      return Response.json(row || null);
    }
    if (url.pathname === '/receipts' && request.method === 'POST') {
      await this.broadcast(await request.json<ServerWsEvent>());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/revoke-sessions' && request.method === 'POST') {
      const { userId, ids } = await request.json<{ userId: string; ids: string[] }>();
      for (const socket of this.ctx.getWebSockets()) {
        const identity = socket.deserializeAttachment() as WsAttachment | null;
        if (identity?.userId === userId && ids.includes(identity.sessionId)) {
          socket.send(JSON.stringify({ event: 'session_revoked' }));
          socket.close(4001, 'Session revoked');
        }
      }
      return new Response(null, { status: 204 });
    }

    // 2. Fetch history directly from SQLite inside DO
    if (url.pathname.endsWith("/history")) {
      let options;
      try { options = historyOptions(url.searchParams); }
      catch { return new Response('Invalid history cursor', { status: 400 }); }
      const { limit, beforeTime, beforeId } = options;
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, sender_id as senderId, sender_name as senderName, text, created_at as createdAt, client_msg_id as clientMsgId 
           FROM messages WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          beforeTime, beforeTime, beforeTime, beforeId,
          limit
        )
        .toArray();

      return new Response(JSON.stringify(rows.reverse()), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message.length > 64_000) { ws.close(1009, 'Message too large'); return; }

    let data: ClientWsAction;
    try {
      data = JSON.parse(message);
      if (!data || typeof data !== 'object' || !('action' in data)) throw new Error('Invalid action');
    } catch {
      ws.send(JSON.stringify({ event: "error", message: "فرمت پیام ارسالی نامعتبر است." }));
      return;
    }

    const sender = ws.deserializeAttachment() as WsAttachment | null;
    if (!sender?.chatId || !sender.userId || !sender.sessionId) {
      ws.close(1008, 'Room identity changed; reconnect');
      return;
    }

    try {
      const authorized = await this.env.DB.prepare(`SELECT s.id FROM user_sessions s WHERE s.id = ? AND s.user_id = ?
        AND s.revoked_at IS NULL AND s.expires_at > ? AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = s.user_id)`)
        .bind(sender.sessionId, sender.userId, Date.now(), sender.chatId).first();
      if (!authorized) { ws.send(JSON.stringify({ event: 'session_revoked' })); ws.close(4001, 'Session expired or revoked'); return; }
    } catch { ws.close(1011, 'Session check unavailable'); return; }

    if (data.action === "ping") {
      ws.send(JSON.stringify({ event: "pong", timestamp: Date.now() }));
      return;
    }

    if ((data.action === 'send_message' || data.action === 'typing') && data.chatId !== sender.chatId) {
      ws.send(JSON.stringify({ event: 'error', message: 'شناسه گفتگو با اتصال شما مطابقت ندارد.' }));
      return;
    }

    if (data.action === "typing") {
      if (data.isTyping && Date.now() - (sender.typingAt || 0) < 1000) return;
      if (!data.isTyping && !sender.typing) return;
      sender.typingAt = Date.now(); sender.typing = !!data.isTyping; ws.serializeAttachment(sender);
      await this.broadcast(
        {
          event: "typing",
          chatId: sender.chatId,
          userId: sender.userId,
          username: sender.displayName,
          isTyping: !!data.isTyping,
        },
        ws
      );
      return;
    }

    if (data.action === "send_message") {
      const text = String(data.text || "").trim();
      if (!text) return;
      if (text.length > 10000 || (data.clientMsgId !== undefined && (typeof data.clientMsgId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.clientMsgId)))) {
        ws.send(JSON.stringify({ event: 'error', message: 'پیام ارسالی بیش از حد طولانی است.' }));
        return;
      }

      const clock = Date.now();
      // A newly accepted message must sort after an already acknowledged read cursor,
      // even when several messages arrive in the same millisecond.
      const last = this.ctx.storage.sql.exec('SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1').toArray()[0];
      const now = Math.max(clock, Number(last?.created_at || 0) + 1);
      const clientMsgId = data.clientMsgId || "";
      const previous = clientMsgId && this.ctx.storage.sql.exec(`SELECT m.* FROM message_keys k JOIN messages m ON m.id = k.message_id WHERE k.sender_id = ? AND k.client_msg_id = ?`, sender.userId, clientMsgId).toArray()[0];
      if (previous) {
        if (previous.text !== text) { ws.send(JSON.stringify({ event: 'error', clientMsgId, retryable: false, message: 'این شناسه قبلاً برای پیام دیگری استفاده شده است.' })); return; }
        // An acknowledgment lost on the network must not create another message or broadcast.
        ws.send(JSON.stringify({ event: 'new_message', message: this.payload(previous, sender.chatId) }));
        await this.syncPending();
        return;
      }
      const windowStart = Math.floor(clock / 60_000) * 60_000;
      const counter = this.ctx.storage.sql.exec(`INSERT INTO send_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET
        count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count`, sender.userId, windowStart).toArray()[0];
      if (Number(counter.count) > 120) {
        ws.send(JSON.stringify({ event: 'error', clientMsgId, retryable: true, message: 'تعداد پیام‌ها زیاد است؛ یک دقیقه صبر کنید و دوباره تلاش کنید.' }));
        return;
      }
      const messageId = crypto.randomUUID();
      // Persist the canonical message, deduplication key and synchronization job atomically.
      try {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
          `INSERT INTO messages (id, sender_id, sender_name, text, created_at, client_msg_id) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          messageId,
          sender.userId,
          sender.displayName,
          text,
          now,
          clientMsgId
          );
          if (clientMsgId) this.ctx.storage.sql.exec('INSERT INTO message_keys VALUES (?,?,?)', sender.userId, clientMsgId, messageId);
          this.ctx.storage.sql.exec('INSERT INTO sync_queue VALUES (?,?)', messageId, sender.chatId);
        });
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } catch (err) {
        console.error("Failed to insert into DO SQLite:", err);
        ws.send(JSON.stringify({ event: 'error', clientMsgId, retryable: true, message: 'تأیید ذخیره دریافت نشد؛ دوباره تلاش کنید.' }));
        return;
      }

      await this.syncPending();

      const msgPayload: Message = {
        id: messageId,
        chatId: sender.chatId,
        senderId: sender.userId,
        senderName: sender.displayName,
        text,
        createdAt: now,
        clientMsgId,
      };

      // 3. Broadcast to all connected sockets in this chat room
      await this.broadcast({ event: "new_message", message: msgPayload });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const sender = ws.deserializeAttachment() as WsAttachment | null;
    if (sender) {
      // Check if user has other open sockets in this room
      const userSockets = this.ctx.getWebSockets(sender.userId);
      if (userSockets.length <= 1) {
        await this.broadcast({
          event: "presence",
          userId: sender.userId,
          status: "offline",
        });
      }
    }
    if (code !== 1006) ws.close(code === 1005 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("DO WebSocket error:", error);
  }

  private payload(row: any, chatId: string): Message {
    return { id: row.id, chatId, senderId: row.sender_id, senderName: row.sender_name, text: row.text, createdAt: row.created_at, clientMsgId: row.client_msg_id || '' };
  }

  async alarm() { await this.syncPending(); }

  private async syncPending() {
    const rows = this.ctx.storage.sql.exec(`SELECT m.*, q.chat_id FROM sync_queue q JOIN messages m ON m.id = q.message_id ORDER BY m.created_at,m.id LIMIT 25`).toArray();
    try {
      for (const row of rows) {
        await this.env.DB.batch([
          this.env.DB.prepare('INSERT OR IGNORE INTO messages (id,chat_id,sender_id,text,created_at) VALUES (?,?,?,?,?)').bind(row.id, row.chat_id, row.sender_id, row.text, row.created_at),
          this.env.DB.prepare('INSERT OR IGNORE INTO message_metadata VALUES (?,?)').bind(row.id, row.client_msg_id || ''),
          this.env.DB.prepare('UPDATE chats SET updated_at = MAX(updated_at,?) WHERE id = ?').bind(row.created_at, row.chat_id),
        ]);
        this.ctx.storage.sql.exec('DELETE FROM sync_queue WHERE message_id = ?', row.id);
      }
    } catch { /* The canonical SQLite copy is durable; retry the global index via an alarm. */ }
    if (this.ctx.storage.sql.exec('SELECT 1 FROM sync_queue LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    else await this.ctx.storage.deleteAlarm();
  }

  private async authorizedSockets(): Promise<WebSocket[]> {
    const sockets = this.ctx.getWebSockets();
    const sessions = [...new Set(sockets.map(socket => (socket.deserializeAttachment() as WsAttachment | null)?.sessionId).filter((id): id is string => !!id))];
    const allowed = new Set<string>();
    for (let start = 0; start < sessions.length; start += 80) {
      const batch = sessions.slice(start, start + 80);
      const { results } = await this.env.DB.prepare(`SELECT id FROM user_sessions WHERE id IN (${batch.map(() => '?').join(',')}) AND revoked_at IS NULL AND expires_at > ?`).bind(...batch, Date.now()).all<{ id: string }>();
      results.forEach(row => allowed.add(row.id));
    }
    return sockets.filter(socket => {
      const identity = socket.deserializeAttachment() as WsAttachment | null;
      if (identity?.sessionId && allowed.has(identity.sessionId)) return true;
      try { socket.close(4001, 'Session expired or revoked'); } catch { /* Already closing. */ }
      return false;
    });
  }

  private async broadcast(event: ServerWsEvent, excludeWs?: WebSocket) {
    const str = JSON.stringify(event);
    for (const s of await this.authorizedSockets()) {
      if (excludeWs && s === excludeWs) continue;
      try {
        s.send(str);
      } catch {
        // Socket closed or failed
      }
    }
  }
}
