export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  cloudflareAIGatewayToken?: string;
  timeoutMs?: number;
}

export interface RuntimeProviderConfig {
  runtimeUrl: string;
  authSecret: string;
  provider: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
}

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

async function runtimeRequest(
  config: RuntimeProviderConfig,
  path: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      ...payload,
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
    response = await fetch(
      `${config.runtimeUrl.replace(/\/$/, "")}${path}`,
      {
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
    );
  if (!response.ok) throw await providerFailure(response, "AI Runtime");
  return response;
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
  const detail = (await response.text().catch(() => ""))
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
  return new Error(`${label} returned ${response.status}${detail ? `: ${detail}` : ""}`);
}
export async function createEmbedding(config: ProviderConfig, texts: string[]) {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/embeddings`,
    {
      method: "POST",
      headers: providerHeaders(config),
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
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `模型渠道返回 ${response.status}${detail ? `：${detail}` : ""}`,
    );
  }
  return true;
}
