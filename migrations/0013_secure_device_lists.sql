-- A signed list of the devices that belong to one account, so contacts can follow additions and removals.
CREATE TABLE IF NOT EXISTS secure_device_lists (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,list TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
