import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSignature } from "@ai-bunshin/ai";
import { createRuntimeApp } from "./app";

const secret = "runtime-secret-that-is-at-least-32-characters";

async function signedRequest(path: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload),
    timestamp = String(Date.now()),
    requestId = crypto.randomUUID(),
    signature = await createRuntimeSignature({
      secret,
      method: "POST",
      path,
      timestamp,
      requestId,
      body,
    });
  return {
    request: new Request(`https://runtime.internal${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bunshin-Timestamp": timestamp,
        "X-Bunshin-Request-Id": requestId,
        "X-Bunshin-Signature": signature,
      },
      body,
    }),
    requestId,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Runtime protocol", () => {
  it("authenticates internal health probes", async () => {
    const app = createRuntimeApp({ AI_RUNTIME_AUTH_SECRET: secret }),
      { request } = await signedRequest("/internal/v1/health", {}),
      response = await app.fetch(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "ai-runtime",
      protocolVersion: 1,
    });

    const unsigned = await app.fetch(
      new Request("https://runtime.internal/internal/v1/health", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({
      error: { code: "RUNTIME_AUTH_MISCONFIGURED" },
    });
  });

  it("uses the signed request key first and pins preset provider URLs", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(String(input)).toBe(
          "https://api.openai.com/v1/chat/completions",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer request-key",
        );
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      }),
      app = createRuntimeApp({
        AI_RUNTIME_AUTH_SECRET: secret,
        OPENAI_API_KEY: "environment-fallback-key",
        AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS: "true",
      }),
      { request } = await signedRequest("/internal/v1/providers/test", {
        provider: "openai",
        baseUrl: "https://attacker.example/v1",
        model: "gpt-4.1-mini",
        apiKey: "request-key",
      }),
      response = await app.fetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("keeps environment provider keys as a compatibility fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer environment-fallback-key",
      );
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    });
      const app = createRuntimeApp({
        AI_RUNTIME_AUTH_SECRET: secret,
        OPENAI_API_KEY: "environment-fallback-key",
        AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS: "true",
      }),
      { request } = await signedRequest("/internal/v1/providers/test", {
        provider: "openai",
        model: "gpt-4.1-mini",
      }),
      response = await app.fetch(request);
    expect(response.status).toBe(200);
  });

  it("does not silently replace a missing request key with an environment key", async () => {
    const app = createRuntimeApp({
        AI_RUNTIME_AUTH_SECRET: secret,
        OPENAI_API_KEY: "must-not-be-used-by-default",
      }),
      { request } = await signedRequest("/internal/v1/providers/test", {
        provider: "openai",
        model: "gpt-4.1-mini",
      }),
      response = await app.fetch(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: "PROVIDER_KEY_MISSING",
        credentialInvalid: true,
      },
    });
  });

  it("requires an exact allowlisted custom HTTPS base URL", async () => {
    const app = createRuntimeApp({
        AI_RUNTIME_AUTH_SECRET: secret,
        AI_RUNTIME_CUSTOM_BASE_URLS: "https://models.example/v1",
      }),
      { request, requestId } = await signedRequest(
        "/internal/v1/providers/test",
        {
          provider: "custom",
          baseUrl: "https://models.example/unapproved",
          model: "custom-model",
          apiKey: "custom-request-key",
        },
      ),
      response = await app.fetch(request),
      body = (await response.json()) as {
        requestId?: string;
        error: Record<string, unknown>;
      };
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.requestId).toBe(requestId);
    expect(body.error).toMatchObject({
      code: "CUSTOM_BASE_URL_DENIED",
      configInvalid: true,
      credentialInvalid: false,
    });
  });

  it("returns classified provider failures without leaking credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: {
            code: "invalid_api_key",
            message: "Incorrect API key: request-secret-value",
          },
        },
        { status: 401 },
      ),
    );
    const app = createRuntimeApp({ AI_RUNTIME_AUTH_SECRET: secret }),
      { request, requestId } = await signedRequest(
        "/internal/v1/providers/test",
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          apiKey: "request-secret-value",
        },
      ),
      response = await app.fetch(request),
      text = await response.text(),
      body = JSON.parse(text);

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("request-secret-value");
    expect(body.requestId).toBe(requestId);
    expect(body.error).toEqual({
      code: "PROVIDER_AUTH_INVALID",
      message: "Provider authentication failed",
      status: 401,
      retryable: false,
      configInvalid: true,
      credentialInvalid: true,
      runtimeFailure: false,
    });
  });

  it("marks public health responses as non-cacheable", async () => {
    const response = await createRuntimeApp({}).fetch(
      new Request("https://runtime.internal/health"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
