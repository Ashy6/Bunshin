CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_admin
  ON admin_recovery_codes(admin_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_batch
  ON admin_recovery_codes(admin_id, batch_id, used_at);
