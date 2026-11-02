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
