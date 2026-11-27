import { describe, expect, it } from "vitest";
import { createRuntimeSignature } from "@ai-bunshin/ai";
import { authorizeRuntimeRequest } from "./security";

const secret = "runtime-secret-that-is-at-least-32-characters",
  path = "/internal/v1/chat",
  body = JSON.stringify({ provider: "openai", model: "gpt-4.1-mini" });

async function signedRequest(now: number, requestId = crypto.randomUUID()) {
  const timestamp = String(now),
    signature = await createRuntimeSignature({
      secret,
      method: "POST",
      path,
      timestamp,
      requestId,
      body,
    });
  return new Request(`https://runtime.example${path}`, {
    method: "POST",
    headers: {
      "X-Bunshin-Timestamp": timestamp,
      "X-Bunshin-Request-Id": requestId,
      "X-Bunshin-Signature": signature,
    },
    body,
  });
}

describe("Runtime request authorization", () => {
  it("accepts a valid signature once and rejects replay", async () => {
    const now = Date.now(), replayCache = new Map<string, number>(), request = await signedRequest(now);
    expect(await authorizeRuntimeRequest({ request, body, path, secret, replayCache, now })).toBe(true);
    expect(await authorizeRuntimeRequest({ request, body, path, secret, replayCache, now })).toBe(false);
  });

  it("rejects expired and invalid signatures", async () => {
    const now = Date.now(), replayCache = new Map<string, number>();
    expect(await authorizeRuntimeRequest({
      request: await signedRequest(now - 6 * 60_000), body, path, secret, replayCache, now,
    })).toBe(false);
    expect(await authorizeRuntimeRequest({
      request: new Request(`https://runtime.example${path}`, {
        method: "POST",
        headers: {
          "X-Bunshin-Timestamp": String(now),
          "X-Bunshin-Request-Id": crypto.randomUUID(),
          "X-Bunshin-Signature": "invalid",
        },
        body,
      }), body, path, secret, replayCache, now,
    })).toBe(false);
  });
});
