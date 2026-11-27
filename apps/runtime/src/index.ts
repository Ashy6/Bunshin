import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createEmbedding,
  streamChat,
  testChatConnection,
  type ChatMessage,
  type ProviderConfig,
} from "@ai-bunshin/ai";
import { authorizeRuntimeRequest } from "./security";

type RuntimeEnv = {
  PORT?: string;
  AI_RUNTIME_AUTH_SECRET?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CUSTOM_PROVIDER_API_KEY?: string;
  AI_RUNTIME_CUSTOM_BASE_URLS?: string;
  AI_RUNTIME_REQUEST_TIMEOUT_MS?: string;
};

const runtimeEnv = process.env as RuntimeEnv,
  app = new Hono(),
  replayCache = new Map<string, number>(),
  maxBodyBytes = 2 * 1024 * 1024;

function requiredSecret() {
  const value = runtimeEnv.AI_RUNTIME_AUTH_SECRET;
  if (!value || value.length < 32)
    throw new Error("AI_RUNTIME_AUTH_SECRET must contain at least 32 characters");
  return value;
}

async function authorize(request: Request, body: string, path: string) {
  return authorizeRuntimeRequest({
    request,
    body,
    path,
    secret: requiredSecret(),
    replayCache,
  });
}

type RuntimePayload = {
  provider?: string;
  baseUrl?: string;
  model?: string;
  input?: string[];
  messages?: ChatMessage[];
};

async function readPayload(request: Request, path: string) {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > maxBodyBytes)
    return { error: "Request body is too large", status: 413 as const };
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes)
    return { error: "Request body is too large", status: 413 as const };
  try {
    if (!(await authorize(request, body, path)))
      return { error: "Unauthorized", status: 401 as const };
  } catch {
    return { error: "Runtime authentication is not configured", status: 503 as const };
  }
  try {
    return { payload: JSON.parse(body) as RuntimePayload };
  } catch {
    return { error: "Invalid JSON", status: 400 as const };
  }
}

function customOrigins() {
  return new Set(
    (runtimeEnv.AI_RUNTIME_CUSTOM_BASE_URLS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => new URL(item).origin),
  );
}

function providerConfig(payload: RuntimePayload): ProviderConfig {
  const provider = payload.provider,
    model = payload.model?.trim(),
    timeoutMs = Math.min(
      120_000,
      Math.max(5_000, Number(runtimeEnv.AI_RUNTIME_REQUEST_TIMEOUT_MS ?? 60_000)),
    );
  if (!provider || !model || model.length > 160)
    throw new Error("Provider and model are required");
  const presets: Record<string, { baseUrl: string; apiKey?: string }> = {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: runtimeEnv.OPENAI_API_KEY,
    },
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: runtimeEnv.DEEPSEEK_API_KEY,
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: runtimeEnv.OPENROUTER_API_KEY,
    },
  };
  const preset = presets[provider];
  if (preset) {
    if (!preset.apiKey) throw new Error(`${provider.toUpperCase()} API key is not configured`);
    return { baseUrl: preset.baseUrl, apiKey: preset.apiKey, model, timeoutMs };
  }
  if (provider !== "custom" || !payload.baseUrl)
    throw new Error("Provider is not allowed");
  const parsed = new URL(payload.baseUrl);
  if (parsed.protocol !== "https:" || !customOrigins().has(parsed.origin))
    throw new Error("Custom provider origin is not allowed");
  if (!runtimeEnv.CUSTOM_PROVIDER_API_KEY)
    throw new Error("CUSTOM_PROVIDER_API_KEY is not configured");
  return {
    baseUrl: payload.baseUrl.replace(/\/$/, ""),
    apiKey: runtimeEnv.CUSTOM_PROVIDER_API_KEY,
    model,
    timeoutMs,
  };
}

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "Runtime request failed";
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

app.get("/health", (c) => c.json({ ok: true, service: "ai-runtime" }));

app.post("/internal/v1/embeddings", async (c) => {
  const read = await readPayload(c.req.raw, "/internal/v1/embeddings");
  if ("error" in read) return c.json({ error: read.error }, read.status);
  const input = read.payload.input;
  if (!Array.isArray(input) || !input.length || input.length > 256 || input.some((item) => typeof item !== "string" || item.length > 50_000))
    return c.json({ error: "Embedding input is invalid" }, 400);
  try {
    return c.json(await createEmbedding(providerConfig(read.payload), input));
  } catch (error) {
    return c.json({ error: publicError(error) }, 502);
  }
});

app.post("/internal/v1/chat", async (c) => {
  const read = await readPayload(c.req.raw, "/internal/v1/chat");
  if ("error" in read) return c.json({ error: read.error }, read.status);
  const messages = read.payload.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 64 || messages.some((item) => !item || !["system", "user", "assistant"].includes(item.role) || typeof item.content !== "string" || item.content.length > 200_000))
    return c.json({ error: "Chat messages are invalid" }, 400);
  try {
    const upstream = await streamChat(providerConfig(read.payload), messages);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return c.json({ error: publicError(error) }, 502);
  }
});

app.post("/internal/v1/providers/test", async (c) => {
  const read = await readPayload(c.req.raw, "/internal/v1/providers/test");
  if ("error" in read) return c.json({ error: read.error }, read.status);
  try {
    await testChatConnection(providerConfig(read.payload));
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: publicError(error) }, 502);
  }
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", event: "runtime_unhandled", message: publicError(error) }));
  return c.json({ error: "Internal runtime error" }, 500);
});

const port = Number(runtimeEnv.PORT ?? 8790);
serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(JSON.stringify({ level: "info", event: "runtime_started", port: listeningPort }));
});
