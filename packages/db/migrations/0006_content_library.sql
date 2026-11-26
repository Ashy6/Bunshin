ALTER TABLE categories ADD COLUMN show_in_portal INTEGER NOT NULL DEFAULT 1;

ALTER TABLE articles ADD COLUMN seo_title TEXT;
ALTER TABLE articles ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE articles ADD COLUMN cover_r2_key TEXT;
ALTER TABLE articles ADD COLUMN source_r2_key TEXT;
ALTER TABLE articles ADD COLUMN source_name TEXT;
ALTER TABLE articles ADD COLUMN source_type TEXT;
ALTER TABLE articles ADD COLUMN scheduled_at TEXT;
ALTER TABLE articles ADD COLUMN import_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE articles ADD COLUMN import_error TEXT;

ALTER TABLE documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN ingestion_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN ocr_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE documents ADD COLUMN ocr_r2_key TEXT;
ALTER TABLE documents ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS article_versions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_article_versions_article_created
  ON article_versions(article_id,created_at);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_versions_document_version
  ON document_versions(document_id,version_number);

CREATE INDEX IF NOT EXISTS idx_articles_scheduled_at
  ON articles(status,scheduled_at);

PRAGMA optimize;
