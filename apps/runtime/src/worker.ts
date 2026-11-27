import { Container } from "@cloudflare/containers";

interface Env {
  AI_RUNTIME: DurableObjectNamespace<AiRuntimeContainer>;
  AI_RUNTIME_AUTH_SECRET: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CUSTOM_PROVIDER_API_KEY?: string;
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
        message: error instanceof Error ? error.message : "Unknown container error",
      }),
    );
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.AI_RUNTIME.getByName("ai-bunshin-runtime-singleton").fetch(request);
  },
} satisfies ExportedHandler<Env>;
