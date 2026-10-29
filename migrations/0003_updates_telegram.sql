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
