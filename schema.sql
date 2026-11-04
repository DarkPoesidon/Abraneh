-- Cloudflare D1 Database Schema for Cloudflare Messenger

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('dm', 'group')),
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    last_read_at INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS session_policy (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, legacy_disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_limits_expiry ON rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS message_metadata (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    client_msg_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_receipts (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at INTEGER NOT NULL DEFAULT 0,
    delivered_id TEXT NOT NULL DEFAULT '',
    read_at INTEGER NOT NULL DEFAULT 0,
    read_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, about TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'dark', font_size TEXT NOT NULL DEFAULT 'normal', notifications INTEGER NOT NULL DEFAULT 0, notification_preview INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS account_security (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, password_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS session_security (session_id TEXT PRIMARY KEY REFERENCES user_sessions(id) ON DELETE CASCADE, password_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS group_roles (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), PRIMARY KEY(chat_id,user_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_group_owner ON group_roles(chat_id) WHERE role = 'owner';
-- Shipped 1.0/1.1 inserts the creator's membership first in the same batch.
-- Preserve that insertion order, even when all joined_at timestamps are equal.
INSERT OR IGNORE INTO group_roles(chat_id,user_id,role) SELECT c.id,cm.user_id,'owner' FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE c.type = 'group' AND cm.rowid = (SELECT min(first.rowid) FROM chat_members first WHERE first.chat_id = c.id) AND NOT EXISTS(SELECT 1 FROM group_roles existing WHERE existing.chat_id = c.id AND existing.role = 'owner');
CREATE TABLE IF NOT EXISTS chat_preferences (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,archived INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,user_id));
CREATE TABLE IF NOT EXISTS message_details (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,reply_to TEXT,edited_at INTEGER NOT NULL DEFAULT 0,deleted_at INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS message_reactions (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id));
CREATE TABLE IF NOT EXISTS message_hidden (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(message_id,user_id));
CREATE INDEX IF NOT EXISTS idx_hidden_chat_user ON message_hidden(chat_id,user_id);
CREATE TABLE IF NOT EXISTS chat_pins (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,message_id TEXT NOT NULL,pinned_by TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS saved_messages (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,message_id));
CREATE TABLE IF NOT EXISTS blocked_users (blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(blocker_id,blocked_id));
CREATE TABLE IF NOT EXISTS group_invites (token_hash TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,created_by TEXT NOT NULL,expires_at INTEGER NOT NULL,use_limit INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS group_redemptions (token_hash TEXT NOT NULL,user_id TEXT NOT NULL,redeemed_at INTEGER NOT NULL,grant_id TEXT NOT NULL,PRIMARY KEY(token_hash,user_id));
CREATE TABLE IF NOT EXISTS service_admins (slot INTEGER PRIMARY KEY CHECK(slot = 1),user_id TEXT UNIQUE NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registration_invites (token_hash TEXT PRIMARY KEY,created_by TEXT NOT NULL,expires_at INTEGER NOT NULL,use_limit INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS abuse_reports (id TEXT PRIMARY KEY,reporter_id TEXT NOT NULL REFERENCES users(id),target_user_id TEXT NOT NULL REFERENCES users(id),chat_id TEXT,message_id TEXT,reason TEXT NOT NULL,snapshot TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,endpoint TEXT NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);


CREATE TABLE IF NOT EXISTS message_search (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,chat_id TEXT NOT NULL,normalized TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_search_chat ON message_search(chat_id);
INSERT OR IGNORE INTO message_search SELECT id,chat_id,lower(replace(replace(replace(replace(replace(replace(replace(replace(text,'ي','ی'),'ى','ی'),'ك','ک'),char(8204),''),'َ',''),'ِ',''),'ُ',''),'ّ','')) FROM messages;

CREATE INDEX IF NOT EXISTS idx_saved_page ON saved_messages(user_id,created_at DESC,message_id DESC);
CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked_users(blocked_id,blocker_id);
CREATE INDEX IF NOT EXISTS idx_preferences_user ON chat_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_roles_user ON group_roles(user_id);

-- 1.3: update controls use existing site_settings; Telegram caches are separate.
CREATE TABLE IF NOT EXISTS telegram_bots (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bot_number TEXT NOT NULL UNIQUE, username TEXT NOT NULL, token_cipher TEXT NOT NULL,
  secret_hash TEXT NOT NULL, webhook_url TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  config_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_sources (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('public','bot')),
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE, bot_id TEXT REFERENCES telegram_bots(id) ON DELETE SET NULL,
  chat_number TEXT, username TEXT, title TEXT NOT NULL, last_checked INTEGER NOT NULL DEFAULT 0,
  error TEXT, enabled INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES telegram_sources(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,source_id)
);
CREATE TABLE IF NOT EXISTS telegram_posts (
  source_id TEXT NOT NULL REFERENCES telegram_sources(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL, text TEXT NOT NULL, media INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, update_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(source_id,message_id)
);
CREATE INDEX IF NOT EXISTS telegram_posts_time ON telegram_posts(source_id,message_id DESC);
CREATE INDEX IF NOT EXISTS telegram_sources_refresh ON telegram_sources(kind,last_checked);

CREATE TABLE IF NOT EXISTS service_user_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  disabled_at INTEGER,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS discovery_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS service_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_audit_time ON service_audit(created_at,id);

CREATE TABLE IF NOT EXISTS service_control (id INTEGER PRIMARY KEY CHECK(id=1),snapshot_id TEXT NOT NULL,paused_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS service_operations (id TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS service_restore (id INTEGER PRIMARY KEY CHECK(id=1),digest TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS security_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  origin TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  password_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS security_challenges_expiry ON security_challenges(expires_at);
CREATE INDEX IF NOT EXISTS security_challenges_user ON security_challenges(user_id);
CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  last_step INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS security_recovery (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  PRIMARY KEY(user_id,code_hash)
);

-- Secure device mailboxes are separate from legacy plaintext chat history.
CREATE TABLE IF NOT EXISTS secure_devices (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT NOT NULL,identity_key TEXT NOT NULL,key_package TEXT NOT NULL,signature TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER,PRIMARY KEY(user_id,device_id));
CREATE TABLE IF NOT EXISTS secure_prekeys (user_id TEXT NOT NULL,device_id TEXT NOT NULL,package_id TEXT NOT NULL,key_package TEXT NOT NULL,signature TEXT NOT NULL,claimed_at INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,device_id,package_id),FOREIGN KEY(user_id,device_id) REFERENCES secure_devices(user_id,device_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS secure_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT NOT NULL,envelope TEXT NOT NULL,digest TEXT NOT NULL,created_at INTEGER NOT NULL,push_cursor TEXT NOT NULL DEFAULT '',notified_at INTEGER,push_next_attempt INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_secure_inbox ON secure_events(owner_id,device_id,sequence);
CREATE INDEX IF NOT EXISTS idx_secure_push ON secure_events(notified_at,push_next_attempt);
CREATE TABLE IF NOT EXISTS secure_outbox (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,peer TEXT NOT NULL,envelope TEXT NOT NULL,digest TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,delivered_at INTEGER,last_error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS secure_nonces (peer TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(peer,nonce));
CREATE TABLE IF NOT EXISTS secure_blocks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,address TEXT NOT NULL,PRIMARY KEY(user_id,address));
CREATE TABLE IF NOT EXISTS secure_peer_keys (host TEXT PRIMARY KEY,public_key TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS secure_device_lists (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,list TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')), invite_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_owner ON channels(owner_id);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('admin','subscriber')), PRIMARY KEY(channel_id,user_id)
);
CREATE INDEX IF NOT EXISTS channel_members_user ON channel_members(user_id);
CREATE TABLE IF NOT EXISTS channel_posts (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, author_id TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0, event_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS channel_posts_cursor ON channel_posts(channel_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS channel_tokens (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('read','write','read-write')), expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_tokens_channel ON channel_tokens(channel_id);
CREATE TABLE IF NOT EXISTS channel_webhooks (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  url TEXT NOT NULL, secret_cipher TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_outbox (
  id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES channel_webhooks(id) ON DELETE CASCADE,
  payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX IF NOT EXISTS channel_outbox_due ON channel_outbox(next_at,locked_until);
-- A channel is a group where only managers post, so it reuses chats, members, roles and invites.
CREATE TABLE IF NOT EXISTS broadcast_channels (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
  handle TEXT COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_handle ON broadcast_channels(handle) WHERE handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_broadcast_visibility ON broadcast_channels(visibility);
CREATE TABLE IF NOT EXISTS chat_moderation (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  suspended_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chat_deletions (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_photos (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  avatar TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_channel_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  handle TEXT NOT NULL,
  title TEXT NOT NULL,
  followed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, host, handle)
);
