import { createRuntimeApp, type RuntimeEnv } from "./app";

type RuntimeApp = ReturnType<typeof createRuntimeApp>;

let cachedApp: RuntimeApp | undefined;
let cachedConfiguration = "";

function configurationFingerprint(env: RuntimeEnv) {
  return [
    env.AI_RUNTIME_AUTH_SECRET,
    env.OPENAI_API_KEY,
    env.DEEPSEEK_API_KEY,
    env.OPENROUTER_API_KEY,
    env.CUSTOM_PROVIDER_API_KEY,
    env.AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS,
    env.AI_RUNTIME_CUSTOM_BASE_URLS,
    env.AI_RUNTIME_REQUEST_TIMEOUT_MS,
  ].join("\u0000");
}

function appFor(env: RuntimeEnv) {
  const fingerprint = configurationFingerprint(env);
  if (!cachedApp || cachedConfiguration !== fingerprint) {
    cachedApp = createRuntimeApp(env);
    cachedConfiguration = fingerprint;
  }
  return cachedApp;
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const response = await appFor(env).fetch(request);
    const placement = request.headers.get("cf-placement");
    if (!placement) return response;

    const headers = new Headers(response.headers);
    headers.set("X-Bunshin-Runtime-Placement", placement);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<RuntimeEnv>;
