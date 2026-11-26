ALTER TABLE profiles ADD COLUMN rag_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE profiles ADD COLUMN website_url TEXT;
ALTER TABLE profiles ADD COLUMN public_email TEXT;
ALTER TABLE profiles ADD COLUMN experience_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN project_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN education_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN avatar_position_x INTEGER NOT NULL DEFAULT 50;
ALTER TABLE profiles ADD COLUMN avatar_position_y INTEGER NOT NULL DEFAULT 50;

ALTER TABLE documents ADD COLUMN purpose TEXT NOT NULL DEFAULT 'knowledge';
ALTER TABLE documents ADD COLUMN original_name TEXT;
ALTER TABLE documents ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN source_url TEXT;
ALTER TABLE documents ADD COLUMN archived_at TEXT;

ALTER TABLE articles ADD COLUMN document_id TEXT;

CREATE TABLE IF NOT EXISTS profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_versions_profile_created ON profile_versions(profile_id,created_at);
CREATE INDEX IF NOT EXISTS idx_documents_purpose_updated ON documents(purpose,updated_at);
PRAGMA optimize;
