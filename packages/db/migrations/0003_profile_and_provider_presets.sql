ALTER TABLE profiles ADD COLUMN markdown_bio TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN resume_document_id TEXT;
ALTER TABLE providers ADD COLUMN preset_id TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE providers ADD COLUMN embedding_mode TEXT NOT NULL DEFAULT 'local';
ALTER TABLE chunks ADD COLUMN vector_id TEXT;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
PRAGMA optimize;
