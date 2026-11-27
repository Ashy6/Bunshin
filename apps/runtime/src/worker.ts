import { Container } from "@cloudflare/containers";

interface Env {
  AI_RUNTIME: DurableObjectNamespace<AiRuntimeContainer>;
  AI_RUNTIME_AUTH_SECRET: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CUSTOM_PROVIDER_API_KEY?: string;
  AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS?: string;
  AI_RUNTIME_CUSTOM_BASE_URLS?: string;
  AI_RUNTIME_REQUEST_TIMEOUT_MS?: string;
}

/**
 * A singleton model-execution process pinned to supported US regions.
 * Secrets are Worker bindings and only become process environment variables
 * when Cloudflare starts the private Container instance.
 */
export class AiRuntimeContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars: Record<string, string>;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      PORT: "8080",
      AI_RUNTIME_AUTH_SECRET: env.AI_RUNTIME_AUTH_SECRET,
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
      ...(env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY } : {}),
      ...(env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY } : {}),
      ...(env.CUSTOM_PROVIDER_API_KEY
        ? { CUSTOM_PROVIDER_API_KEY: env.CUSTOM_PROVIDER_API_KEY }
        : {}),
      AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS:
        env.AI_RUNTIME_ALLOW_ENV_PROVIDER_KEYS ?? "false",
      ...(env.AI_RUNTIME_CUSTOM_BASE_URLS
        ? { AI_RUNTIME_CUSTOM_BASE_URLS: env.AI_RUNTIME_CUSTOM_BASE_URLS }
        : {}),
      ...(env.AI_RUNTIME_REQUEST_TIMEOUT_MS
        ? { AI_RUNTIME_REQUEST_TIMEOUT_MS: env.AI_RUNTIME_REQUEST_TIMEOUT_MS }
        : {}),
    };
  }

  override onStart() {
    console.log(JSON.stringify({ level: "info", event: "runtime_container_started" }));
  }

  override onError(error: unknown) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "runtime_container_error",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await env.AI_RUNTIME
        .getByName("ai-bunshin-runtime-singleton")
        .fetch(request),
        headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return Response.json(
        {
          error: {
            code: "UNKNOWN",
            message: "AI Runtime container is unavailable",
            retryable: true,
            configInvalid: false,
            credentialInvalid: false,
            runtimeFailure: true,
          },
          ...(request.headers.get("X-Bunshin-Request-Id")
            ? {
                requestId: request.headers.get("X-Bunshin-Request-Id"),
              }
            : {}),
        },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
