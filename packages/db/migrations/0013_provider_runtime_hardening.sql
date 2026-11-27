-- Repair legacy provider identities and Runtime placeholder credentials.
-- Migration 0012 may already be applied in production, so these corrections
-- intentionally live in a new forward-only migration.

UPDATE providers
SET preset_id = 'openai',
    route_mode = 'gateway'
WHERE lower(rtrim(base_url, '/')) = 'https://api.openai.com/v1';

UPDATE providers
SET preset_id = 'deepseek'
WHERE lower(rtrim(base_url, '/')) IN (
  'https://api.deepseek.com',
  'https://api.deepseek.com/v1'
);

UPDATE providers
SET preset_id = 'openrouter'
WHERE lower(rtrim(base_url, '/')) = 'https://openrouter.ai/api/v1';

-- An older Runtime implementation stored an encrypted `runtime:<preset>`
-- placeholder instead of the user's real provider key. The original key
-- cannot be reconstructed. Fail closed and require one explicit re-entry;
-- never send the placeholder to a model vendor.
UPDATE providers
SET credential_status = 'invalid',
    runtime_status = 'unavailable',
    failure_code = 'PROVIDER_KEY_MISSING',
    health_status = 'error',
    last_error = '历史 Runtime 渠道未保存真实 API Key，请重新录入',
    consecutive_failures = 0,
    last_success_at = NULL,
    last_failure_at = datetime('now'),
    circuit_open_until = NULL,
    updated_at = datetime('now')
WHERE key_preview = 'Runtime Secret';

PRAGMA optimize;
