export const upstreamErrorCodes = [
  "PROVIDER_AUTH_INVALID",
  "GATEWAY_AUTH_MISCONFIGURED",
  "ROUTE_REGION_UNSUPPORTED",
  "RATE_LIMITED",
  "UPSTREAM_5XX",
  "TIMEOUT",
  "RUNTIME_NOT_CONFIGURED",
  "RUNTIME_AUTH_MISCONFIGURED",
  "CUSTOM_BASE_URL_DENIED",
  "PROVIDER_KEY_MISSING",
  "RUNTIME_REQUEST_INVALID",
  "UNKNOWN",
] as const;

export type UpstreamErrorCode = (typeof upstreamErrorCodes)[number];

export interface UpstreamErrorContext {
  /** HTTP status returned by the provider or gateway, when available. */
  status?: number;
  /** Raw response body. Objects are inspected without being exposed publicly. */
  body?: unknown;
}

export interface UpstreamErrorClassification {
  code: UpstreamErrorCode;
  status?: number;
  /** The exact same request can reasonably be retried after a short delay. */
  retryable: boolean;
  /** A credential, gateway token, model or other operator setting must change. */
  configInvalid: boolean;
  /** Only the model-provider credential is invalid; gateway config is separate. */
  credentialInvalid: boolean;
  /** The failure belongs to the execution route, not to RAG retrieval. */
  runtimeFailure: boolean;
}

/**
 * Error used by provider helpers. It remains an Error, so existing callers that
 * only read `message` keep working, while new callers can use `classification`.
 */
export class UpstreamProviderError extends Error {
  readonly classification: UpstreamErrorClassification;
  readonly code: UpstreamErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly configInvalid: boolean;
  readonly credentialInvalid: boolean;
  readonly runtimeFailure: boolean;

  constructor(message: string, classification: UpstreamErrorClassification) {
    super(message);
    this.name = "UpstreamProviderError";
    this.classification = classification;
    this.code = classification.code;
    this.status = classification.status;
    this.retryable = classification.retryable;
    this.configInvalid = classification.configInvalid;
    this.credentialInvalid = classification.credentialInvalid;
    this.runtimeFailure = classification.runtimeFailure;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringifyForInspection(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error)
    return `${value.name} ${value.message} ${stringifyForInspection(value.cause)}`;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function statusFrom(value: unknown) {
  const record = objectRecord(value),
    direct = record?.status ?? record?.statusCode;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string" && /^\d{3}$/.test(direct))
    return Number(direct);
  const match = stringifyForInspection(value).match(
    /(?:returned|return(?:ed)?|status|返回)\s*[:：]?\s*(\d{3})/i,
  );
  return match?.[1] ? Number(match[1]) : undefined;
}

function classification(
  code: UpstreamErrorCode,
  status: number | undefined,
  retryable: boolean,
  configInvalid: boolean,
): UpstreamErrorClassification {
  return {
    code,
    ...(status === undefined ? {} : { status }),
    retryable,
    configInvalid,
    credentialInvalid:
      code === "PROVIDER_AUTH_INVALID" || code === "PROVIDER_KEY_MISSING",
    runtimeFailure: !configInvalid,
  };
}

/**
 * Convert provider, AI Gateway and network failures into stable business
 * semantics. Specific gateway/route errors intentionally take precedence over
 * their generic HTTP status (for example, Gateway code 2009 is not a bad
 * OpenAI key even though the response status is 401).
 */
export function classifyProviderError(
  error: unknown,
  context: UpstreamErrorContext = {},
): UpstreamErrorClassification {
  if (error instanceof UpstreamProviderError) return error.classification;

  const status = context.status ?? statusFrom(context.body) ?? statusFrom(error),
    text = `${stringifyForInspection(error)} ${stringifyForInspection(context.body)}`.toLowerCase();

  if (
    text.includes("aigatewayerror") ||
    text.includes("ai gateway error") ||
    text.includes("cf-aig-authorization") ||
    /["'\s:]code["'\s:]+2009\b/.test(text)
  )
    return classification(
      "GATEWAY_AUTH_MISCONFIGURED",
      status,
      false,
      true,
    );

  if (
    text.includes("unsupported_country_region_territory") ||
    text.includes("unsupported country") ||
    text.includes("country, region, or territory") ||
    text.includes("country or region is not supported")
  )
    return classification("ROUTE_REGION_UNSUPPORTED", status, false, false);

  if (
    text.includes("timeouterror") ||
    text.includes("aborterror") ||
    text.includes("etimedout") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("超时")
  )
    return classification("TIMEOUT", status, true, false);

  if (
    status === 429 ||
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("请求过于频繁")
  )
    return classification("RATE_LIMITED", status, true, false);

  if (
    text.includes("ai runtime transport unavailable") ||
    text.includes("ai runtime transport url is not allowed") ||
    text.includes("ai runtime authentication is not configured") ||
    text.includes("fixed-region runtime is not configured")
  )
    return classification("RUNTIME_NOT_CONFIGURED", status, false, true);

  if (
    text.includes("runtime request authentication failed") ||
    text.includes("runtime authentication is misconfigured")
  )
    return classification("RUNTIME_AUTH_MISCONFIGURED", status, false, true);

  if (
    text.includes("custom provider base url is not allowlisted") ||
    text.includes("custom provider url is not allowlisted")
  )
    return classification("CUSTOM_BASE_URL_DENIED", status, false, true);

  if (
    text.includes("provider api key is not configured") ||
    text.includes("provider key unavailable")
  )
    return classification("PROVIDER_KEY_MISSING", status, false, true);

  if (status !== undefined && status >= 500 && status <= 599)
    return classification("UPSTREAM_5XX", status, true, false);

  if (
    status === 401 ||
    text.includes("invalid_api_key") ||
    text.includes("incorrect api key") ||
    text.includes("invalid authentication") ||
    text.includes("missing scopes") ||
    text.includes("insufficient permissions")
  )
    return classification("PROVIDER_AUTH_INVALID", status, false, true);

  // A bare 403 is frequently produced by a regional edge, WAF or proxy. It
  // is not sufficient evidence that the provider credential is invalid. Keep
  // it recoverable unless the response contained one of the explicit auth or
  // permission signals handled above.
  if (status === 403)
    return classification("UNKNOWN", status, true, false);

  // Unknown transport failures must not invalidate otherwise valid provider
  // credentials. They are retryable until the caller's circuit breaker decides
  // otherwise.
  return classification("UNKNOWN", status, true, false);
}

/** @deprecated Prefer classifyProviderError in new state-machine code. */
export const classifyUpstreamError = classifyProviderError;

export function toUpstreamProviderError(
  message: string,
  context: UpstreamErrorContext = {},
) {
  return new UpstreamProviderError(
    message,
    classifyProviderError(message, context),
  );
}
