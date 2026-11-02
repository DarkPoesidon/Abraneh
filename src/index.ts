import { publicChannels, handleChannels, scheduledChannels } from './channels.js';
import { handleCallRequests, userInbox } from './calls.js';
import { registerNativeDevice } from './push.js';
import { handleMedia } from './media.js';
import { beginOperation, withOperation } from './maintenance.js';
import { handleBackup, publicRestore } from './backup.js';
import { Env, User, UserRow } from "./types.js";
import { hashPassword, verifyPassword, generateSalt, hasJwtSecret } from "./auth.js";
import { historyOptions } from "./history.js";
import { requestIdentity, issueSession, revokeSessions } from './sessions.js';
import { allowRequest } from './limits.js';
import { APP_VERSION } from './version.js';
import { listReceipts, saveReceipt } from './receipts.js';
import { corsResponse, jsonResponse, errorResponse, InputError, inputJson } from './http.js';
import { chatAccess, MEMBER_LIMIT_SQL, isBlocked } from './access.js';
import { handleFeatures, registrationMode, registrationGate, enrichMessages, enrichChats } from './features.js';
import { handleUpdates, scheduledUpdates } from './updates.js';
import { handleTelegram, telegramWebhook, scheduledTelegram } from './telegram.js';
import { handleManagement } from './management.js';
import { publicSecurity, handleSecurity, enforceSecondFactor } from './security.js';
import { publicSecure, handleSecure, scheduledSecure } from './secure.js';
import { publicDiscovery, handleDiscovery } from './discovery.js';
export { ChatRoom } from "./chatRoom.js";

const CHANNEL_HANDLE = /^[a-z][a-z0-9_]{4,31}$/;
function channelSettings(body: any) {
  const visibility = body.visibility === 'public' ? 'public' : 'private';
  const handle = visibility === 'public' ? String(body.handle || '').trim().toLowerCase() : null;
  if (visibility === 'public' && !CHANNEL_HANDLE.test(handle!)) throw new InputError('نشانی کانال عمومی باید با حرف انگلیسی شروع شود و ۵ تا ۳۲ حرف، عدد یا _ باشد.');
  const description = String(body.description || '').trim();
  if (description.length > 255) throw new InputError('توضیح کانال حداکثر ۲۵۵ کاراکتر است.');
  return { visibility, handle, description };
}
async function validatedMembers(value: unknown, env: Env, self: string): Promise<string[] | null> {
  if (!Array.isArray(value) || value.length > 99 || value.some(id => typeof id !== 'string' || !id)) return null;
  const ids = [...new Set<string>(value)].filter(id => id !== self);
  if (!ids.length) return null;
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  return results.length === ids.length ? ids : null;
}

// Authenticate request via Bearer token or ?token=
const authenticate = requestIdentity;

export default {
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext) {
    ctx.waitUntil(withOperation(env,()=>Promise.allSettled([scheduledUpdates(env),scheduledTelegram(env),scheduledSecure(env),scheduledChannels(env)])).catch(()=>{}));
  },
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const path=new URL(request.url).pathname;
    const tracked=request.method!=='OPTIONS'&&(path.startsWith('/api/')||path==='/ws'||path==='/.well-known/wihm')&&!['/api/health','/api/app/version'].includes(path)&&!path.startsWith('/api/service/backup/')&&!path.startsWith('/api/_restore/');
    try{return tracked&&hasJwtSecret(env.JWT_SECRET)?await withOperation(env,()=>applicationFetch(request,env,ctx)):await applicationFetch(request,env,ctx);}
    catch(error){return errorResponse(error instanceof InputError?error.message:'عملیات سرویس کامل نشد؛ دوباره تلاش کنید.',error instanceof InputError?error.status:503);}
  },
};

