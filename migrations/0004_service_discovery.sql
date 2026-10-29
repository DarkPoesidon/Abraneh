CREATE TABLE IF NOT EXISTS service_user_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  disabled_at INTEGER,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS discovery_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS service_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_audit_time ON service_audit(created_at,id);
