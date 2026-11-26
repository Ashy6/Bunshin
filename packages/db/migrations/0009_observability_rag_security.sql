CREATE TABLE IF NOT EXISTS observability_events (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  route TEXT,
  scenario TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observability_created
  ON observability_events(created_at);
CREATE INDEX IF NOT EXISTS idx_observability_type_created
  ON observability_events(event_type,created_at);
CREATE INDEX IF NOT EXISTS idx_observability_severity_created
  ON observability_events(severity,created_at);

CREATE TABLE IF NOT EXISTS operational_alerts (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  metric_value REAL,
  threshold_value REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_alert_fingerprint
  ON operational_alerts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_operational_alert_status
  ON operational_alerts(status,last_seen_at);

CREATE TABLE IF NOT EXISTS queue_job_runs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  trace_id TEXT NOT NULL,
  error_message TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_job_status_heartbeat
  ON queue_job_runs(status,heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_queue_job_document
  ON queue_job_runs(document_id,started_at);

CREATE TABLE IF NOT EXISTS rag_query_events (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  retrieval_mode TEXT NOT NULL,
  lexical_count INTEGER NOT NULL DEFAULT 0,
  vector_count INTEGER NOT NULL DEFAULT 0,
  fused_count INTEGER NOT NULL DEFAULT 0,
  top_score REAL NOT NULL DEFAULT 0,
  retrieval_ms INTEGER NOT NULL DEFAULT 0,
  answer_status TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rag_query_created
  ON rag_query_events(created_at);

INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES
('observability_config','{"errorRateThreshold":20,"minimumRequests":5,"stuckMinutes":15,"budgetWarningPercent":80,"slowRequestMs":12000}',datetime('now'));

PRAGMA optimize;
