-- A private chat someone deleted for themselves stays out of their list until a new message arrives.
CREATE TABLE IF NOT EXISTS chat_deletions (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, user_id)
);
