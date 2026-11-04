-- One-time password reset links that a server owner gives to a member.
CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
