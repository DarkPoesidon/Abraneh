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
CREATE TABLE IF NOT EXISTS message_search (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,chat_id TEXT NOT NULL,normalized TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_search_chat ON message_search(chat_id);
INSERT OR IGNORE INTO message_search SELECT id,chat_id,lower(replace(replace(replace(replace(replace(replace(replace(replace(text,'ي','ی'),'ى','ی'),'ك','ک'),char(8204),''),'َ',''),'ِ',''),'ُ',''),'ّ','')) FROM messages;
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

CREATE INDEX IF NOT EXISTS idx_saved_page ON saved_messages(user_id,created_at DESC,message_id DESC);
CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked_users(blocked_id,blocker_id);
CREATE INDEX IF NOT EXISTS idx_preferences_user ON chat_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_roles_user ON group_roles(user_id);
