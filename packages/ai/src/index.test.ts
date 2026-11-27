// @ts-nocheck -- executed directly by Node's TypeScript type stripping.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmbeddingViaRuntime,
  createRuntimeSignature,
  resolveProviderBaseUrl,
  testChatConnection,
} from "./index.ts";

test("routes only the native OpenAI base URL through the configured gateway", () => {
  const gateway = "https://gateway.ai.cloudflare.com/v1/account/default/openai/";
  assert.equal(
    resolveProviderBaseUrl("https://api.openai.com/v1", gateway),
    gateway.slice(0, -1),
  );
  assert.equal(
    resolveProviderBaseUrl("https://api.deepseek.com/v1", gateway),
    "https://api.deepseek.com/v1",
  );
});

test("adds Cloudflare AI Gateway auth without replacing the provider key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-user-test");
    assert.equal(headers.get("cf-aig-authorization"), "Bearer cf-gateway-test");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await testChatConnection({
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/default/openai",
      apiKey: "sk-user-test",
      model: "gpt-4.1-mini",
      cloudflareAIGatewayToken: "cf-gateway-test",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not send the Cloudflare token to arbitrary compatible providers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer provider-test");
    assert.equal(headers.get("cf-aig-authorization"), null);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await testChatConnection({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "provider-test",
      model: "gpt-4.1-mini",
      cloudflareAIGatewayToken: "must-not-leak",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signs Runtime requests without sending a provider API key", async () => {
  const originalFetch = globalThis.fetch,
    secret = "runtime-secret-that-is-long-enough-for-production";
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://runtime.example/internal/v1/embeddings");
    const headers = new Headers(init?.headers), body = String(init?.body);
    assert.equal(body.includes("apiKey"), false);
    assert.equal(headers.has("x-bunshin-request-id"), true);
    assert.equal(headers.has("x-bunshin-timestamp"), true);
    const expected = await createRuntimeSignature({
      secret,
      method: "POST",
      path: "/internal/v1/embeddings",
      timestamp: headers.get("x-bunshin-timestamp"),
      requestId: headers.get("x-bunshin-request-id"),
      body,
    });
    assert.equal(headers.get("x-bunshin-signature"), expected);
    return Response.json({
      vectors: [[0.1, 0.2]],
      usage: { inputTokens: 2, outputTokens: 0, cachedTokens: 0, estimated: false },
    });
  }) as typeof fetch;
  try {
    const result = await createEmbeddingViaRuntime(
      {
        runtimeUrl: "https://runtime.example/",
        authSecret: secret,
        provider: "openai",
        model: "text-embedding-3-small",
      },
      ["hello"],
    );
    assert.deepEqual(result.vectors, [[0.1, 0.2]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
