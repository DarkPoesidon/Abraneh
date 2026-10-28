CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS session_policy (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, legacy_disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_limits_expiry ON rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS message_metadata (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, client_msg_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_receipts (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL DEFAULT 0, delivered_id TEXT NOT NULL DEFAULT '',
  read_at INTEGER NOT NULL DEFAULT 0, read_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(chat_id,user_id)
);
