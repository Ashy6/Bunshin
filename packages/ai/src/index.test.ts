// @ts-nocheck -- executed directly by Node's TypeScript type stripping.
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyUpstreamError,
  createEmbeddingViaGateway,
  createEmbeddingViaRuntime,
  createRuntimeSignature,
  resolveProviderBaseUrl,
  testChatConnection,
  testChatViaGateway,
  testChatViaRuntime,
  testRuntimeConnection,
  UpstreamProviderError,
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

test("uses the Worker AI Gateway binding without a gateway token", async () => {
  const requests = [];
  const gateway = {
    async run(request) {
      requests.push(request);
      if (request.endpoint === "embeddings")
        return Response.json({
          data: [{ embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 3 },
        });
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    },
  };
  await testChatViaGateway(gateway, {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-user-test",
    model: "gpt-4.1-mini",
  });
  const embedding = await createEmbeddingViaGateway(
    gateway,
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-user-test",
      model: "text-embedding-3-small",
    },
    ["hello"],
  );
  assert.equal(requests[0].headers.Authorization, "Bearer sk-user-test");
  assert.equal("cf-aig-authorization" in requests[0].headers, false);
  assert.equal(requests[0].endpoint, "chat/completions");
  assert.equal(requests[1].endpoint, "embeddings");
  assert.deepEqual(embedding.vectors, [[0.1, 0.2]]);
});

test("sends the provider key only in the signed Service Binding body", async () => {
  const secret = "runtime-secret-that-is-long-enough-for-production",
    runtimeFetcher = { async fetch(input, init) {
    assert.equal(String(input), "https://ai-runtime.internal/internal/v1/embeddings");
    const headers = new Headers(init?.headers), body = String(init?.body),
      parsed = JSON.parse(body);
    assert.equal(parsed.apiKey, "provider-key-from-d1");
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
  }};
  const result = await createEmbeddingViaRuntime(
    {
      runtimeFetcher,
      authSecret: secret,
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "provider-key-from-d1",
    },
    ["hello"],
  );
  assert.deepEqual(result.vectors, [[0.1, 0.2]]);
});

