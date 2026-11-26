ALTER TABLE providers ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE providers ADD COLUMN last_checked_at TEXT;
ALTER TABLE providers ADD COLUMN last_error TEXT;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  visitor_hash TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (visitor_hash, bucket)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at ON rate_limit_buckets(expires_at);

INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES
('agent_config','{"enabled":true,"dailyLimit":25,"minuteLimit":5,"globalDailyLimit":500,"welcomeMessage":"你好，我是站长的个人分身。你可以问我有关经历、项目和文章的问题。","systemInstruction":"请简洁、准确地依据知识库回答。"}',datetime('now'));

PRAGMA optimize;
