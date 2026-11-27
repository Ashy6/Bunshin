export type ProviderCredentialStatus = "unverified" | "valid" | "invalid";
export type ProviderRuntimeStatus =
  | "unknown"
  | "healthy"
  | "degraded"
  | "circuit_open"
  | "unavailable";

export type ProviderExecutionRoute = "direct" | "gateway" | "runtime";

export type ProviderState = {
  credentialStatus?: ProviderCredentialStatus | null;
  runtimeStatus?: ProviderRuntimeStatus | null;
  consecutiveFailures?: number | null;
  lastFailureAt?: string | null;
  circuitOpenUntil?: string | null;
};

export type ProviderFailureClassification = {
  code: string;
  retryable: boolean;
  configInvalid: boolean;
  runtimeFailure: boolean;
  credentialInvalid?: boolean;
};

export type ProviderFailureTransition = {
  credentialStatus: ProviderCredentialStatus;
  runtimeStatus: ProviderRuntimeStatus;
  failureCode: string;
  consecutiveFailures: number;
  lastFailureAt: string;
  circuitOpenUntil: string | null;
};

const failureWindowMs = 5 * 60_000;
const circuitDurationMs = 60_000;
const circuitThreshold = 3;

function time(value?: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isProviderCircuitOpen(
  state: ProviderState,
  now = new Date(),
) {
  return time(state.circuitOpenUntil) > now.getTime();
}

/**
 * `unverified` is intentionally allowed to execute: a real request is the only
 * authoritative way to verify a stored credential. Only a confirmed credential
 * failure or a non-retryable runtime/configuration failure blocks traffic.
 */
export function canAttemptProvider(state: ProviderState, now = new Date()) {
  if (state.credentialStatus === "invalid") return false;
  if (isProviderCircuitOpen(state, now)) return false;
  return state.runtimeStatus !== "unavailable";
}

export function nextProviderFailureState(
  state: ProviderState,
  classification: ProviderFailureClassification,
  now = new Date(),
): ProviderFailureTransition {
  const previousFailure = time(state.lastFailureAt),
    withinWindow =
      previousFailure > 0 && now.getTime() - previousFailure <= failureWindowMs,
    consecutiveFailures = withinWindow
      ? Math.max(0, state.consecutiveFailures ?? 0) + 1
      : 1,
    credentialStatus: ProviderCredentialStatus = classification.credentialInvalid
      ? "invalid"
      : state.credentialStatus ?? "unverified",
    openCircuit = classification.retryable && consecutiveFailures >= circuitThreshold,
    runtimeStatus: ProviderRuntimeStatus = openCircuit
      ? "circuit_open"
      : classification.configInvalid || !classification.retryable
        ? "unavailable"
        : "degraded";

  return {
    credentialStatus,
    runtimeStatus,
    failureCode: classification.code,
    consecutiveFailures,
    lastFailureAt: now.toISOString(),
    circuitOpenUntil: openCircuit
      ? new Date(now.getTime() + circuitDurationMs).toISOString()
      : null,
  };
}

export function nextProviderSuccessState(now = new Date()) {
  return {
    credentialStatus: "valid" as const,
    runtimeStatus: "healthy" as const,
    failureCode: null,
    consecutiveFailures: 0,
    lastSuccessAt: now.toISOString(),
    circuitOpenUntil: null,
  };
}
