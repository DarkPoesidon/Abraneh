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
