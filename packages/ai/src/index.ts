export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  cloudflareAIGatewayToken?: string;
  timeoutMs?: number;
}

export interface AIGatewayBinding {
  run(
    request: {
      provider: string;
      endpoint: string;
      headers: Record<string, string>;
      query: unknown;
    },
    options?: { signal?: AbortSignal },
  ): Promise<Response>;
}

export {
  classifyProviderError,
  classifyUpstreamError,
  toUpstreamProviderError,
  UpstreamProviderError,
  upstreamErrorCodes,
} from "./upstream-errors";
export type {
  UpstreamErrorClassification,
  UpstreamErrorCode,
  UpstreamErrorContext,
} from "./upstream-errors";
export {
  canAttemptProvider,
  isProviderCircuitOpen,
  nextProviderFailureState,
  nextProviderSuccessState,
} from "./provider-state";
export type {
  ProviderCredentialStatus,
  ProviderExecutionRoute,
  ProviderFailureClassification,
  ProviderFailureTransition,
  ProviderRuntimeStatus,
  ProviderState,
} from "./provider-state";

import {
  UpstreamProviderError,
  toUpstreamProviderError,
  upstreamErrorCodes,
  type UpstreamErrorClassification,
} from "./upstream-errors";

export interface RuntimeFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

type RuntimeProviderTarget =
  | { runtimeFetcher: RuntimeFetcher; runtimeUrl?: never }
  | { runtimeUrl: string; runtimeFetcher?: never };

export type RuntimeConnectionConfig = RuntimeProviderTarget & {
  authSecret: string;
  timeoutMs?: number;
};

export type RuntimeProviderConfig = RuntimeConnectionConfig & {
  provider: string;
  baseUrl?: string;
  model: string;
  /**
   * Sent only inside the HMAC-covered body. Runtime rejects an omitted key by
   * default; the environment-key fallback exists only behind an explicit
   * migration flag and must remain disabled in normal production.
   */
  apiKey?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function sha256(value: string) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

export async function createRuntimeSignature(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  requestId: string;
  body: string;
}) {
  const bodyHash = await sha256(input.body),
    payload = [
      input.method.toUpperCase(),
      input.path,
      input.timestamp,
      input.requestId,
      bodyHash,
    ].join("\n"),
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(input.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    ),
  );
}

type RuntimeErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    status?: number;
    retryable?: boolean;
    configInvalid?: boolean;
    credentialInvalid?: boolean;
    runtimeFailure?: boolean;
  };
  requestId?: string;
};

function redactFailureDetail(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

async function runtimeFailure(response: Response) {
  const raw = redactFailureDetail(await response.text().catch(() => ""));
  let envelope: RuntimeErrorEnvelope | undefined;
  try {
    envelope = JSON.parse(raw) as RuntimeErrorEnvelope;
  } catch {
    // Older Runtime deployments returned plain text. The generic classifier
    // below keeps those deployments backwards compatible during rollout.
  }
  const detail = envelope?.error,
    message = detail?.message ?? raw,
    code = detail?.code;
  if (
    code &&
    upstreamErrorCodes.includes(
      code as (typeof upstreamErrorCodes)[number],
    ) &&
    typeof detail.retryable === "boolean" &&
    typeof detail.configInvalid === "boolean" &&
    typeof detail.credentialInvalid === "boolean" &&
    typeof detail.runtimeFailure === "boolean"
  ) {
    const classification: UpstreamErrorClassification = {
      code: code as (typeof upstreamErrorCodes)[number],
      ...(typeof detail.status === "number"
        ? { status: detail.status }
        : {}),
      retryable: detail.retryable,
      configInvalid: detail.configInvalid,
      credentialInvalid: detail.credentialInvalid,
      runtimeFailure: detail.runtimeFailure,
    };
    return new UpstreamProviderError(
      `AI Runtime returned ${response.status}${message ? `: ${message}` : ""}`,
      classification,
    );
  }
  return toUpstreamProviderError(
    `AI Runtime returned ${response.status}${message ? `: ${message}` : ""}`,
    { status: response.status, body: envelope ?? raw },
  );
}

async function runtimeRequest(
  config: RuntimeConnectionConfig | RuntimeProviderConfig,
  path: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify({
      ...payload,
      ...("provider" in config
        ? {
            provider: config.provider,
            baseUrl: config.baseUrl,
            model: config.model,
            apiKey: config.apiKey,
          }
        : {}),
    }),
    timestamp = String(Date.now()),
    requestId = crypto.randomUUID(),
    signature = await createRuntimeSignature({
      secret: config.authSecret,
      method: "POST",
      path,
      timestamp,
      requestId,
      body,
    }),
    requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bunshin-Timestamp": timestamp,
        "X-Bunshin-Request-Id": requestId,
        "X-Bunshin-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
    },
    response = config.runtimeFetcher
      ? await config.runtimeFetcher.fetch(
          `https://ai-runtime.internal${path}`,
          requestInit,
        )
      : await fetch(
          `${normalizeRuntimeUrl(config.runtimeUrl)}${path}`,
          requestInit,
        );
  if (!response.ok) throw await runtimeFailure(response);
  return response;
}

function normalizeRuntimeUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw toUpstreamProviderError("AI Runtime transport URL is not allowed");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw toUpstreamProviderError("AI Runtime transport URL is not allowed");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export async function testRuntimeConnection(config: RuntimeConnectionConfig) {
  const response = await runtimeRequest(config, "/internal/v1/health", {});
  const body = (await response.json()) as {
    ok?: boolean;
    service?: string;
    protocolVersion?: number;
  };
  if (!body.ok || body.protocolVersion !== 1)
    throw toUpstreamProviderError("AI Runtime health probe failed", {
      status: 502,
      body,
    });
  return body;
}

export async function createEmbeddingViaRuntime(
  config: RuntimeProviderConfig,
  texts: string[],
) {
  const response = await runtimeRequest(config, "/internal/v1/embeddings", {
    input: texts,
  });
  return (await response.json()) as {
    vectors: number[][];
    usage: NormalizedUsage;
  };
}

export function streamChatViaRuntime(
  config: RuntimeProviderConfig,
  messages: ChatMessage[],
) {
  return runtimeRequest(config, "/internal/v1/chat", { messages });
}

export async function testChatViaRuntime(config: RuntimeProviderConfig) {
  await runtimeRequest(config, "/internal/v1/providers/test", {});
  return true;
}
export function resolveProviderBaseUrl(
  baseUrl: string,
  cloudflareAIGatewayBaseUrl?: string,
) {
  if (
    cloudflareAIGatewayBaseUrl &&
    new URL(baseUrl).hostname === "api.openai.com"
  )
    return cloudflareAIGatewayBaseUrl.replace(/\/$/, "");
  return baseUrl.replace(/\/$/, "");
}
function providerHeaders(config: ProviderConfig) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
  if (
    config.cloudflareAIGatewayToken &&
    new URL(config.baseUrl).hostname === "gateway.ai.cloudflare.com"
  )
    headers["cf-aig-authorization"] =
      `Bearer ${config.cloudflareAIGatewayToken}`;
  return headers;
}
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimated: boolean;
}
async function providerFailure(response: Response, label: string) {
  const detail = redactProviderDetail(await response.text().catch(() => ""));
  const message = `${label} returned ${response.status}${detail ? `: ${detail}` : ""}`;
  return toUpstreamProviderError(message, {
    status: response.status,
    body: detail,
  });
}
function redactProviderDetail(detail: string) {
  return detail
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}
function bindingRequest(
  gateway: AIGatewayBinding,
  endpoint: string,
  config: ProviderConfig,
  query: Record<string, unknown>,
) {
  return gateway.run(
    {
      provider: "openai",
      endpoint,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      query,
    },
    { signal: AbortSignal.timeout(config.timeoutMs ?? 60_000) },
  );
}
export async function createEmbeddingViaGateway(
  gateway: AIGatewayBinding,
  config: ProviderConfig,
  texts: string[],
) {
  const response = await bindingRequest(gateway, "embeddings", config, {
    model: config.model,
    input: texts,
  });
  if (!response.ok)
    throw await providerFailure(response, "AI Gateway embedding provider");
  const body = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    },
    tokens =
      body.usage?.prompt_tokens ??
      body.usage?.total_tokens ??
      Math.ceil(texts.join(" ").length / 3);
  return {
    vectors: body.data.map((item) => item.embedding),
    usage: {
      inputTokens: tokens,
      outputTokens: 0,
      cachedTokens: 0,
      estimated: !body.usage,
    },
  };
}
export async function streamChatViaGateway(
  gateway: AIGatewayBinding,
  config: ProviderConfig,
  messages: ChatMessage[],
) {
  const response = await bindingRequest(gateway, "chat/completions", config, {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  if (!response.ok)
    throw await providerFailure(response, "AI Gateway chat provider");
  if (!response.body)
    throw new Error("AI Gateway chat provider returned an empty response body");
  return response;
}
export async function testChatViaGateway(
  gateway: AIGatewayBinding,
  config: ProviderConfig,
) {
  const response = await bindingRequest(gateway, "chat/completions", config, {
    model: config.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    stream: false,
  });
  if (!response.ok)
    throw await providerFailure(response, "AI Gateway chat provider");
  return true;
}
export async function createEmbedding(config: ProviderConfig, texts: string[]) {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/embeddings`,
    {
      method: "POST",
      headers: providerHeaders(config),
      redirect: "error",
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
    },
  );
  if (!response.ok)
    throw await providerFailure(response, "Embedding provider");
  const body = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const tokens =
    body.usage?.prompt_tokens ??
    body.usage?.total_tokens ??
    Math.ceil(texts.join(" ").length / 3);
  return {
    vectors: body.data.map((item) => item.embedding),
    usage: {
      inputTokens: tokens,
      outputTokens: 0,
      cachedTokens: 0,
      estimated: !body.usage,
    },
  };
}
export async function streamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
) {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: providerHeaders(config),
      redirect: "error",
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
    },
  );
  if (!response.ok)
    throw await providerFailure(response, "Chat provider");
  if (!response.body)
    throw new Error("Chat provider returned an empty response body");
  return response;
}
export async function testChatConnection(config: ProviderConfig) {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: providerHeaders(config),
      redirect: "error",
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
    },
  );
  if (!response.ok) {
    const detail = redactProviderDetail(await response.text().catch(() => ""))
      .slice(0, 300);
    const message =
      `模型渠道返回 ${response.status}${detail ? `：${detail}` : ""}`;
    throw toUpstreamProviderError(message, {
      status: response.status,
      body: detail,
    });
  }
  return true;
}
