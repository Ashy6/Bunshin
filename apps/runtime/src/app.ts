import { Hono } from "hono";
import {
  classifyProviderError,
  createEmbedding,
  streamChat,
  testChatConnection,
  type ChatMessage,
  type ProviderConfig,
  type UpstreamErrorClassification,
  type UpstreamErrorCode,
} from "@ai-bunshin/ai";
import { authorizeRuntimeRequest } from "./security";

export type RuntimeEnv = {
  AI_RUNTIME_AUTH_SECRET?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CUSTOM_PROVIDER_API_KEY?: string;
  AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS?: string;
  AI_RUNTIME_CUSTOM_BASE_URLS?: string;
  AI_RUNTIME_REQUEST_TIMEOUT_MS?: string;
};

type RuntimePayload = {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  input?: string[];
  messages?: ChatMessage[];
};

const maxBodyBytes = 2 * 1024 * 1024;

function classification(
  overrides: Partial<UpstreamErrorClassification> = {},
): UpstreamErrorClassification {
  const code = overrides.code ?? "UNKNOWN";
  return {
    code,
    retryable: false,
    configInvalid: true,
    credentialInvalid:
      code === "PROVIDER_AUTH_INVALID" || code === "PROVIDER_KEY_MISSING",
    runtimeFailure: false,
    ...overrides,
  };
}

class RuntimeContractError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly classification: UpstreamErrorClassification,
  ) {
    super(message);
    this.name = "RuntimeContractError";
  }
}

function jsonError(
  httpStatus: number,
  message: string,
  errorClassification: UpstreamErrorClassification,
  requestId?: string,
) {
  return Response.json(
    {
      error: {
        code: errorClassification.code,
        message,
        ...(errorClassification.status === undefined
          ? {}
          : { status: errorClassification.status }),
        retryable: errorClassification.retryable,
        configInvalid: errorClassification.configInvalid,
        credentialInvalid: errorClassification.credentialInvalid,
        runtimeFailure: errorClassification.runtimeFailure,
      },
      ...(requestId ? { requestId } : {}),
    },
    {
      status: httpStatus,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=UTF-8",
      },
    },
  );
}

const providerMessages: Record<UpstreamErrorCode, string> = {
  PROVIDER_AUTH_INVALID: "Provider authentication failed",
  GATEWAY_AUTH_MISCONFIGURED: "AI Gateway authentication is misconfigured",
  ROUTE_REGION_UNSUPPORTED: "The provider is unavailable from this Runtime region",
  RATE_LIMITED: "The provider rate limit was reached",
  UPSTREAM_5XX: "The provider is temporarily unavailable",
  TIMEOUT: "The provider request timed out",
  RUNTIME_NOT_CONFIGURED: "The fixed-region Runtime is not configured",
  RUNTIME_AUTH_MISCONFIGURED: "Runtime authentication is misconfigured",
  CUSTOM_BASE_URL_DENIED: "The custom provider URL is not allowlisted",
  PROVIDER_KEY_MISSING: "The provider API key is missing",
  RUNTIME_REQUEST_INVALID: "The Runtime request is invalid",
  UNKNOWN: "The provider request failed",
};

function providerError(error: unknown, requestId?: string) {
  const result = classifyProviderError(error);
  return jsonError(502, providerMessages[result.code], result, requestId);
}

function normalizeCustomBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeContractError(
      "Custom provider base URL is invalid",
      400,
      classification({ code: "CUSTOM_BASE_URL_DENIED" }),
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new RuntimeContractError(
      "Custom provider base URL must be an allowlisted HTTPS URL",
      400,
      classification({ code: "CUSTOM_BASE_URL_DENIED" }),
    );
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

function customBaseUrls(env: RuntimeEnv) {
  const values = (env.AI_RUNTIME_CUSTOM_BASE_URLS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = new Set<string>();
  for (const value of values) allowed.add(normalizeCustomBaseUrl(value));
  return allowed;
}

function requestApiKey(payload: RuntimePayload) {
  if (payload.apiKey === undefined) return undefined;
  if (typeof payload.apiKey !== "string" || payload.apiKey.length > 16_384)
    throw new RuntimeContractError(
      "Provider API key is invalid",
      400,
      classification({ code: "RUNTIME_REQUEST_INVALID" }),
    );
  return payload.apiKey.trim() || undefined;
}

export function runtimeProviderConfig(
  payload: RuntimePayload,
  env: RuntimeEnv,
): ProviderConfig {
  const provider = payload.provider?.trim().toLowerCase(),
    model = payload.model?.trim(),
    configuredTimeout = Number(env.AI_RUNTIME_REQUEST_TIMEOUT_MS ?? 60_000),
    timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(120_000, Math.max(5_000, configuredTimeout))
      : 60_000,
    suppliedApiKey = requestApiKey(payload);
  if (!provider || !model || model.length > 160)
    throw new RuntimeContractError(
      "Provider and model are required",
      400,
      classification({ code: "RUNTIME_REQUEST_INVALID" }),
    );

  const allowEnvironmentKeys =
      env.AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS === "true",
    presets: Record<string, { baseUrl: string; fallbackApiKey?: string }> = {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      fallbackApiKey: env.OPENAI_API_KEY,
    },
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      fallbackApiKey: env.DEEPSEEK_API_KEY,
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      fallbackApiKey: env.OPENROUTER_API_KEY,
    },
  };
  const preset = presets[provider];
  if (preset) {
    const apiKey =
      suppliedApiKey ??
      (allowEnvironmentKeys ? preset.fallbackApiKey : undefined);
    if (!apiKey)
      throw new RuntimeContractError(
        `${provider.toUpperCase()} API key is not configured`,
        503,
        classification({ code: "PROVIDER_KEY_MISSING" }),
      );
    // A caller cannot replace a preset provider's upstream with an arbitrary
    // URL. This keeps an encrypted provider key scoped to its intended host.
    return { baseUrl: preset.baseUrl, apiKey, model, timeoutMs };
  }

  if (provider !== "custom" || !payload.baseUrl)
    throw new RuntimeContractError(
      "Provider is not allowed",
      400,
      classification({ code: "RUNTIME_REQUEST_INVALID" }),
    );
  const baseUrl = normalizeCustomBaseUrl(payload.baseUrl);
  if (!customBaseUrls(env).has(baseUrl))
    throw new RuntimeContractError(
      "Custom provider base URL is not allowlisted",
      400,
      classification({ code: "CUSTOM_BASE_URL_DENIED" }),
    );
  const apiKey =
    suppliedApiKey ??
    (allowEnvironmentKeys ? env.CUSTOM_PROVIDER_API_KEY : undefined);
  if (!apiKey)
    throw new RuntimeContractError(
      "Custom provider API key is not configured",
      503,
      classification({ code: "PROVIDER_KEY_MISSING" }),
    );
  return { baseUrl, apiKey, model, timeoutMs };
}

