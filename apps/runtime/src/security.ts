import { createRuntimeSignature } from "@ai-bunshin/ai";

export function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++)
    mismatch |= a[index]! ^ b[index]!;
  return mismatch === 0;
}

export async function authorizeRuntimeRequest(input: {
  request: Request;
  body: string;
  path: string;
  secret: string;
  replayCache: Map<string, number>;
  now?: number;
}) {
  const now = input.now ?? Date.now(),
    timestamp = input.request.headers.get("X-Bunshin-Timestamp") ?? "",
    requestId = input.request.headers.get("X-Bunshin-Request-Id") ?? "",
    signature = input.request.headers.get("X-Bunshin-Signature") ?? "",
    timestampMs = Number(timestamp);
  if (
    !requestId ||
    !signature ||
    !Number.isFinite(timestampMs) ||
    Math.abs(now - timestampMs) > 5 * 60_000
  )
    return false;
  const seenUntil = input.replayCache.get(requestId);
  if (seenUntil && seenUntil > now) return false;
  const expected = await createRuntimeSignature({
    secret: input.secret,
    method: input.request.method,
    path: input.path,
    timestamp,
    requestId,
    body: input.body,
  });
  if (!constantTimeEqual(expected, signature)) return false;
  input.replayCache.set(requestId, now + 5 * 60_000);
  if (input.replayCache.size > 10_000) {
    for (const [id, expiresAt] of input.replayCache)
      if (expiresAt <= now) input.replayCache.delete(id);
  }
  return true;
}
