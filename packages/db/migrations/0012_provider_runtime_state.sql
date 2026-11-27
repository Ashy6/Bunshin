-- Split provider credential verification from transient runtime health.
-- Keep the legacy health_status columns during the rolling deployment so
-- older Worker versions can continue to read and write providers safely.
ALTER TABLE providers ADD COLUMN credential_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE providers ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE providers ADD COLUMN failure_code TEXT;
ALTER TABLE providers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN last_success_at TEXT;
ALTER TABLE providers ADD COLUMN last_failure_at TEXT;
ALTER TABLE providers ADD COLUMN circuit_open_until TEXT;
ALTER TABLE providers ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'direct';

-- A legacy healthy result verified both the credential and that particular
-- runtime request. Reuse its timestamp as the latest known success.
UPDATE providers
SET credential_status = 'valid',
    runtime_status = 'healthy',
    last_success_at = COALESCE(last_checked_at, updated_at),
    consecutive_failures = 0
WHERE health_status = 'healthy';

-- Legacy errors did not distinguish invalid credentials from a regional,
-- timeout, rate-limit, gateway or upstream failure. Do not permanently mark
-- the credential invalid when migrating ambiguous data.
UPDATE providers
SET credential_status = 'unverified',
    runtime_status = 'degraded',
    failure_code = 'legacy_error',
    consecutive_failures = 1,
    last_failure_at = COALESCE(last_checked_at, updated_at)
WHERE health_status = 'error';

-- The production Workers share this Gateway route, so admin validation and
-- visitor chat no longer depend on whichever edge happened to run a request.
UPDATE providers
SET route_mode = 'gateway'
WHERE lower(kind) = 'openai'
   OR lower(base_url) LIKE 'https://api.openai.com/%';

CREATE INDEX IF NOT EXISTS idx_providers_credential_status
  ON providers(credential_status);
CREATE INDEX IF NOT EXISTS idx_providers_runtime_circuit
  ON providers(runtime_status, circuit_open_until);
CREATE INDEX IF NOT EXISTS idx_providers_route_enabled
  ON providers(route_mode, enabled);

PRAGMA optimize;
