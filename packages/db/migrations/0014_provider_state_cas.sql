-- Assign every provider execution a database-ordered epoch when it starts.
-- Completion updates use this value as a compare-and-swap guard, so an older,
-- slower request can never overwrite a newer validation or chat result.
ALTER TABLE providers ADD COLUMN state_epoch INTEGER NOT NULL DEFAULT 0;

PRAGMA optimize;
