INSERT INTO settings (key,value,updated_at)
VALUES (
  'system_config',
  '{"publicOrigin":"","defaultSeoDescription":"个人简历、文章与 AI 分身","seoKeywords":["个人简历","AI 分身","RAG"],"llmsFullEnabled":false,"cacheTtlSeconds":300}',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

UPDATE settings
SET value = json_set(value, '$.dailyLimit', 25), updated_at = datetime('now')
WHERE key = 'agent_config'
  AND CAST(json_extract(value, '$.dailyLimit') AS INTEGER) != 25;

UPDATE documents
SET ingestion_progress = 100
WHERE status IN ('indexed','archived','failed','needs_ocr')
  AND ingestion_progress != 100;

UPDATE documents
SET original_name = COALESCE(
  NULLIF(original_name, ''),
  (
    SELECT document_versions.original_name
    FROM document_versions
    WHERE document_versions.document_id = documents.id
    ORDER BY document_versions.version_number DESC
    LIMIT 1
  )
)
WHERE original_name IS NULL OR original_name = '';

UPDATE documents
SET file_size = COALESCE(
  NULLIF(file_size, 0),
  (
    SELECT NULLIF(document_versions.file_size, 0)
    FROM document_versions
    WHERE document_versions.document_id = documents.id
    ORDER BY document_versions.version_number DESC
    LIMIT 1
  ),
  0
)
WHERE file_size = 0;

PRAGMA optimize;
