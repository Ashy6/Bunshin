CREATE TABLE IF NOT EXISTS password_reset_codes (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_admin_created
  ON password_reset_codes(admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires
  ON password_reset_codes(expires_at);

PRAGMA optimize;
