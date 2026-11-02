-- Photos for groups and channels, and public channels followed on other servers.
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
