import { handleCall, closeCall, callInbox, activeCall, CallEvent, CallIdentity } from './calls.js';
import { withOperation } from './maintenance.js';
import { ROOM_BACKUP_TABLES, roomBackupPage, restoreRoomTable } from './room-backup.js';
import { DurableObject } from "cloudflare:workers";
import { Env, ClientWsAction, ServerWsEvent, Message } from "./types.js";
import { historyOptions } from "./history.js";
import { chatAccess, isBlocked, manager, validId, normalizePersian, SESSION_VERSION_SQL } from './access.js';
import { InputError } from './http.js';
import { sendPush } from './push.js';

interface WsAttachment {
  chatId: string;
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
  inbox?: boolean;
  quiet?: boolean;
  typingAt?: number;
  typing?: boolean;
}

// SQLite rows in a Durable Object are capped at 2 MB, so longer recordings span several rows.
const MEDIA_CHUNK_BYTES = 1024 * 1024;
// shortcut: one flat cap per chat with no retention, add per-user quotas if a busy group ever reaches it.
const ROOM_MEDIA_BYTES = 256 * 1024 * 1024;

export class ChatRoom extends DurableObject<Env> {
  private sqlInitialized = false;
  private syncing = false;
  private pushing = false;
  private callSignals: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSql();
    if (this.ctx.blockConcurrencyWhile) this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.storage.sql.exec('SELECT 1 FROM sync_queue UNION ALL SELECT 1 FROM push_queue LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now() + 1000);
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
        CREATE TABLE IF NOT EXISTS message_details (message_id TEXT PRIMARY KEY,reply_to TEXT,edited_at INTEGER NOT NULL DEFAULT 0,deleted_at INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS message_reactions (message_id TEXT NOT NULL,user_id TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id));
        CREATE TABLE IF NOT EXISTS push_queue (message_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,after_id TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS message_forwards (message_id TEXT PRIMARY KEY,from_name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS message_media (message_id TEXT PRIMARY KEY,kind TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,duration_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS media_chunks (message_id TEXT NOT NULL,seq INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(message_id,seq));
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

  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==='/backup-page'){try{const body=await request.json<any>();return Response.json(roomBackupPage(this.ctx.storage.sql,body.table,body.offset));}catch{return Response.json({error:'صفحهٔ پشتیبان گفتگو معتبر نیست.'},{status:400});}}
    if(path==='/restore-table'){try{return Response.json({ok:true,...restoreRoomTable(this.ctx,await request.json())});}catch{return Response.json({error:'دادهٔ بازیابی گفتگو معتبر نیست.'},{status:409});}}
    if(path==='/restore-check'){
      const counts=await request.json<Record<string,number>>();
      if(JSON.stringify(Object.keys(counts).sort())!==JSON.stringify([...ROOM_BACKUP_TABLES].sort())||ROOM_BACKUP_TABLES.some(table=>counts[table]!==Number(this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0].n)))return Response.json({error:'تعداد تاریخچه متفاوت است.'},{status:409});
      if(this.ctx.storage.sql.exec('SELECT 1 FROM sync_queue LIMIT 1').toArray().length)await this.ctx.storage.setAlarm(Date.now()+30_000);
      return Response.json({ok:true});
    }
    try{return await withOperation(this.env,()=>this.roomFetch(request));}catch(error){return Response.json({error:error instanceof InputError?error.message:'گفتگو موقتاً در دسترس نیست.'},{status:503});}
  }
  private async roomFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/call-active' && request.method === 'POST') {
      const body = await request.json<{ userId: string; sid: string; callId: string }>();
      return new Response(null, { status: activeCall(this.ctx.storage.sql, body.userId, body.sid, body.callId) ? 204 : 403 });
    }
    if (url.pathname === '/call-inbox') {
      this.ctx.storage.sql.exec("DELETE FROM room_meta WHERE key LIKE 'incoming:%' AND json_extract(value,'$.expiresAt')<=?", Date.now());
      if (request.method !== 'GET') {
        const event = await request.json<CallEvent>(), key = 'incoming:' + event.chatId;
        if (request.method === 'PUT') {
          const count = Number(this.ctx.storage.sql.exec("SELECT count(*) AS n FROM room_meta WHERE key LIKE 'incoming:%'").toArray()[0].n);
          if (count >= 32) return new Response(null, { status: 429 });
          this.ctx.storage.sql.exec('INSERT INTO room_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(event));
        } else {
          this.ctx.storage.sql.exec("DELETE FROM room_meta WHERE key=? AND json_extract(value,'$.callId')=?", key, event.callId);
          for (const socket of this.ctx.getWebSockets('inbox')) try { socket.send(JSON.stringify({ kind: 'call-end', callId: event.callId, chatId: event.chatId })); } catch {}
        }
        return new Response(null, { status: 204 });
      }
      const count = this.ctx.storage.sql.exec('INSERT INTO send_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count', 'poll', Math.floor(Date.now()/60000)*60000).toArray()[0];
      if (Number(count.count) > 120) return Response.json({ error: 'Too many call checks' }, { status: 429 });
      return Response.json(this.ctx.storage.sql.exec("SELECT value FROM room_meta WHERE key LIKE 'incoming:%' LIMIT 32").toArray().map(row => JSON.parse(String(row.value))));
    }
    if (url.pathname === '/inbox-ws') {
      const sessionId = url.searchParams.get('sessionId') || '', [client, server] = Object.values(new WebSocketPair());
      // A dropped connection can stay half open here, so a reconnect takes over from it.
      for (const socket of this.ctx.getWebSockets('inbox')) if ((socket.deserializeAttachment() as WsAttachment | null)?.sessionId === sessionId) try { socket.close(4000, 'Replaced'); } catch {}
      server.serializeAttachment({ chatId: '', userId: url.searchParams.get('userId') || '', username: '', displayName: '', sessionId, inbox: true } satisfies WsAttachment);
      // Answered without waking this object, so idle phones cost almost nothing.
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
      this.ctx.acceptWebSocket(server, ['inbox']);
      // A browser socket sends its token as a protocol and fails unless one is chosen. The Android app asks for none.
      const protocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim()).includes('wihm.v1') ? 'wihm.v1' : null;
      return new Response(null, { status: 101, webSocket: client, ...(protocol ? { headers: { 'Sec-WebSocket-Protocol': protocol } } : {}) });
    }
    if (url.pathname === '/inbox-send' && request.method === 'POST') {
      const { sessionId, data } = await request.json<{ sessionId: string; data: unknown }>();
      for (const socket of this.ctx.getWebSockets('inbox')) if ((socket.deserializeAttachment() as WsAttachment | null)?.sessionId === sessionId) try { socket.send(JSON.stringify(data)); } catch {}
      return new Response(null, { status: 204 });
    }
    if ((url.pathname === '/call-decline' || url.pathname === '/call-end') && request.method === 'POST') {
      const sender = await request.json<CallIdentity & { callId: string }>();
      try { await handleCall(this.env, this.ctx.storage.sql, sender, { action: 'call_signal', chatId: sender.chatId, callId: sender.callId, kind: url.pathname === '/call-end' ? 'end' : 'decline' }, event => this.deliverCall(event)); return Response.json({ ok: true }); }
      catch (error) { return Response.json({ error: error instanceof InputError ? error.message : 'رد تماس کامل نشد.' }, { status: error instanceof InputError ? error.status : 500 }); }
    }

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

