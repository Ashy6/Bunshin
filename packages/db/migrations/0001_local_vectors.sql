CREATE TABLE IF NOT EXISTS local_vectors (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_vectors_document_id ON local_vectors(document_id);
ALTER TABLE providers ADD COLUMN key_preview TEXT NOT NULL DEFAULT '';
PRAGMA optimize;
