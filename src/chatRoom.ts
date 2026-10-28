import { DurableObject } from "cloudflare:workers";
import { Env, ClientWsAction, ServerWsEvent, Message } from "./types.js";
import { historyOptions } from "./history.js";

interface WsAttachment {
  chatId: string;
  userId: string;
  username: string;
  displayName: string;
}

export class ChatRoom extends DurableObject<Env> {
  private sqlInitialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSql();
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
      `);
      this.sqlInitialized = true;
    } catch (err) {
      console.error("Failed to init DO SQLite:", err);
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

      if (!userId || !chatId) {
        return new Response("Missing room identity", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const attachment: WsAttachment = { chatId, userId, username, displayName };
      server.serializeAttachment(attachment);

      this.ctx.acceptWebSocket(server, [userId]);
      for (const socket of this.ctx.getWebSockets()) {
        const online = socket.deserializeAttachment() as WsAttachment | null;
        if (socket !== server && online?.userId) {
          server.send(JSON.stringify({ event: 'presence', userId: online.userId, status: 'online' }));
        }
      }

      // Broadcast user online event to others
      this.broadcast(
        { event: "presence", userId, status: "online" },
        server
      );

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
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

    let data: ClientWsAction;
    try {
      data = JSON.parse(message);
      if (!data || typeof data !== 'object' || !('action' in data)) throw new Error('Invalid action');
    } catch {
      ws.send(JSON.stringify({ event: "error", message: "فرمت پیام ارسالی نامعتبر است." }));
      return;
    }

    const sender = ws.deserializeAttachment() as WsAttachment | null;
    if (!sender?.chatId || !sender.userId) {
      ws.close(1008, 'Room identity changed; reconnect');
      return;
    }

    if (data.action === "ping") {
      ws.send(JSON.stringify({ event: "pong", timestamp: Date.now() }));
      return;
    }

    if ((data.action === 'send_message' || data.action === 'typing') && data.chatId !== sender.chatId) {
      ws.send(JSON.stringify({ event: 'error', message: 'شناسه گفتگو با اتصال شما مطابقت ندارد.' }));
      return;
    }

    if (data.action === "typing") {
      this.broadcast(
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
      if (text.length > 10000 || (data.clientMsgId !== undefined && (typeof data.clientMsgId !== 'string' || data.clientMsgId.length > 100))) {
        ws.send(JSON.stringify({ event: 'error', message: 'پیام ارسالی بیش از حد طولانی است.' }));
        return;
      }

      const messageId = crypto.randomUUID();
      const now = Date.now();
      const clientMsgId = data.clientMsgId || "";

      // 1. Save in DO SQLite
      try {
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
      } catch (err) {
        console.error("Failed to insert into DO SQLite:", err);
        ws.send(JSON.stringify({ event: 'error', message: 'ذخیره پیام انجام نشد؛ دوباره تلاش کنید.' }));
        return;
      }

      // 2. Update the global index before announcing the persisted message.
      await (
        (async () => {
          try {
            await this.env.DB.batch([
              this.env.DB.prepare(
                `INSERT INTO messages (id, chat_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)`
              ).bind(messageId, sender.chatId, sender.userId, text, now),
              this.env.DB.prepare(
                `UPDATE chats SET updated_at = MAX(updated_at, ?) WHERE id = ?`
              ).bind(now, sender.chatId),
            ]);
          } catch (dbErr) {
            console.error("Failed to sync message to D1:", dbErr);
          }
        })()
      );

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
      this.broadcast({ event: "new_message", message: msgPayload });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const sender = ws.deserializeAttachment() as WsAttachment | null;
    if (sender) {
      // Check if user has other open sockets in this room
      const userSockets = this.ctx.getWebSockets(sender.userId);
      if (userSockets.length <= 1) {
        this.broadcast({
          event: "presence",
          userId: sender.userId,
          status: "offline",
        });
      }
    }
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("DO WebSocket error:", error);
  }

  private broadcast(event: ServerWsEvent, excludeWs?: WebSocket) {
    const str = JSON.stringify(event);
    for (const s of this.ctx.getWebSockets()) {
      if (excludeWs && s === excludeWs) continue;
      try {
        s.send(str);
      } catch {
        // Socket closed or failed
      }
    }
  }
}
