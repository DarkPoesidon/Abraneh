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
