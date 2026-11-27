import { serve } from "@hono/node-server";
import { createRuntimeApp, type RuntimeEnv } from "./app";

const runtimeEnv = process.env as RuntimeEnv & { PORT?: string },
  app = createRuntimeApp(runtimeEnv);

const port = Number(runtimeEnv.PORT ?? 8790);
serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(JSON.stringify({ level: "info", event: "runtime_started", port: listeningPort }));
});