export function createRuntimeApp(runtimeEnv: RuntimeEnv) {
  const app = new Hono(), replayCache = new Map<string, number>();

  function requiredSecret() {
    const value = runtimeEnv.AI_RUNTIME_AUTH_SECRET;
    if (!value || value.length < 32)
      throw new RuntimeContractError(
        "Runtime authentication is not configured",
        503,
        classification({ code: "RUNTIME_AUTH_MISCONFIGURED" }),
      );
    return value;
  }

  async function readPayload(request: Request, path: string) {
    const requestId = request.headers.get("X-Bunshin-Request-Id") ?? undefined,
      declaredSize = Number(request.headers.get("content-length") ?? 0);
    if (declaredSize > maxBodyBytes)
      throw new RuntimeContractError(
        "Request body is too large",
        413,
        classification({ code: "RUNTIME_REQUEST_INVALID" }),
      );
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maxBodyBytes)
      throw new RuntimeContractError(
        "Request body is too large",
        413,
        classification({ code: "RUNTIME_REQUEST_INVALID" }),
      );
    if (
      !(await authorizeRuntimeRequest({
        request,
        body,
        path,
        secret: requiredSecret(),
        replayCache,
      }))
    )
      throw new RuntimeContractError(
        "Runtime request authentication failed",
        401,
        classification({ code: "RUNTIME_AUTH_MISCONFIGURED" }),
      );
    try {
      return { payload: JSON.parse(body) as RuntimePayload, requestId };
    } catch {
      throw new RuntimeContractError(
        "Invalid JSON",
        400,
        classification({ code: "RUNTIME_REQUEST_INVALID" }),
      );
    }
  }

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/health", (c) => c.json({ ok: true, service: "ai-runtime" }));

  app.post("/internal/v1/health", async (c) => {
    let requestId = c.req.header("X-Bunshin-Request-Id") || undefined;
    try {
      const read = await readPayload(c.req.raw, "/internal/v1/health");
      requestId = read.requestId;
      return c.json({ ok: true, service: "ai-runtime", protocolVersion: 1 });
    } catch (error) {
      if (error instanceof RuntimeContractError)
        return jsonError(
          error.httpStatus,
          error.message,
          error.classification,
          requestId,
        );
      return providerError(error, requestId);
    }
  });

  app.post("/internal/v1/embeddings", async (c) => {
    let requestId = c.req.header("X-Bunshin-Request-Id") || undefined;
    try {
      const read = await readPayload(c.req.raw, "/internal/v1/embeddings");
      requestId = read.requestId;
      const input = read.payload.input;
      if (
        !Array.isArray(input) ||
        !input.length ||
        input.length > 256 ||
        input.some(
          (item) => typeof item !== "string" || item.length > 50_000,
        )
      )
        throw new RuntimeContractError(
          "Embedding input is invalid",
          400,
          classification({ code: "RUNTIME_REQUEST_INVALID" }),
        );
      return c.json(
        await createEmbedding(
          runtimeProviderConfig(read.payload, runtimeEnv),
          input,
        ),
      );
    } catch (error) {
      if (error instanceof RuntimeContractError)
        return jsonError(
          error.httpStatus,
          error.message,
          error.classification,
          requestId,
        );
      return providerError(error, requestId);
    }
  });

  app.post("/internal/v1/chat", async (c) => {
    let requestId = c.req.header("X-Bunshin-Request-Id") || undefined;
    try {
      const read = await readPayload(c.req.raw, "/internal/v1/chat");
      requestId = read.requestId;
      const messages = read.payload.messages;
      if (
        !Array.isArray(messages) ||
        !messages.length ||
        messages.length > 64 ||
        messages.some(
          (item) =>
            !item ||
            !["system", "user", "assistant"].includes(item.role) ||
            typeof item.content !== "string" ||
            item.content.length > 200_000,
        )
      )
        throw new RuntimeContractError(
          "Chat messages are invalid",
          400,
          classification({ code: "RUNTIME_REQUEST_INVALID" }),
        );
      const upstream = await streamChat(
        runtimeProviderConfig(read.payload, runtimeEnv),
        messages,
      );
      return new Response(upstream.body, {
        headers: {
          "Content-Type":
            upstream.headers.get("Content-Type") ?? "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof RuntimeContractError)
        return jsonError(
          error.httpStatus,
          error.message,
          error.classification,
          requestId,
        );
      return providerError(error, requestId);
    }
  });

  app.post("/internal/v1/providers/test", async (c) => {
    let requestId = c.req.header("X-Bunshin-Request-Id") || undefined;
    try {
      const read = await readPayload(c.req.raw, "/internal/v1/providers/test");
      requestId = read.requestId;
      await testChatConnection(runtimeProviderConfig(read.payload, runtimeEnv));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof RuntimeContractError)
        return jsonError(
          error.httpStatus,
          error.message,
          error.classification,
          requestId,
        );
      return providerError(error, requestId);
    }
  });

  app.notFound(() =>
    jsonError(404, "Not found", classification({ configInvalid: false })),
  );
  app.onError((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "runtime_unhandled",
        message: error instanceof Error ? error.name : "Unknown error",
      }),
    );
    return jsonError(
      500,
      "Internal runtime error",
      classification({ retryable: true, configInvalid: false, runtimeFailure: true }),
    );
  });

  return app;
}
