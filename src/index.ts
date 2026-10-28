import { Env, User, UserRow, Chat } from "./types.js";
import { hashPassword, verifyPassword, generateSalt, signJwt, verifyJwt, hasJwtSecret } from "./auth.js";
import { historyOptions } from "./history.js";
export { ChatRoom } from "./chatRoom.js";

// CORS Response Helper
function corsResponse(body: BodyInit | null, status = 200, headers: HeadersInit = {}): Response {
  const mergedHeaders = new Headers(headers);
  mergedHeaders.set("Access-Control-Allow-Origin", "*");
  mergedHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  mergedHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(body, { status, headers: mergedHeaders });
}

function jsonResponse(data: unknown, status = 200): Response {
  return corsResponse(JSON.stringify(data), status, {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

async function validatedMembers(value: unknown, env: Env, self: string): Promise<string[] | null> {
  if (!Array.isArray(value) || value.length > 99 || value.some(id => typeof id !== 'string' || !id)) return null;
  const ids = [...new Set<string>(value)].filter(id => id !== self);
  if (!ids.length) return null;
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  return results.length === ids.length ? ids : null;
}

// Authenticate request via Bearer token or ?token=
async function authenticate(request: Request, env: Env): Promise<{ userId: string; username: string; displayName: string } | null> {
  const authHeader = request.headers.get("Authorization");
  let token = "";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else {
    const url = new URL(request.url);
    token = url.searchParams.get("token") || "";
  }

  if (!token) return null;
  return await verifyJwt(token, env.JWT_SECRET);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    if ((url.pathname.startsWith('/api/') || url.pathname === '/ws') && !hasJwtSecret(env.JWT_SECRET)) {
      return errorResponse('کلید امنیتی سرور تنظیم نشده است؛ JWT_SECRET باید حداقل ۳۲ بایت باشد.', 503);
    }

    // ==========================================
    // 1. WebSocket Gateway (/ws or /api/ws)
    // ==========================================
    if (url.pathname === "/ws" || url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return errorResponse("Expected WebSocket upgrade", 426);
      }

      const auth = await authenticate(request, env);
      if (!auth) {
        return errorResponse("احراز هویت انجام نشد یا توکن نامعتبر است.", 401);
      }

      const chatId = url.searchParams.get("chatId");
      if (!chatId) {
        return errorResponse("شناسه چت (chatId) مشخص نشده است.", 400);
      }

      // Verify user membership in this chat
      const member = await env.DB.prepare(
        `SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`
      ).bind(chatId, auth.userId).first();

      if (!member) {
        return errorResponse("شما عضو این گفتگو نیستید.", 403);
      }

      // Route to Durable Object instance for this chat room
      const doId = env.CHAT_ROOM.idFromName(chatId);
      const stub = env.CHAT_ROOM.get(doId);

      const doUrl = new URL('https://room.internal/ws');
      doUrl.searchParams.set('chatId', chatId);
      doUrl.searchParams.set("userId", auth.userId);
      doUrl.searchParams.set("username", auth.username);
      doUrl.searchParams.set("displayName", auth.displayName);

      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ==========================================
    // 2. REST API Routes (/api/*)
    // ==========================================
    if (url.pathname.startsWith("/api/")) {
      try {
        // --- AUTH: REGISTER ---
        if (url.pathname === "/api/auth/register" && request.method === "POST") {
          const body = await request.json<any>();
          const username = String(body.username || "").trim().toLowerCase();
          const password = String(body.password || "");
          const displayName = String(body.displayName || username).trim() || username;
          if (displayName.length > 100) return errorResponse('نام نمایشی باید حداکثر ۱۰۰ کاراکتر باشد.');

          if (!username || username.length < 3 || username.length > 20) {
            return errorResponse("نام کاربری باید بین ۳ تا ۲۰ کاراکتر باشد.");
          }
          if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return errorResponse("نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و خط زیر (_) باشد.");
          }
          if (!password || password.length < 6 || password.length > 1024) {
            return errorResponse("رمز عبور باید حداقل ۶ کاراکتر باشد.");
          }

          // Check duplicate
          const existing = await env.DB.prepare(
            `SELECT id FROM users WHERE username = ?`
          ).bind(username).first();

          if (existing) {
            return errorResponse("این نام کاربری قبلاً انتخاب شده است.");
          }

          const salt = generateSalt();
          const passwordHash = await hashPassword(password, salt);
          const userId = crypto.randomUUID();
          const now = Date.now();

          await env.DB.prepare(
            `INSERT INTO users (id, username, password_hash, salt, display_name, created_at) 
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(userId, username, passwordHash, salt, displayName, now).run();

          const user: User = { id: userId, username, displayName, createdAt: now };
          const token = await signJwt({ userId, username, displayName }, env.JWT_SECRET);

          return jsonResponse({ token, user }, 201);
        }

        // --- AUTH: LOGIN ---
        if (url.pathname === "/api/auth/login" && request.method === "POST") {
          const body = await request.json<any>();
          const username = String(body.username || "").trim().toLowerCase();
          const password = String(body.password || "");

          if (!username || !password) {
            return errorResponse("نام کاربری و رمز عبور الزامی است.");
          }

          const row = await env.DB.prepare(
            `SELECT * FROM users WHERE username = ?`
          ).bind(username).first<UserRow>();

          if (!row) {
            return errorResponse("نام کاربری یا رمز عبور اشتباه است.", 401);
          }

          const isValid = await verifyPassword(password, row.salt, row.password_hash);
          if (!isValid) {
            return errorResponse("نام کاربری یا رمز عبور اشتباه است.", 401);
          }

          const user: User = {
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            createdAt: row.created_at,
          };
          const token = await signJwt({ userId: user.id, username: user.username, displayName: user.displayName }, env.JWT_SECRET);

          return jsonResponse({ token, user });
        }

        // Authentication guard for subsequent API endpoints
        const auth = await authenticate(request, env);
        if (!auth) {
          return errorResponse("احراز هویت نشده‌اید.", 401);
        }

        // --- AUTH: GET CURRENT USER ---
        if (url.pathname === "/api/auth/me" && request.method === "GET") {
          const row = await env.DB.prepare(
            `SELECT id, username, display_name, created_at FROM users WHERE id = ?`
          ).bind(auth.userId).first<any>();

          if (!row) return errorResponse("کاربر یافت نشد.", 404);
          return jsonResponse({
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            createdAt: row.created_at,
          });
        }

        // --- USERS: SEARCH ---
        if (url.pathname === "/api/users/search" && request.method === "GET") {
          const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
          if (!q) return jsonResponse([]);

          const { results } = await env.DB.prepare(
            `SELECT id, username, display_name as displayName, created_at as createdAt 
             FROM users 
             WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) 
             LIMIT 20`
          ).bind(auth.userId, `%${q}%`, `%${q}%`).all<User>();

          return jsonResponse(results || []);
        }

        // --- CHATS: LIST USER CHATS ---
        if (url.pathname === "/api/chats" && request.method === "GET") {
          const { results } = await env.DB.prepare(`
            SELECT 
              c.id, 
              c.type, 
              c.title, 
              c.created_at as createdAt, 
              c.updated_at as updatedAt,
              u.id as partnerId,
              u.username as partnerUsername,
              u.display_name as partnerDisplayName,
              (
                SELECT m.id FROM messages m
                WHERE m.chat_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageId,
              (
                SELECT m.text FROM messages m 
                WHERE m.chat_id = c.id 
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageText,
              (
                SELECT m.created_at FROM messages m 
                WHERE m.chat_id = c.id 
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageTime,
              (
                SELECT snd.display_name FROM messages m 
                JOIN users snd ON m.sender_id = snd.id
                WHERE m.chat_id = c.id 
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageSender
            FROM chats c
            JOIN chat_members cm ON c.id = cm.chat_id AND cm.user_id = ?
            LEFT JOIN chat_members pm ON c.id = pm.chat_id AND pm.user_id != ? AND c.type = 'dm'
            LEFT JOIN users u ON pm.user_id = u.id
            ORDER BY c.updated_at DESC
          `).bind(auth.userId, auth.userId).all<any>();

          const chats = (results || []).map((row) => {
            const isDm = row.type === "dm";
            const title = isDm ? (row.partnerDisplayName || row.partnerUsername || "گفتگو") : (row.title || "گروه");
            return {
              id: row.id,
              type: row.type,
              title,
              partnerId: row.partnerId,
              partnerUsername: row.partnerUsername,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              lastMessage: row.lastMessageText ? {
                id: row.lastMessageId,
                text: row.lastMessageText,
                senderName: row.lastMessageSender || "",
                createdAt: row.lastMessageTime || row.updatedAt,
              } : null,
            };
          });

          return jsonResponse(chats);
        }

        // --- CHATS: CREATE OR GET DM/GROUP ---
        if (url.pathname === "/api/chats" && request.method === "POST") {
          const body = await request.json<any>();
          const type = body.type === "group" ? "group" : "dm";
          const now = Date.now();

          if (type === "dm") {
            const targetUserId = String(body.targetUserId || "");
            if (!targetUserId || targetUserId === auth.userId) {
              return errorResponse("شناسه مخاطب نامعتبر است.");
            }
            const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetUserId).first();
            if (!target) return errorResponse('مخاطب یافت نشد.', 404);

            // Check if DM already exists
            const existing = await env.DB.prepare(`
              SELECT c.id FROM chats c
              JOIN chat_members m1 ON c.id = m1.chat_id AND m1.user_id = ?
              JOIN chat_members m2 ON c.id = m2.chat_id AND m2.user_id = ?
              WHERE c.type = 'dm'
              ORDER BY c.created_at, c.id
            `).bind(auth.userId, targetUserId).first<{ id: string }>();

            if (existing) {
              return jsonResponse({ id: existing.id, isNew: false });
            }

            // The same pair produces the same primary key, including concurrent requests from both sides.
            const pair = JSON.stringify([auth.userId, targetUserId].sort());
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair)));
            const chatId = 'dm_' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
            const created = await env.DB.batch([
              env.DB.prepare(`INSERT OR IGNORE INTO chats (id, type, title, created_at, updated_at) VALUES (?, 'dm', NULL, ?, ?)`).bind(chatId, now, now),
              env.DB.prepare(`INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).bind(chatId, auth.userId, now),
              env.DB.prepare(`INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).bind(chatId, targetUserId, now),
            ]);

            const isNew = created[0].meta.changes > 0;
            return jsonResponse({ id: chatId, isNew }, isNew ? 201 : 200);
          } else {
            // Group Chat
            const title = String(body.title || "گروه جدید").trim();
            if (!title || title.length > 100) return errorResponse('عنوان گروه باید بین ۱ تا ۱۰۰ کاراکتر باشد.');
            const members = await validatedMembers(body.memberIds, env, auth.userId);
            if (!members) return errorResponse('حداقل یک عضو معتبر انتخاب کنید (حداکثر ۹۹ نفر).');
            const chatId = crypto.randomUUID();

            await env.DB.batch([
              env.DB.prepare(`INSERT INTO chats (id, type, title, created_at, updated_at) VALUES (?, 'group', ?, ?, ?)`).bind(chatId, title, now, now),
              env.DB.prepare(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).bind(chatId, auth.userId, now),
              ...members.map(id => env.DB.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').bind(chatId, id, now)),
            ]);

            return jsonResponse({ id: chatId, isNew: true }, 201);
          }
        }

        const membersMatch = url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/members$/);
        if (membersMatch && (request.method === 'GET' || request.method === 'POST')) {
          const chatId = membersMatch[1];
          const member = await env.DB.prepare('SELECT c.type FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE c.id = ? AND cm.user_id = ?').bind(chatId, auth.userId).first<{ type: string }>();
          if (!member) return errorResponse('شما عضو این گفتگو نیستید.', 403);
          if (request.method === 'POST') {
            if (member.type !== 'group') return errorResponse('افزودن عضو فقط برای گروه امکان‌پذیر است.');
            const body = await request.json<any>();
            const users = await validatedMembers(body.userIds, env, auth.userId);
            if (!users) return errorResponse('اعضای انتخاب‌شده نامعتبر هستند.');
            // Existing members are harmless duplicates; only current members may invite.
            await env.DB.prepare(`INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at)
              SELECT ?, id, ? FROM users WHERE id IN (${users.map(() => '?').join(',')})`)
              .bind(chatId, Date.now(), ...users).run();
          }
          const { results } = await env.DB.prepare(`SELECT u.id, u.username, u.display_name as displayName
            FROM users u JOIN chat_members cm ON cm.user_id = u.id WHERE cm.chat_id = ? ORDER BY cm.joined_at, u.id`).bind(chatId).all();
          return jsonResponse(results);
        }

        // --- CHATS: GET MESSAGES HISTORY ---
        const historyMatch = url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/messages$/);
        if (historyMatch && request.method === "GET") {
          const chatId = historyMatch[1];

          // Check membership
          const isMember = await env.DB.prepare(
            `SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`
          ).bind(chatId, auth.userId).first();

          if (!isMember) {
            return errorResponse("دسترسی به این چت امکان‌پذیر نیست.", 403);
          }

          let options;
          try { options = historyOptions(url.searchParams); }
          catch (err: any) { return errorResponse(err.message); }
          const { limit, beforeTime, beforeId } = options;

          // Read both durable copies so a partial cache cannot hide older D1 history.
          const doId = env.CHAT_ROOM.idFromName(chatId);
          const stub = env.CHAT_ROOM.get(doId);
          let roomMessages: any[] = [];
          try {
            const doRes = await stub.fetch(`http://internal/history${url.search}`);
            if (doRes.ok) {
              const messages = await doRes.json<any[]>();
              if (Array.isArray(messages)) roomMessages = messages.map(message => ({ ...message, chatId }));
            }
          } catch (err) {
            console.error('Room history unavailable; using D1', err);
          }

          // Fallback to D1
          const { results } = await env.DB.prepare(`
            SELECT 
              m.id, 
              m.chat_id as chatId, 
              m.sender_id as senderId, 
              u.display_name as senderName, 
              m.text, 
              m.created_at as createdAt 
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.chat_id = ? AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ?
          `).bind(chatId, beforeTime, beforeTime, beforeTime, beforeId, limit).all();

          const combined = new Map<string, any>();
          for (const message of [...(results || []), ...roomMessages]) combined.set(message.id, message);
          const messages = [...combined.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
          return jsonResponse(messages.slice(0, limit).reverse());
        }

        return errorResponse("مسیر درخواستی یافت نشد.", 404);
      } catch (err: any) {
        console.error("API Error:", err);
        return errorResponse(err?.message || "خطای داخلی سرور", 500);
      }
    }

    // ==========================================
    // 3. Static Assets & PWA Fallback
    // ==========================================
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Cloudflare Messenger Backend Ready", { status: 200 });
  },
};