      const quiet = url.searchParams.get('quiet') === '1';
      const attachment: WsAttachment = { chatId, userId, username, displayName, sessionId, ...(quiet ? { quiet } : {}) };
      server.serializeAttachment(attachment);

      const protocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim()).includes('wihm.v1') ? 'wihm.v1' : null;
      this.ctx.acceptWebSocket(server, [userId]);
      // A channel must not reveal who else is subscribed.
      if (!quiet) for (const socket of await this.authorizedSockets()) {
        const online = socket.deserializeAttachment() as WsAttachment | null;
        if (socket !== server && online?.userId) {
          server.send(JSON.stringify({ event: 'presence', userId: online.userId, status: 'online' }));
        }
      }

      // Broadcast user online event to others
      if (!quiet) await this.broadcast(
        { event: "presence", userId, status: "online" },
        server
      );

      return new Response(null, {
        status: 101,
        webSocket: client,
        ...(protocol ? { headers: { 'Sec-WebSocket-Protocol': protocol } } : {}),
      });
    }

    if (url.pathname === '/media-upload' && request.method === 'POST') return this.uploadMedia(url, request);
    if (url.pathname === '/media') {
      const id = url.searchParams.get('id') || '', meta = this.ctx.storage.sql.exec('SELECT mime,size FROM message_media WHERE message_id=?', id).toArray()[0];
      if (!meta) return new Response(null, { status: 404 });
      const bytes = new Uint8Array(Number(meta.size)); let offset = 0;
      for (const row of this.ctx.storage.sql.exec('SELECT data FROM media_chunks WHERE message_id=? ORDER BY seq', id)) { const part = new Uint8Array(row.data as ArrayBuffer); bytes.set(part, offset); offset += part.byteLength; }
      return new Response(bytes, { headers: { 'Content-Type': String(meta.mime) } });
    }

    if (url.pathname === '/message') {
      const row = this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id = ?', url.searchParams.get('id') || '').toArray()[0];
      return Response.json(row || null);
    }
    if(url.pathname==='/message-snapshot'&&request.method==='POST') {
      const {ids,chatId}=await request.json<{ids:string[];chatId:string}>();
      return Response.json(ids.map(id=>this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id=?',id).toArray()[0]).filter(Boolean).map(row=>this.payload(row,chatId)));
    }
    if (url.pathname === '/revoke-user' && request.method==='POST') {
      const {userId}=await request.json<{userId:string}>();
      for(const socket of this.ctx.getWebSockets())if((socket.deserializeAttachment() as WsAttachment|null)?.userId===userId)try{socket.send(JSON.stringify({event:'session_revoked'}));socket.close(4001,'Account disabled');}catch{}
      return new Response(null,{status:204});
    }
    if (url.pathname === '/refresh-access') { await this.authorizedSockets(); return new Response(null,{status:204}); }
    if (url.pathname === '/import-posts' && request.method === 'POST') {
      const { chatId, posts } = await request.json<{ chatId: string; posts: { id: string; author: string; name: string; text: string; createdAt: number }[] }>();
      this.ctx.storage.transactionSync(() => {
        for (const post of posts) {
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO messages (id, sender_id, sender_name, text, created_at, client_msg_id) VALUES (?,?,?,?,?,'')", post.id, post.author, post.name, post.text, post.createdAt);
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO message_details(message_id) VALUES (?)', post.id);
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO sync_queue VALUES (?,?)', post.id, chatId);
        }
      });
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/forward-text' && request.method === 'POST') {
      const { chatId, userId, displayName, text, from } = await request.json<{ chatId: string; userId: string; displayName: string; text: string; from: string }>();
      if (!this.withinSendLimit(userId)) return Response.json({ error: 'تعداد پیام‌ها زیاد است؛ یک دقیقه صبر کنید و دوباره تلاش کنید.' }, { status: 429 });
      const messageId = this.storeMessage({ chatId, userId, displayName }, text, '', null);
      this.ctx.storage.sql.exec('INSERT INTO message_forwards VALUES (?,?)', messageId, from);
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return Response.json({ message: await this.announceMessage(messageId, chatId) }, { status: 201 });
    }
    if (url.pathname === '/wipe-room' && request.method === 'POST') {
      for (const socket of this.ctx.getWebSockets()) try { socket.close(4003, 'Chat deleted'); } catch {}
      await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll();
      this.sqlInitialized = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/moderation-delete' && request.method === 'POST') {
      try { return Response.json({ message: await this.applyMessageAction({ ...await request.json<any>(), action: 'delete' }, true) }); }
      catch (error) { if (error instanceof InputError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
    }
    if (url.pathname === '/message-action' && request.method==='POST') {
      try { return Response.json({message:await this.applyMessageAction(await request.json<any>())}); }
      catch (error) { if(error instanceof InputError) return Response.json({error:error.message},{status:error.status}); throw error; }
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
      const userId=url.searchParams.get('userId'),chatId=url.searchParams.get('chatId');
      const hidden=userId&&chatId ? (await this.env.DB.prepare('SELECT message_id FROM message_hidden WHERE user_id=? AND chat_id=?').bind(userId,chatId).all<{message_id:string}>()).results.map(row=>row.message_id) : [];
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, sender_id as senderId, sender_name as senderName, text, created_at as createdAt, client_msg_id as clientMsgId 
           FROM messages WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) AND id NOT IN(SELECT value FROM json_each(?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          beforeTime, beforeTime, beforeTime, beforeId,
          JSON.stringify(hidden),limit
        )
        .toArray();

      return new Response(JSON.stringify(rows.reverse().map(row=>this.payload({id:row.id,sender_id:row.senderId,sender_name:row.senderName,text:row.text,created_at:row.createdAt,client_msg_id:row.clientMsgId},chatId||''))), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){
    // Each frame awaits D1 first, so without this queue a candidate can overtake the offer it follows.
    if(typeof message==='string'&&message.includes('"call_signal"')){const turn=this.callSignals.then(()=>this.socketMessage(ws,message));this.callSignals=turn.catch(()=>{});return turn;}
    return this.socketMessage(ws,message);
  }
  private async socketMessage(ws:WebSocket,message:string|ArrayBuffer){
    const sender=ws.deserializeAttachment() as WsAttachment|null;
    if(sender?.inbox)return;
    if(!sender?.chatId||!sender.sessionId)return this.roomMessage(ws,message);
    try{await withOperation(this.env,()=>this.roomMessage(ws,message));}
    catch(error){let clientMsgId;try{clientMsgId=JSON.parse(String(message)).clientMsgId;}catch{}try{ws.send(JSON.stringify({event:'error',clientMsgId,retryable:true,message:error instanceof InputError?error.message:'ارتباط موقتاً قطع است؛ دوباره تلاش کنید.'}));}catch{}}
  }
  private async roomMessage(ws: WebSocket, message: string | ArrayBuffer) {
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
      const authorized = await this.env.DB.prepare(`SELECT s.id,u.display_name AS displayName FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id = ? AND s.user_id = ?
        AND s.revoked_at IS NULL AND s.expires_at > ? AND ${SESSION_VERSION_SQL}`)
        .bind(sender.sessionId, sender.userId, Date.now()).first<{id:string;displayName:string}>();
      if (!authorized) { ws.send(JSON.stringify({ event: 'session_revoked' })); ws.close(4001, 'Session expired or revoked'); return; }
      sender.displayName=authorized.displayName;ws.serializeAttachment(sender);
      const access=await chatAccess(this.env,sender.chatId,sender.userId);
      if (!access||await isBlocked(this.env,sender.chatId,sender.userId)) {
        ws.send(JSON.stringify({event:'chat_access_revoked',chatId:sender.chatId})); ws.close(4003,'Chat access changed'); return;
      }
      // Channel subscribers only read, and nobody's typing is shown to them.
      if (access.isChannel&&data.action==='typing') return;
      if (access.isChannel&&data.action==='send_message'&&!manager(access.role)) { ws.send(JSON.stringify({event:'error',clientMsgId:data.clientMsgId,retryable:false,message:'در کانال فقط مدیران می‌توانند پست بگذارند.'})); return; }
    } catch { ws.close(1011, 'Session check unavailable'); return; }

    if(data.action==='call_signal'){try{await handleCall(this.env,this.ctx.storage.sql,sender,data,event=>this.deliverCall(event));}catch(error){ws.send(JSON.stringify({event:'call_error',callId:data.callId,kind:data.kind,message:error instanceof InputError?error.message:'تماس انجام نشد.'}));}return;}
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

      const clientMsgId = data.clientMsgId || "";
      const previous = clientMsgId && this.ctx.storage.sql.exec(`SELECT m.* FROM message_keys k JOIN messages m ON m.id = k.message_id WHERE k.sender_id = ? AND k.client_msg_id = ?`, sender.userId, clientMsgId).toArray()[0];
      if (previous) {
        const details=this.ctx.storage.sql.exec('SELECT edited_at,deleted_at FROM message_details WHERE message_id=?',previous.id).toArray()[0];
        if (previous.text !== text && !details?.edited_at && !details?.deleted_at) { ws.send(JSON.stringify({ event: 'error', clientMsgId, retryable: false, message: 'این شناسه قبلاً برای پیام دیگری استفاده شده است.' })); return; }
        // An acknowledgment lost on the network must not create another message or broadcast.
        ws.send(JSON.stringify({ event: 'new_message', message: this.payload(previous, sender.chatId) }));
        await this.syncPending();
        return;
      }
      if (!this.withinSendLimit(sender.userId)) {
        ws.send(JSON.stringify({ event: 'error', clientMsgId, retryable: true, message: 'تعداد پیام‌ها زیاد است؛ یک دقیقه صبر کنید و دوباره تلاش کنید.' }));
        return;
      }
      let messageId: string;
      let replyToId: string | null = null;
      if (data.replyToId !== undefined) {
        if (!validId(data.replyToId)||!await this.materialize(data.replyToId,sender.chatId)) { ws.send(JSON.stringify({event:'error',clientMsgId,retryable:false,message:'پیام مورد پاسخ پیدا نشد.'})); return; }
        replyToId=data.replyToId;
      }
      try {
        messageId = this.storeMessage(sender, text, clientMsgId, replyToId);
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } catch (err) {
        console.error("Failed to insert into DO SQLite:", err);
        ws.send(JSON.stringify({ event: 'error', clientMsgId, retryable: true, message: 'تأیید ذخیره دریافت نشد؛ دوباره تلاش کنید.' }));
        return;
      }

      await this.announceMessage(messageId, sender.chatId);
    }
  }

  private withinSendLimit(userId: string) {
    const counter = this.ctx.storage.sql.exec(`INSERT INTO send_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET
      count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count`, userId, Math.floor(Date.now() / 60_000) * 60_000).toArray()[0];
    return Number(counter.count) <= 120;
  }

  // Persist the canonical message, deduplication key, media and synchronization job atomically.
  private storeMessage(sender: { chatId: string; userId: string; displayName: string }, text: string, clientMsgId: string, replyToId: string | null, media?: { kind: string; mime: string; durationMs: number; bytes: Uint8Array }) {
    // A newly accepted message must sort after an already acknowledged read cursor,
    // even when several messages arrive in the same millisecond.
    const last = this.ctx.storage.sql.exec('SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1').toArray()[0];
    const now = Math.max(Date.now(), Number(last?.created_at || 0) + 1);
    const messageId = crypto.randomUUID();
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
      this.ctx.storage.sql.exec('INSERT INTO message_details(message_id,reply_to) VALUES (?,?)',messageId,replyToId);
      this.ctx.storage.sql.exec('INSERT INTO sync_queue VALUES (?,?)', messageId, sender.chatId);
      this.ctx.storage.sql.exec('INSERT INTO push_queue(message_id,chat_id) VALUES (?,?)',messageId,sender.chatId);
      if (media) {
        this.ctx.storage.sql.exec('INSERT INTO message_media VALUES (?,?,?,?,?)', messageId, media.kind, media.mime, media.bytes.byteLength, media.durationMs);
        for (let seq = 0, offset = 0; offset < media.bytes.byteLength; seq++, offset += MEDIA_CHUNK_BYTES) this.ctx.storage.sql.exec('INSERT INTO media_chunks VALUES (?,?,?)', messageId, seq, media.bytes.slice(offset, offset + MEDIA_CHUNK_BYTES).buffer);
      }
    });
    return messageId;
  }

  private async announceMessage(messageId: string, chatId: string) {
    await this.syncPending();
    const message = this.payload(this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id=?',messageId).toArray()[0],chatId);
    // Broadcast to all connected sockets in this chat room
    await this.broadcast({ event: "new_message", message });
    this.ctx.waitUntil(this.flushPush().catch(()=>console.warn('Push delivery deferred or unavailable.')));
    return message;
  }

  private async uploadMedia(url: URL, request: Request) {
    const query = url.searchParams, chatId = query.get('chatId')!, userId = query.get('userId')!, clientMsgId = query.get('clientMsgId') || '';
    const refuse = (error: string, status: number) => Response.json({ error }, { status });
    // A retry after a lost response must not store the recording twice.
    const previous = clientMsgId && this.ctx.storage.sql.exec('SELECT m.* FROM message_keys k JOIN messages m ON m.id = k.message_id WHERE k.sender_id = ? AND k.client_msg_id = ?', userId, clientMsgId).toArray()[0];
    if (previous) return Response.json({ message: this.payload(previous, chatId) });
    if (!this.withinSendLimit(userId)) return refuse('تعداد پیام‌ها زیاد است؛ یک دقیقه صبر کنید و دوباره تلاش کنید.', 429);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const used = Number(this.ctx.storage.sql.exec('SELECT COALESCE(SUM(size),0) AS n FROM message_media').toArray()[0].n);
    if (used + bytes.byteLength > ROOM_MEDIA_BYTES) return refuse('فضای فایل‌های این گفتگو پر است؛ فایل‌های قدیمی را حذف کنید.', 413);
    const replyToId = query.get('replyToId') || null;
    if (replyToId && !await this.materialize(replyToId, chatId)) return refuse('پیام مورد پاسخ پیدا نشد.', 400);
    const messageId = this.storeMessage({ chatId, userId, displayName: query.get('displayName') || 'کاربر' }, query.get('text') || '', clientMsgId, replyToId, { kind: query.get('kind')!, mime: query.get('mime')!, durationMs: Number(query.get('durationMs')), bytes });
    if (query.get('forwardedFrom')) this.ctx.storage.sql.exec('INSERT INTO message_forwards VALUES (?,?)', messageId, query.get('forwardedFrom'));
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return Response.json({ message: await this.announceMessage(messageId, chatId) }, { status: 201 });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const closing=ws.deserializeAttachment() as WsAttachment|null;if(closing?.chatId)await closeCall(this.ctx.storage.sql,closing,event=>this.deliverCall(event));
    const sender = ws.deserializeAttachment() as WsAttachment | null;
    if (sender && !sender.inbox) {
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
    const details=this.ctx.storage.sql.exec('SELECT * FROM message_details WHERE message_id=?',row.id).toArray()[0];
    const reactions=this.ctx.storage.sql.exec('SELECT user_id,emoji FROM message_reactions WHERE message_id=?',row.id).toArray();
    const grouped=new Map<string,string[]>(); for(const reaction of reactions) grouped.set(String(reaction.emoji),[...(grouped.get(String(reaction.emoji))||[]),String(reaction.user_id)]);
    const media=this.ctx.storage.sql.exec('SELECT kind,mime,size,duration_ms FROM message_media WHERE message_id=?',row.id).toArray()[0];
    const forward=this.ctx.storage.sql.exec('SELECT from_name FROM message_forwards WHERE message_id=?',row.id).toArray()[0];
    const parent=details?.reply_to ? this.ctx.storage.sql.exec('SELECT m.*,d.deleted_at FROM messages m LEFT JOIN message_details d ON d.message_id=m.id WHERE m.id=?',details.reply_to).toArray()[0] : null;
    return { id: row.id, chatId, senderId: row.sender_id, senderName: row.sender_name, text: details?.deleted_at ? '' : row.text, createdAt: row.created_at, clientMsgId: row.client_msg_id || '',
      replyToId: details?.reply_to ? String(details.reply_to) : null, replyTo: parent ? {id:String(parent.id),text:parent.deleted_at?'':String(parent.text),senderName:String(parent.sender_name),deleted:!!parent.deleted_at}:null,
      editedAt:Number(details?.edited_at||0),deletedAt:Number(details?.deleted_at||0),revision:Number(details?.revision||0),reactions:details?.deleted_at?[]:[...grouped].map(([emoji,users])=>({emoji,users})),
      ...(forward&&!details?.deleted_at?{forwardedFrom:String(forward.from_name)}:{}),
      ...(media?{media:{kind:String(media.kind),mime:String(media.mime),size:Number(media.size),durationMs:Number(media.duration_ms)}}:{}) };
  }

  private async materialize(id: string,chatId: string): Promise<any> {
    const local=this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id=?',id).toArray()[0]; if(local) return local;
    const row=await this.env.DB.prepare(`SELECT m.*,u.display_name AS sender_name,md.client_msg_id,d.reply_to,d.edited_at,d.deleted_at,d.revision FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN message_metadata md ON md.message_id=m.id LEFT JOIN message_details d ON d.message_id=m.id WHERE m.id=? AND m.chat_id=?`).bind(id,chatId).first<any>();
    if(!row) return null;
    const reactions=(await this.env.DB.prepare('SELECT user_id,emoji FROM message_reactions WHERE message_id=?').bind(id).all()).results;
    this.ctx.storage.transactionSync(()=>{
      if(this.ctx.storage.sql.exec('SELECT 1 FROM messages WHERE id=?',id).toArray().length) return;
      this.ctx.storage.sql.exec('INSERT INTO messages VALUES (?,?,?,?,?,?)',id,row.sender_id,row.sender_name,row.text,row.created_at,row.client_msg_id||'');
      this.ctx.storage.sql.exec('INSERT INTO message_details VALUES (?,?,?,?,?)',id,row.reply_to||null,row.edited_at||0,row.deleted_at||0,row.revision||0);
      for(const reaction of reactions) this.ctx.storage.sql.exec('INSERT INTO message_reactions VALUES (?,?,?)',id,reaction.user_id,reaction.emoji);
    });
    return this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id=?',id).toArray()[0];
  }

  // `moderator` is set only by the internal moderation route, never from a request body.
  private async applyMessageAction(data: any, moderator = false): Promise<Message> {
    if(!validId(data.messageId)||!validId(data.chatId)||(!moderator&&(!validId(data.actor)||!validId(data.sessionId)))) throw new InputError('درخواست پیام معتبر نیست.');
    const access=moderator?null:await chatAccess(this.env,data.chatId,data.actor);
    if(!moderator) {
      const session=await this.env.DB.prepare(`SELECT s.id FROM user_sessions s WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND ${SESSION_VERSION_SQL}`).bind(data.sessionId,data.actor,Date.now()).first();
      if(!access||!session) throw new InputError('دسترسی شما به گفتگو پایان یافته است.',403);
      if(data.action!=='delete'&&await isBlocked(this.env,data.chatId,data.actor)) throw new InputError('این گفتگوی خصوصی مسدود است.',403);
    }
    const row=await this.materialize(data.messageId,data.chatId); if(!row) throw new InputError('پیام پیدا نشد.',404);
    const details=this.ctx.storage.sql.exec('SELECT * FROM message_details WHERE message_id=?',row.id).toArray()[0];
    if(data.action==='edit' && (row.sender_id!==data.actor||details?.deleted_at)) throw new InputError('فقط پیام خودتان را پیش از حذف می‌توانید ویرایش کنید.',403);
    if(data.action==='edit' && this.ctx.storage.sql.exec('SELECT 1 FROM message_media WHERE message_id=?',row.id).toArray().length) throw new InputError('پیام صوتی و تصویری قابل ویرایش نیست.');
    if(!moderator&&data.action==='delete' && row.sender_id!==data.actor && !(access!.type==='group'&&manager(access!.role))) throw new InputError('اجازهٔ حذف این پیام برای همه را ندارید.',403);
    if(data.action==='edit' && (typeof data.text!=='string'||!data.text.trim()||data.text.trim().length>10000)) throw new InputError('متن پیام بین ۱ تا ۱۰٬۰۰۰ کاراکتر است.');
    if(data.action==='reaction' && (details?.deleted_at||!['','👍','❤️','😂','😮','😢','🙏'].includes(data.emoji))) throw new InputError('واکنش معتبر نیست یا پیام حذف شده است.');
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO message_details(message_id) VALUES (?)',row.id);
      if(data.action==='edit') { this.ctx.storage.sql.exec('UPDATE messages SET text=? WHERE id=?',data.text.trim(),row.id); this.ctx.storage.sql.exec('UPDATE message_details SET edited_at=? WHERE message_id=?',Date.now(),row.id); }
      else if(data.action==='delete') { this.ctx.storage.sql.exec("UPDATE messages SET text='' WHERE id=?",row.id); this.ctx.storage.sql.exec('UPDATE message_details SET deleted_at=? WHERE message_id=?',Date.now(),row.id); this.ctx.storage.sql.exec('DELETE FROM message_reactions WHERE message_id=?',row.id); this.ctx.storage.sql.exec('DELETE FROM message_media WHERE message_id=?',row.id); this.ctx.storage.sql.exec('DELETE FROM media_chunks WHERE message_id=?',row.id); }
      else if(data.action==='reaction') { if(data.emoji) this.ctx.storage.sql.exec('INSERT INTO message_reactions VALUES (?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji',row.id,data.actor,data.emoji); else this.ctx.storage.sql.exec('DELETE FROM message_reactions WHERE message_id=? AND user_id=?',row.id,data.actor); }
      else throw new InputError('عملیات پیام معتبر نیست.');
      this.ctx.storage.sql.exec('UPDATE message_details SET revision=revision+1 WHERE message_id=?',row.id);
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO sync_queue VALUES (?,?)',row.id,data.chatId);
    });
    await this.ctx.storage.setAlarm(Date.now()+1000); await this.syncPending();
    const message=this.payload(this.ctx.storage.sql.exec('SELECT * FROM messages WHERE id=?',row.id).toArray()[0],data.chatId);
    await this.broadcast({event:'message_changed',message}); return message;
  }

  async alarm() { try{await withOperation(this.env,async()=>{await this.syncPending();await this.flushPush();});}catch(error){await this.ctx.storage.setAlarm(Date.now()+30_000);if(!(error instanceof InputError))throw error;} }

  private async flushPush() {
    if(this.pushing) return;this.pushing=true;
    let failed=true;
    try {
      const job=this.ctx.storage.sql.exec('SELECT q.*,m.* FROM push_queue q JOIN messages m ON m.id=q.message_id ORDER BY m.created_at,m.id LIMIT 1').toArray()[0];
      if(job) {
        const message=this.payload(job,String(job.chat_id));
        const cursor=message.deletedAt||Date.now()-message.createdAt>3600_000?null:await sendPush(this.env,message,fetch,String(job.after_id));
        if(cursor) this.ctx.storage.sql.exec('UPDATE push_queue SET after_id=? WHERE message_id=?',cursor,job.id);
        else this.ctx.storage.sql.exec('DELETE FROM push_queue WHERE message_id=?',job.id);
      }
      failed=false;
    } finally {this.pushing=false;await this.scheduleWork(60_000,failed?60_000:1000);}
  }

  private async scheduleWork(retryDelay=60_000,pushDelay=1000) {
    if(this.ctx.storage.sql.exec('SELECT 1 FROM push_queue LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now()+pushDelay);
    else if(this.ctx.storage.sql.exec('SELECT 1 FROM sync_queue LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now()+retryDelay);
    else await this.ctx.storage.deleteAlarm();
  }

  private async syncPending() {
    if(this.syncing) return; this.syncing=true;
    let failed=false;
    try {
      const rows = this.ctx.storage.sql.exec(`SELECT m.*, q.chat_id,d.reply_to,COALESCE(d.edited_at,0) AS edited_at,COALESCE(d.deleted_at,0) AS deleted_at,COALESCE(d.revision,0) AS revision FROM sync_queue q JOIN messages m ON m.id = q.message_id LEFT JOIN message_details d ON d.message_id=m.id ORDER BY m.created_at,m.id LIMIT 10`).toArray();
      for (const row of rows) {
        const reactions=this.ctx.storage.sql.exec('SELECT user_id,emoji FROM message_reactions WHERE message_id=?',row.id).toArray();
        await this.env.DB.batch([
          this.env.DB.prepare('INSERT INTO messages (id,chat_id,sender_id,text,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text').bind(row.id, row.chat_id, row.sender_id, row.text, row.created_at),
          this.env.DB.prepare('INSERT OR IGNORE INTO message_metadata VALUES (?,?)').bind(row.id, row.client_msg_id || ''),
          this.env.DB.prepare('INSERT INTO message_details VALUES (?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=excluded.reply_to,edited_at=excluded.edited_at,deleted_at=excluded.deleted_at,revision=excluded.revision').bind(row.id,row.reply_to||null,row.edited_at,row.deleted_at,row.revision),
          this.env.DB.prepare('DELETE FROM message_reactions WHERE message_id=?').bind(row.id),
          this.env.DB.prepare("INSERT INTO message_reactions SELECT ?,json_extract(value,'$.user_id'),json_extract(value,'$.emoji') FROM json_each(?)").bind(row.id,JSON.stringify(reactions)),
          this.env.DB.prepare('INSERT INTO message_search VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET normalized=excluded.normalized').bind(row.id,row.chat_id,normalizePersian(row.deleted_at?'':String(row.text))),
          this.env.DB.prepare('UPDATE chats SET updated_at = MAX(updated_at,?) WHERE id = ?').bind(row.created_at, row.chat_id),
        ]);
        const current=this.ctx.storage.sql.exec('SELECT revision FROM message_details WHERE message_id=?',row.id).toArray()[0];
        if(Number(current?.revision||0)===Number(row.revision)) this.ctx.storage.sql.exec('DELETE FROM sync_queue WHERE message_id = ?', row.id);
      }
    } catch { failed=true; /* The canonical SQLite copy is durable; retry the global index via an alarm. */ }
    finally { this.syncing=false; }
    await this.scheduleWork(failed?60_000:1000);
  }

  private async authorizedSockets(): Promise<WebSocket[]> {
    const sockets = this.ctx.getWebSockets();
    const sessions = [...new Set(sockets.map(socket => (socket.deserializeAttachment() as WsAttachment | null)?.sessionId).filter((id): id is string => !!id))];
    const allowed = new Set<string>();
    for (let start = 0; start < sessions.length; start += 80) {
      const batch = sessions.slice(start, start + 80);
      const { results } = await this.env.DB.prepare(`SELECT s.id FROM user_sessions s WHERE s.id IN (${batch.map(() => '?').join(',')}) AND s.revoked_at IS NULL AND s.expires_at > ? AND ${SESSION_VERSION_SQL}`).bind(...batch, Date.now()).all<{ id: string }>();
      results.forEach(row => allowed.add(row.id));
    }
    const membership=new Set<string>();
    const roomIds=[...new Set(sockets.map(socket=>(socket.deserializeAttachment() as WsAttachment|null)?.chatId).filter((id):id is string=>!!id))];
    for(const chatId of roomIds) {
      const {results}=await this.env.DB.prepare(`SELECT cm.user_id FROM chat_members cm JOIN chats c ON c.id=cm.chat_id WHERE cm.chat_id=? AND NOT EXISTS(SELECT 1 FROM chat_moderation cmod WHERE cmod.chat_id=c.id) AND (c.type!='dm' OR NOT EXISTS(SELECT 1 FROM blocked_users b JOIN chat_members other ON other.chat_id=cm.chat_id AND other.user_id!=cm.user_id WHERE (b.blocker_id=cm.user_id AND b.blocked_id=other.user_id) OR (b.blocker_id=other.user_id AND b.blocked_id=cm.user_id)))`).bind(chatId).all<{user_id:string}>();
      for(const row of results) membership.add(chatId+':'+row.user_id);
    }
    const permitted:WebSocket[]=[];
    for(const socket of sockets) {
      const identity = socket.deserializeAttachment() as WsAttachment | null;
      if(identity?.sessionId&&allowed.has(identity.sessionId)) {
        if(membership.has(identity.chatId+':'+identity.userId)) {permitted.push(socket);continue;}
        try {socket.send(JSON.stringify({event:'chat_access_revoked',chatId:identity.chatId}));socket.close(4003,'Chat access changed');} catch {}
      } else try {socket.close(4001,'Session expired or revoked');} catch {}
    }
    return permitted;
  }

  private async deliverCall(event:CallEvent){
    if(event.kind==='invite') {
      await callInbox(this.env,event.toUserId,'PUT',event);
      this.ctx.waitUntil((async()=>{
        let after='';
        const caller=await this.env.DB.prepare('SELECT display_name AS name FROM users WHERE id=?').bind(event.from).first<{name:string}>();
        do { after=await sendPush(this.env,{id:event.callId,chatId:event.chatId,senderId:event.from,senderName:caller?.name||'',text:'',createdAt:Date.now()},fetch,after,{callId:event.callId,expiresAt:event.expiresAt!,video:event.video})||''; }
        while(after&&event.expiresAt!>Date.now());
      })().catch(error=>console.warn('Incoming call notification failed:',error instanceof Error?error.message:'unknown')));
    }
    else if(['accept','decline','end','claimed'].includes(event.kind)) await Promise.all([...new Set([event.from,event.toUserId])].map(id=>callInbox(this.env,id,'DELETE',event)));
    for(const socket of await this.authorizedSockets()){const peer=socket.deserializeAttachment() as WsAttachment|null;if(peer?.userId===event.toUserId&&(!event.toSessionId||peer.sessionId===event.toSessionId))try{socket.send(JSON.stringify(event));}catch{}}
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