async function applicationFetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    if ((url.pathname.startsWith('/api/') || url.pathname === '/ws') && !hasJwtSecret(env.JWT_SECRET)) {
      return errorResponse('کلید امنیتی سرور تنظیم نشده است؛ JWT_SECRET باید حداقل ۳۲ بایت باشد.', 503);
    }

    const discoveryPublic=await publicDiscovery(request,env);if(discoveryPublic)return discoveryPublic;
    if(url.pathname==='/api/app/version'&&request.method==='GET')return jsonResponse({version:APP_VERSION});
    if (url.pathname === '/api/health' && request.method === 'GET') {
      try {
        const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('broadcast_channels','chat_moderation','chat_deletions','users','chats','chat_members','messages','user_sessions','session_policy','rate_limits','message_metadata','chat_receipts','schema_migrations','user_profiles','account_security','session_security','group_roles','chat_preferences','message_details','message_reactions','message_hidden','chat_pins','saved_messages','blocked_users','group_invites','group_redemptions','service_admins','site_settings','registration_invites','abuse_reports','push_subscriptions','message_search','telegram_bots','telegram_sources','telegram_subscriptions','telegram_posts','service_user_state','discovery_profiles','service_audit','service_control','service_operations','service_restore','passkeys','security_challenges','user_totp','security_recovery','secure_devices','secure_prekeys','secure_events','secure_outbox','secure_nonces','secure_blocks','secure_peer_keys','channels','channel_members','channel_posts','channel_tokens','channel_webhooks','channel_outbox')").first<{ n: number }>();
        const ready = row?.n === 59;
        return jsonResponse({ app: 'wihm-cloudflare', version: APP_VERSION, database: ready }, ready ? 200 : 503);
      } catch {
        return jsonResponse({ app: 'wihm-cloudflare', version: APP_VERSION, database: false }, 503);
      }
    }

    if (url.pathname === '/api/ws/inbox') {
      if (request.headers.get('Upgrade') !== 'websocket') return errorResponse('Expected WebSocket upgrade', 426);
      const auth = await authenticate(request, env);
      if (!auth) return errorResponse('احراز هویت انجام نشد یا توکن نامعتبر است.', 401);
      await registerNativeDevice(env, auth.userId, auth.sid);
      const inboxUrl = new URL('https://room.internal/inbox-ws');
      inboxUrl.searchParams.set('userId', auth.userId); inboxUrl.searchParams.set('sessionId', auth.sid);
      return userInbox(env, auth.userId).fetch(new Request(inboxUrl.toString(), request));
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
      const member = await chatAccess(env, chatId, auth.userId);

      if (!member) {
        return errorResponse("شما عضو این گفتگو نیستید.", 403);
      }
      if (await isBlocked(env,chatId,auth.userId)) return errorResponse('این گفتگوی خصوصی مسدود است.',403);

      // Route to Durable Object instance for this chat room
      const doId = env.CHAT_ROOM.idFromName(chatId);
      const stub = env.CHAT_ROOM.get(doId);

      const doUrl = new URL('https://room.internal/ws');
      doUrl.searchParams.set('chatId', chatId);
      doUrl.searchParams.set("userId", auth.userId);
      doUrl.searchParams.set("username", auth.username);
      doUrl.searchParams.set("displayName", auth.displayName);
      doUrl.searchParams.set('sessionId', auth.sid);
      if (member.isChannel) doUrl.searchParams.set('quiet', '1');

      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ==========================================
    // 2. REST API Routes (/api/*)
    // ==========================================
    if (url.pathname.startsWith("/api/")) {
      try {
        const restorePublic=await publicRestore(request,env);if(restorePublic)return restorePublic;
        const channelsPublic=await publicChannels(request,env);if(channelsPublic)return channelsPublic;
        const securityPublic=await publicSecurity(request,env);if(securityPublic)return securityPublic;
        const securePublic=await publicSecure(request,env,ctx);if(securePublic)return securePublic;
        const webhook=await telegramWebhook(request,env);if(webhook)return webhook;
        if (url.pathname === '/api/bootstrap' && request.method === 'GET') return jsonResponse({ registration: await registrationMode(env) });
        // --- AUTH: REGISTER ---
        if (url.pathname === "/api/auth/register" && request.method === "POST") {
          if (!await allowRequest(env, 'register', request.headers.get('CF-Connecting-IP') || 'unknown', 30, 3600_000)) return errorResponse('تعداد ثبت‌نام از این اتصال زیاد است. یک ساعت دیگر دوباره تلاش کنید.', 429);
          const body = await inputJson(request);
          const gate = await registrationGate(env, body.inviteToken);
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
          if (!password || password.length < 8 || password.length > 1024) {
            return errorResponse("رمز عبور باید حداقل ۸ کاراکتر باشد.");
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

          const inserts = await env.DB.batch([
            env.DB.prepare(`INSERT INTO users (id,username,password_hash,salt,display_name,created_at)
              SELECT ?,?,?,?,?,? WHERE (? = '' AND COALESCE((SELECT value FROM site_settings WHERE key='registration'),'open')='open') OR (COALESCE((SELECT value FROM site_settings WHERE key='registration'),'open')='invite' AND EXISTS (SELECT 1 FROM registration_invites WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < use_limit))`)
              .bind(userId,username,passwordHash,salt,displayName,now,gate,gate,now),
            env.DB.prepare('UPDATE registration_invites SET uses = uses + 1 WHERE token_hash = ? AND EXISTS (SELECT 1 FROM users WHERE id = ?)').bind(gate,userId),
          ]);
          if (!inserts[0].meta.changes) return errorResponse('دعوت ثبت‌نام منقضی یا مصرف شده است.',403);

          const user: User = { id: userId, username, displayName, createdAt: now };
          const token = await issueSession(request, env, user);

          return jsonResponse({ token, user }, 201);
        }

        // --- AUTH: LOGIN ---
        if (url.pathname === "/api/auth/login" && request.method === "POST") {
          const body = await inputJson(request);
          const username = String(body.username || "").trim().toLowerCase();
          const password = String(body.password || "");
          const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
          if (!await allowRequest(env, 'login-ip', ip, 100, 15 * 60_000) || !await allowRequest(env, 'login-name', ip + ':' + username, 15, 15 * 60_000)) return errorResponse('تعداد تلاش ورود زیاد است. ۱۵ دقیقه دیگر دوباره تلاش کنید.', 429);

          if (!username || !password) {
            return errorResponse("نام کاربری و رمز عبور الزامی است.");
          }

          const row = await env.DB.prepare(
            `SELECT u.*, COALESCE(ac.password_version,1) AS authVersion FROM users u LEFT JOIN account_security ac ON ac.user_id = u.id WHERE u.username = ?`
          ).bind(username).first<UserRow & { authVersion: number }>();

          if (!row) {
            // Spend the same time as a wrong password, so timing doesn't reveal which usernames exist.
            await hashPassword(password, '00000000000000000000000000000000');
            return errorResponse("نام کاربری یا رمز عبور اشتباه است.", 401);
          }

          const isValid = await verifyPassword(password, row.salt, row.password_hash);
          if (!isValid) {
            return errorResponse("نام کاربری یا رمز عبور اشتباه است.", 401);
          }

          await enforceSecondFactor(env,row.id,body);
          const user: User = {
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            createdAt: row.created_at,
          };
          const token = await issueSession(request, env, user, row.authVersion);

          return jsonResponse({ token, user });
        }

        // Authentication guard for subsequent API endpoints
        const auth = await authenticate(request, env);
        if (!auth) {
          return errorResponse("احراز هویت نشده‌اید.", 401);
        }
        const callResponse=await handleCallRequests(request,env,auth);if(callResponse)return callResponse;
        const media=await handleMedia(request,env,auth);if(media)return media;
        const backup=await handleBackup(request,env,auth);if(backup)return backup;
        const channels=await handleChannels(request,env,auth);if(channels)return channels;
        const security=await handleSecurity(request,env,auth);if(security)return security;
        const secure=await handleSecure(request,env,auth,ctx);if(secure)return secure;
        const management=await handleManagement(request,env,auth);if(management)return management;
        const discovery=await handleDiscovery(request,env,auth);if(discovery)return discovery;
        const updates=await handleUpdates(request,env,auth);if(updates)return updates;
        const telegram=await handleTelegram(request,env,auth);if(telegram)return telegram;
        const featureResponse = await handleFeatures(request,env,auth,ctx);
        if (featureResponse) return featureResponse;

        if (url.pathname === '/api/auth/sessions' && request.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT id,label,created_at AS createdAt,expires_at AS expiresAt FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
            .bind(auth.userId, Date.now()).all();
          return jsonResponse(results.map(row => ({ ...row, current: row.id === auth.sid })));
        }
        if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
          await revokeSessions(env, auth.userId, [auth.sid]);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === '/api/auth/sessions/revoke' && request.method === 'POST') {
          const body = await inputJson(request);
          let ids: string[];
          if (body.others === true) {
            await env.DB.prepare('INSERT INTO session_policy (user_id,legacy_disabled) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET legacy_disabled = 1').bind(auth.userId).run();
            const { results } = await env.DB.prepare('SELECT id FROM user_sessions WHERE user_id = ? AND id != ? AND revoked_at IS NULL AND expires_at > ?').bind(auth.userId, auth.sid, Date.now()).all<{ id: string }>();
            ids = results.map(row => row.id);
          } else if (typeof body.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(body.id)) {
            const exists = await env.DB.prepare('SELECT id FROM user_sessions WHERE user_id = ? AND id = ?').bind(auth.userId, body.id).first();
            if (!exists) return errorResponse('نشست پیدا نشد.', 404);
            ids = [body.id];
          } else return errorResponse('نشست مورد نظر را انتخاب کنید.');
          await revokeSessions(env, auth.userId, ids);
          return jsonResponse({ ok: true });
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
             WHERE id != ? AND (instr(lower(username),?)>0 OR instr(lower(display_name),?)>0)
               AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = ? AND b.blocked_id = users.id) OR (b.blocker_id = users.id AND b.blocked_id = ?))
             LIMIT 20`
          ).bind(auth.userId, q, q,auth.userId,auth.userId).all<User>();

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
                WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id)
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageId,
              (
                SELECT CASE WHEN EXISTS(SELECT 1 FROM message_details d WHERE d.message_id=m.id AND d.deleted_at>0) THEN 'پیام حذف شده' ELSE m.text END FROM messages m
                WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id)
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageText,
              (
                SELECT m.created_at FROM messages m
                WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id)
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageTime,
              (
                SELECT snd.display_name FROM messages m
                JOIN users snd ON m.sender_id = snd.id
                WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id)
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1
              ) as lastMessageSender,
              (SELECT count(*) FROM messages m WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id) AND m.sender_id != cm.user_id
                AND NOT EXISTS(SELECT 1 FROM message_details d WHERE d.message_id=m.id AND d.deleted_at>0) AND (m.created_at > COALESCE(r.read_at,0) OR (m.created_at = COALESCE(r.read_at,0) AND m.id > COALESCE(r.read_id,'')))) AS unreadCount,
              (SELECT m.id FROM messages m WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id) AND m.sender_id != cm.user_id
                AND NOT EXISTS(SELECT 1 FROM message_details d WHERE d.message_id=m.id AND d.deleted_at>0) AND (m.created_at > COALESCE(r.read_at,0) OR (m.created_at = COALESCE(r.read_at,0) AND m.id > COALESCE(r.read_id,'')))
                ORDER BY m.created_at,m.id LIMIT 1) AS firstUnreadId,
              COALESCE(r.read_at,0) AS readAt, COALESCE(r.read_id,'') AS readId,
              bc.visibility AS channelVisibility, bc.handle AS channelHandle
            FROM chats c
            JOIN chat_members cm ON c.id = cm.chat_id AND cm.user_id = ?
            LEFT JOIN chat_members pm ON c.id = pm.chat_id AND pm.user_id != ? AND c.type = 'dm'
            LEFT JOIN users u ON pm.user_id = u.id
            LEFT JOIN chat_receipts r ON r.chat_id = c.id AND r.user_id = cm.user_id
            LEFT JOIN broadcast_channels bc ON bc.chat_id = c.id
            WHERE NOT EXISTS(SELECT 1 FROM chat_moderation cmod WHERE cmod.chat_id = c.id)
              AND NOT (EXISTS(SELECT 1 FROM chat_deletions cd WHERE cd.chat_id = c.id AND cd.user_id = cm.user_id)
                AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.chat_id = c.id AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = cm.user_id)))
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
              isChannel: !!row.channelVisibility,
              visibility: row.channelVisibility || undefined,
              handle: row.channelHandle || undefined,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              unreadCount: row.unreadCount,
              firstUnreadId: row.firstUnreadId,
              readAt: row.readAt,
              readId: row.readId,
              lastMessage: row.lastMessageText ? {
                id: row.lastMessageId,
                text: row.lastMessageText,
                senderName: row.lastMessageSender || "",
                createdAt: row.lastMessageTime || row.updatedAt,
              } : null,
            };
          });

          return jsonResponse(await enrichChats(env,auth.userId,chats));
        }

        // --- CHATS: CREATE OR GET DM/GROUP ---
        if (url.pathname === "/api/chats" && request.method === "POST") {
          const body = await inputJson(request);
          const type = body.type === "group" || body.type === "channel" ? "group" : "dm";
          const now = Date.now();

          if (type === "dm") {
            const targetUserId = String(body.targetUserId || "");
            if (!targetUserId || targetUserId === auth.userId) {
              return errorResponse("شناسه مخاطب نامعتبر است.");
            }
            const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetUserId).first();
            if (!target) return errorResponse('مخاطب یافت نشد.', 404);
            if (await env.DB.prepare('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').bind(auth.userId,targetUserId,targetUserId,auth.userId).first()) return errorResponse('این مخاطب مسدود است.',403);

            // Check if DM already exists
            const existing = await env.DB.prepare(`
              SELECT c.id FROM chats c
              JOIN chat_members m1 ON c.id = m1.chat_id AND m1.user_id = ?
              JOIN chat_members m2 ON c.id = m2.chat_id AND m2.user_id = ?
              WHERE c.type = 'dm'
              ORDER BY c.created_at, c.id
            `).bind(auth.userId, targetUserId).first<{ id: string }>();

            if (existing) {
              await env.DB.prepare('DELETE FROM chat_deletions WHERE chat_id = ? AND user_id = ?').bind(existing.id, auth.userId).run();
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
            const channel = body.type === 'channel';
            const title = String(body.title || (channel ? "کانال جدید" : "گروه جدید")).trim();
            if (!title || title.length > 100) return errorResponse('عنوان باید بین ۱ تا ۱۰۰ کاراکتر باشد.');
            // A channel can start with only its owner; people join later through a link or search.
            const members = channel && !body.memberIds?.length ? [] : await validatedMembers(body.memberIds, env, auth.userId);
            if (!members) return errorResponse('حداقل یک عضو معتبر انتخاب کنید (حداکثر ۹۹ نفر).');
            const settings = channel ? channelSettings(body) : null;
            if (settings?.handle && await env.DB.prepare('SELECT 1 FROM broadcast_channels WHERE handle = ?').bind(settings.handle).first()) return errorResponse('این نشانی کانال قبلاً گرفته شده است.', 409);
            const chatId = crypto.randomUUID();

            await env.DB.batch([
              env.DB.prepare(`INSERT INTO chats (id, type, title, created_at, updated_at) VALUES (?, 'group', ?, ?, ?)`).bind(chatId, title, now, now),
              env.DB.prepare(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).bind(chatId, auth.userId, now),
              env.DB.prepare('INSERT INTO chat_members(chat_id,user_id,joined_at) SELECT ?,value,? FROM json_each(?)').bind(chatId,now,JSON.stringify(members)),
              env.DB.prepare("INSERT INTO group_roles VALUES (?,?,'owner')").bind(chatId,auth.userId),
              ...(settings ? [env.DB.prepare('INSERT INTO broadcast_channels VALUES (?,?,?,?)').bind(chatId,settings.visibility,settings.handle,settings.description)] : []),
            ]);

            return jsonResponse({ id: chatId, isNew: true }, 201);
          }
        }

        const membersMatch = url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/members$/);
        if (membersMatch && (request.method === 'GET' || request.method === 'POST')) {
          const chatId = membersMatch[1];
          const member = await chatAccess(env, chatId, auth.userId);
          if (!member) return errorResponse('شما عضو این گفتگو نیستید.', 403);
          if (request.method === 'POST') {
            if (member.type !== 'group') return errorResponse('افزودن عضو فقط برای گروه امکان‌پذیر است.');
            const access = await chatAccess(env,chatId,auth.userId);
            if (!access || !['owner','admin'].includes(access.role)) return errorResponse('فقط مالک یا مدیر می‌تواند عضو اضافه کند.',403);
            const body = await inputJson(request);
            const users = await validatedMembers(body.userIds, env, auth.userId);
            if (!users) return errorResponse('اعضای انتخاب‌شده نامعتبر هستند.');
            // Existing members are harmless duplicates; only current members may invite.
            await env.DB.prepare(`INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at)
              SELECT ?, id, ? FROM users WHERE id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM group_roles WHERE chat_id=? AND user_id=? AND role IN ('owner','admin')) AND (SELECT count(*) FROM chat_members WHERE chat_id=?) + (SELECT count(*) FROM json_each(?) selected WHERE NOT EXISTS(SELECT 1 FROM chat_members existing WHERE existing.chat_id=? AND existing.user_id=selected.value)) <= ${MEMBER_LIMIT_SQL}`)
              .bind(chatId, Date.now(), JSON.stringify(users),chatId,auth.userId,chatId,JSON.stringify(users),chatId,chatId).run();
            const admitted=await env.DB.prepare(`SELECT count(*) AS n FROM chat_members WHERE chat_id=? AND user_id IN (${users.map(()=>'?').join(',')})`).bind(chatId,...users).first<{n:number}>();
            if(admitted?.n!==users.length) return errorResponse('عضو اضافه نشد؛ سقف اعضا پر شده یا مجوز مدیریت شما تغییر کرده است.',409);
          }
          const { results } = await env.DB.prepare(`SELECT u.id, u.username, u.display_name as displayName
            FROM users u JOIN chat_members cm ON cm.user_id = u.id WHERE cm.chat_id = ? AND (NOT EXISTS(SELECT 1 FROM broadcast_channels bc WHERE bc.chat_id = cm.chat_id) OR EXISTS(SELECT 1 FROM group_roles g WHERE g.chat_id = cm.chat_id AND g.user_id = ? AND g.role IN ('owner','admin')) OR EXISTS(SELECT 1 FROM group_roles g WHERE g.chat_id = cm.chat_id AND g.user_id = u.id AND g.role IN ('owner','admin'))) ORDER BY cm.joined_at, u.id`).bind(chatId,auth.userId).all();
          return jsonResponse(results);
        }

        const receiptsMatch = url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/receipts$/);
        if (receiptsMatch && (request.method === 'GET' || request.method === 'POST')) {
          const chatId = receiptsMatch[1];
          const member = await chatAccess(env, chatId, auth.userId);
          if (!member) return errorResponse('شما عضو این گفتگو نیستید.', 403);
          if (request.method === 'GET') {
            const receipts = await listReceipts(env, chatId);
            // Subscribers stay anonymous: the page only counts these rows to show views.
            return jsonResponse(member.isChannel ? receipts.map((row: any, index: number) => ({ ...row, userId: row.userId === auth.userId ? auth.userId : 'r' + index })) : receipts);
          }
          const body = await inputJson(request);
          if (!body || typeof body.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.messageId) || typeof body.read !== 'boolean') return errorResponse('رسید پیام معتبر نیست.');
          const receipt = await saveReceipt(env, chatId, auth.userId, body.messageId, body.read);
          return receipt ? jsonResponse(receipt) : errorResponse('پیام پیدا نشد.', 404);
        }

        // --- CHATS: GET MESSAGES HISTORY ---
        const historyMatch = url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/messages$/);
        if (historyMatch && request.method === "GET") {
          const chatId = historyMatch[1];

          // Check membership
          const isMember = await chatAccess(env, chatId, auth.userId);

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
            const historyUrl = new URL(`http://internal/history${url.search}`); historyUrl.searchParams.set('userId',auth.userId); historyUrl.searchParams.set('chatId',chatId);
            const doRes = await stub.fetch(historyUrl.toString());
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
              m.created_at as createdAt,
              md.client_msg_id AS clientMsgId
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            LEFT JOIN message_metadata md ON md.message_id = m.id
            WHERE m.chat_id = ? AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ?
          `).bind(chatId, auth.userId, beforeTime, beforeTime, beforeTime, beforeId, limit).all();

          const combined = new Map<string, any>();
          for (const message of [...(results || []), ...roomMessages]) combined.set(message.id, message);
          const messages = [...combined.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
          return jsonResponse(await enrichMessages(env,chatId,auth.userId,messages.slice(0, limit).reverse()));
        }

        return errorResponse("مسیر درخواستی یافت نشد.", 404);
      } catch (err: any) {
        if (err instanceof InputError) return errorResponse(err.message, err.status);
        console.error("API Error:", err);
        return errorResponse('خطای موقت سرور؛ دوباره تلاش کنید و در صورت ادامه، نسخه و سلامت نصب را بررسی کنید.', 500);
      }
    }

    // ==========================================
    // 3. Static Assets & PWA Fallback
    // ==========================================
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Cloudflare Messenger Backend Ready", { status: 200 });

}
