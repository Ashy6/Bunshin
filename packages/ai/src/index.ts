export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
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
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.model, input: texts }),
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
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
) {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
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
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
      }),
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
