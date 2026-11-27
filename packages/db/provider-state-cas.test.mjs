import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:"),
    migrationsUrl = new URL("./migrations/", import.meta.url),
    migrations = readdirSync(migrationsUrl)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
  for (const migration of migrations)
    database.exec(readFileSync(new URL(migration, migrationsUrl), "utf8"));
  database
    .prepare(`
      INSERT INTO providers (
        id,name,kind,base_url,encrypted_api_key,chat_model,embedding_model,
        created_at,updated_at,credential_status,runtime_status,health_status
      ) VALUES (?,?,?,?,?,?,?,?,?,'unverified','unknown','unknown')
    `)
    .run(
      "provider-1",
      "OpenAI",
      "openai",
      "https://api.openai.com/v1",
      "encrypted",
      "gpt-4o-mini",
      "text-embedding-3-small",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  return database;
}

function begin(database) {
  return database
    .prepare(
      "UPDATE providers SET state_epoch=state_epoch+1 WHERE id=? RETURNING state_epoch",
    )
    .get("provider-1").state_epoch;
}

function markSuccess(database, epoch, at) {
  return database
    .prepare(`
      UPDATE providers SET
        credential_status='valid',runtime_status='healthy',failure_code=NULL,
        consecutive_failures=0,last_success_at=?,circuit_open_until=NULL,
        health_status='healthy',last_checked_at=?,last_error=NULL,updated_at=?
      WHERE id=? AND state_epoch=?
      RETURNING credential_status,runtime_status,failure_code
    `)
    .get(at, at, at, "provider-1", epoch);
}

function markFailure(database, epoch, at, code = "UPSTREAM_5XX") {
  return database
    .prepare(`
      UPDATE providers SET
        runtime_status='degraded',failure_code=?,consecutive_failures=1,
        last_failure_at=?,health_status='error',last_checked_at=?,
        last_error='模型厂商服务异常',updated_at=?
      WHERE id=? AND state_epoch=?
      RETURNING credential_status,runtime_status,failure_code
    `)
    .get(code, at, at, at, "provider-1", epoch);
}

function providerState(database) {
  const row = database
    .prepare(`
      SELECT state_epoch,credential_status,runtime_status,failure_code,
             last_success_at,last_failure_at
      FROM providers WHERE id=?
    `)
    .get("provider-1");
  return { ...row };
}

test("all migrations replay and expose the provider state epoch", () => {
  const database = migratedDatabase(),
    columns = database
      .prepare("PRAGMA table_info(providers)")
      .all()
      .map((column) => column.name);
  assert.ok(columns.includes("state_epoch"));
  assert.equal(providerState(database).state_epoch, 0);
});

test("an older failure cannot overwrite a newer successful validation", () => {
  const database = migratedDatabase(),
    olderEpoch = begin(database),
    newerEpoch = begin(database);
  assert.ok(
    markSuccess(database, newerEpoch, "2026-01-01T00:00:02.000Z"),
  );
  assert.equal(
    markFailure(database, olderEpoch, "2026-01-01T00:00:03.000Z"),
    undefined,
  );
  assert.deepEqual(providerState(database), {
    state_epoch: newerEpoch,
    credential_status: "valid",
    runtime_status: "healthy",
    failure_code: null,
    last_success_at: "2026-01-01T00:00:02.000Z",
    last_failure_at: null,
  });
});

test("an older success cannot hide a newer production failure", () => {
  const database = migratedDatabase(),
    olderEpoch = begin(database),
    newerEpoch = begin(database);
  assert.ok(
    markFailure(database, newerEpoch, "2026-01-01T00:00:02.000Z"),
  );
  assert.equal(
    markSuccess(database, olderEpoch, "2026-01-01T00:00:03.000Z"),
    undefined,
  );
  assert.deepEqual(providerState(database), {
    state_epoch: newerEpoch,
    credential_status: "unverified",
    runtime_status: "degraded",
    failure_code: "UPSTREAM_5XX",
    last_success_at: null,
    last_failure_at: "2026-01-01T00:00:02.000Z",
  });
});

test("an older failure cannot replace the newer failure reason", () => {
  const database = migratedDatabase(),
    olderEpoch = begin(database),
    newerEpoch = begin(database);
  assert.ok(
    markFailure(
      database,
      newerEpoch,
      "2026-01-01T00:00:02.000Z",
      "ROUTE_REGION_UNSUPPORTED",
    ),
  );
  assert.equal(
    markFailure(
      database,
      olderEpoch,
      "2026-01-01T00:00:03.000Z",
      "TIMEOUT",
    ),
    undefined,
  );
  assert.equal(
    providerState(database).failure_code,
    "ROUTE_REGION_UNSUPPORTED",
  );
});
