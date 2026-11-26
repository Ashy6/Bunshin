UPDATE categories
SET scope = 'shared', updated_at = datetime('now')
WHERE scope = 'both';

INSERT OR IGNORE INTO document_versions (
  id,
  document_id,
  version_number,
  r2_key,
  original_name,
  source_type,
  file_size,
  created_at
)
SELECT
  'initial-' || id,
  id,
  1,
  r2_key,
  COALESCE(NULLIF(original_name, ''), title || CASE source_type WHEN 'pdf' THEN '.pdf' WHEN 'markdown' THEN '.md' ELSE '.txt' END),
  source_type,
  file_size,
  created_at
FROM documents
WHERE r2_key IS NOT NULL;

PRAGMA optimize;
