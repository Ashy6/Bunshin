// @ts-nocheck -- executed directly by Node's TypeScript type stripping.
import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttemptProvider,
  nextProviderFailureState,
  nextProviderSuccessState,
} from "./provider-state.ts";

const runtimeFailure = {
  code: "UPSTREAM_5XX",
  retryable: true,
  configInvalid: false,
  runtimeFailure: true,
  credentialInvalid: false,
};

test("a route failure does not invalidate provider credentials", () => {
    const result = nextProviderFailureState(
      { credentialStatus: "valid" },
      {
        ...runtimeFailure,
        code: "ROUTE_REGION_UNSUPPORTED",
        retryable: false,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
  assert.equal(result.credentialStatus, "valid");
  assert.equal(result.runtimeStatus, "unavailable");
});

test("three consecutive transient failures open a short circuit", () => {
    const now = new Date("2026-01-01T00:02:00.000Z"),
      result = nextProviderFailureState(
        {
          credentialStatus: "valid",
          consecutiveFailures: 2,
          lastFailureAt: "2026-01-01T00:01:30.000Z",
        },
        runtimeFailure,
        now,
      );
  assert.equal(result.runtimeStatus, "circuit_open");
  assert.equal(result.circuitOpenUntil, "2026-01-01T00:03:00.000Z");
  assert.equal(canAttemptProvider(result, now), false);
});

test("a successful request heals runtime state", () => {
  assert.deepEqual(nextProviderSuccessState(new Date("2026-01-01T00:00:00.000Z")), {
      credentialStatus: "valid",
      runtimeStatus: "healthy",
      failureCode: null,
      consecutiveFailures: 0,
      lastSuccessAt: "2026-01-01T00:00:00.000Z",
      circuitOpenUntil: null,
    });
});