test("keeps the HTTPS Runtime URL transport for compatible deployments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(
      String(input),
      "https://runtime.example/internal/v1/providers/test",
    );
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    assert.equal(await testChatViaRuntime({
      runtimeUrl: "https://runtime.example/",
      authSecret: "runtime-secret-that-is-long-enough-for-production",
      provider: "openai",
      model: "gpt-4.1-mini",
    }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("performs an authenticated Runtime health probe without provider credentials", async () => {
  const runtimeFetcher = { async fetch(input, init) {
    assert.equal(String(input), "https://ai-runtime.internal/internal/v1/health");
    const body = String(init?.body ?? "");
    assert.equal(body, "{}");
    assert.ok(new Headers(init?.headers).get("x-bunshin-signature"));
    return Response.json({ ok: true, service: "ai-runtime", protocolVersion: 1 });
  }};
  assert.deepEqual(
    await testRuntimeConnection({
      runtimeFetcher,
      authSecret: "runtime-secret-that-is-long-enough-for-production",
    }),
    { ok: true, service: "ai-runtime", protocolVersion: 1 },
  );
});

test("rejects an insecure remote Runtime URL before sending a provider key", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    await assert.rejects(
      testChatViaRuntime({
        runtimeUrl: "http://runtime.example",
        authSecret: "runtime-secret-that-is-long-enough-for-production",
        provider: "openai",
        model: "gpt-4.1-mini",
        apiKey: "must-not-leak",
      }),
      (error) => {
        assert.equal(error.code, "RUNTIME_NOT_CONFIGURED");
        return true;
      },
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves structured provider semantics returned by Runtime", async () => {
  const runtimeFetcher = { async fetch() {
    return Response.json({
      error: {
        code: "PROVIDER_AUTH_INVALID",
        message: "Provider authentication failed",
        status: 401,
        retryable: false,
        configInvalid: true,
        credentialInvalid: true,
        runtimeFailure: false,
      },
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }};
  await assert.rejects(
    testChatViaRuntime({
      runtimeFetcher,
      authSecret: "runtime-secret-that-is-long-enough-for-production",
      provider: "openai",
      model: "gpt-4.1-mini",
      apiKey: "bad-key",
    }),
    (error) => {
      assert.equal(error instanceof UpstreamProviderError, true);
      assert.equal(error.code, "PROVIDER_AUTH_INVALID");
      assert.equal(error.status, 401);
      assert.equal(error.credentialInvalid, true);
      assert.equal(error.runtimeFailure, false);
      return true;
    },
  );
});

test("classifies provider credentials without confusing gateway authentication", () => {
  assert.deepEqual(
    classifyUpstreamError(new Error("Chat provider returned 401: invalid_api_key")),
    {
      code: "PROVIDER_AUTH_INVALID",
      status: 401,
      retryable: false,
      configInvalid: true,
      credentialInvalid: true,
      runtimeFailure: false,
    },
  );
  assert.deepEqual(
    classifyUpstreamError(new Error("AI Gateway returned 401"), {
      status: 401,
      body: { error: { type: "AiGatewayError", code: 2009 } },
    }),
    {
      code: "GATEWAY_AUTH_MISCONFIGURED",
      status: 401,
      retryable: false,
      configInvalid: true,
      credentialInvalid: false,
      runtimeFailure: false,
    },
  );
});

test("classifies route, throttling, upstream and timeout failures", () => {
  assert.equal(
    classifyUpstreamError(
      new Error("403 unsupported_country_region_territory"),
    ).code,
    "ROUTE_REGION_UNSUPPORTED",
  );
  assert.deepEqual(classifyUpstreamError("too many requests", { status: 429 }), {
    code: "RATE_LIMITED",
    status: 429,
    retryable: true,
    configInvalid: false,
    credentialInvalid: false,
    runtimeFailure: true,
  });
  assert.equal(
    classifyUpstreamError("provider returned 503").code,
    "UPSTREAM_5XX",
  );
  assert.equal(
    classifyUpstreamError(new DOMException("timed out", "TimeoutError")).code,
    "TIMEOUT",
  );
});

test("unknown failures are retryable and never invalidate credentials", () => {
  assert.deepEqual(classifyUpstreamError(new TypeError("fetch failed")), {
    code: "UNKNOWN",
    retryable: true,
    configInvalid: false,
    credentialInvalid: false,
    runtimeFailure: true,
  });
});

test("a generic 403 does not permanently invalidate a provider key", () => {
  assert.deepEqual(
    classifyUpstreamError({ status: 403, body: "Forbidden by edge policy" }),
    {
      code: "UNKNOWN",
      status: 403,
      retryable: true,
      configInvalid: false,
      credentialInvalid: false,
      runtimeFailure: true,
    },
  );
});

test("classifies missing Runtime configuration and provider keys explicitly", () => {
  assert.deepEqual(
    classifyUpstreamError(
      new Error("AI Runtime authentication is not configured"),
    ),
    {
      code: "RUNTIME_NOT_CONFIGURED",
      retryable: false,
      configInvalid: true,
      credentialInvalid: false,
      runtimeFailure: false,
    },
  );
  assert.deepEqual(
    classifyUpstreamError(new Error("Provider API key is not configured")),
    {
      code: "PROVIDER_KEY_MISSING",
      retryable: false,
      configInvalid: true,
      credentialInvalid: true,
      runtimeFailure: false,
    },
  );
});

test("provider helpers throw a classified Error while preserving their message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { type: "AiGatewayError", code: 2009 } }),
      { status: 401 },
    )) as typeof fetch;
  try {
    await assert.rejects(
      testChatConnection({
        baseUrl: "https://gateway.ai.cloudflare.com/v1/a/b/openai",
        apiKey: "sk-user-test",
        model: "gpt-4.1-mini",
      }),
      (error: unknown) => {
        assert.equal(error instanceof UpstreamProviderError, true);
        assert.match((error as Error).message, /^模型渠道返回 401/);
        assert.equal(
          (error as UpstreamProviderError).code,
          "GATEWAY_AUTH_MISCONFIGURED",
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
