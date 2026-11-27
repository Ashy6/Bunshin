import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const secretsFile = resolve(root, ".deploy-secrets.json");

type Secrets = {
  MASTER_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  ADMIN_BOOTSTRAP_TOKEN: string;
  AI_RUNTIME_AUTH_SECRET: string;
  DEPLOY_HEALTH_TOKEN: string;
};

function run(command: string, args: string[], input?: string, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout}\n${result.stderr}`.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function validateSecrets(value: Secrets) {
  for (const [name, secretValue] of Object.entries(value)) {
    if (
      typeof secretValue !== "string" ||
      secretValue.length < 32 ||
      /\s/.test(secretValue)
    )
      throw new Error(
        `Stable production secret ${name} is malformed or too short. Refusing to deploy.`,
      );
  }
  if (Buffer.from(value.MASTER_ENCRYPTION_KEY, "base64").length !== 32)
    throw new Error(
      "MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes. Refusing to deploy.",
    );
}

function loadSecrets(): Secrets {
  const hasStableFile = existsSync(secretsFile),
    stored = hasStableFile
      ? JSON.parse(readFileSync(secretsFile, "utf8")) as Partial<Secrets>
      : {},
    firstDeploy = process.env.AI_BUNSHIN_FIRST_DEPLOY === "1",
    stable = (
      name: keyof Secrets,
      create: () => string,
      allowBackfill = false,
    ) => {
      const value = stored[name] ?? process.env[name];
      if (value) return value;
      if (
        !firstDeploy &&
        (!hasStableFile || !allowBackfill)
      )
        throw new Error(
          `Stable production secret ${name} is missing. Refusing to generate or rotate it. Restore .deploy-secrets.json, provide ${name} as an environment variable, or set AI_BUNSHIN_FIRST_DEPLOY=1 only for a brand-new deployment.`,
        );
      return create();
    };
  const value: Secrets = {
    MASTER_ENCRYPTION_KEY: stable(
      "MASTER_ENCRYPTION_KEY",
      () => randomBytes(32).toString("base64"),
    ),
    SESSION_SECRET: stable("SESSION_SECRET", () => secret(48)),
    ADMIN_BOOTSTRAP_TOKEN: stable("ADMIN_BOOTSTRAP_TOKEN", () => secret(32)),
    // These two fields were introduced after the original deployment and may
    // be safely added to an otherwise complete legacy secrets file.
    AI_RUNTIME_AUTH_SECRET: stable(
      "AI_RUNTIME_AUTH_SECRET",
      () => secret(48),
      true,
    ),
    DEPLOY_HEALTH_TOKEN: stable(
      "DEPLOY_HEALTH_TOKEN",
      () => secret(48),
      true,
    ),
  };
  validateSecrets(value);
  writeFileSync(secretsFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(secretsFile, 0o600);
  return value;
}

async function verifyHealth(url: string, token: string) {
  let detail = "no response";
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(url, {
          headers: { "X-Bunshin-Health-Token": token },
          signal: AbortSignal.timeout(10_000),
        }),
        body = await response.json() as {
          ok?: boolean;
          runtime?: { configured?: boolean; reachable?: boolean; failureCode?: string | null };
        };
      if (
        response.ok &&
        body.ok &&
        body.runtime?.configured &&
        body.runtime.reachable
      )
        return;
      detail = JSON.stringify(body);
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  throw new Error(`Deep health check failed for ${url}: ${detail}`);
}

async function main() {
const adminOrigin = (
    process.env.AI_BUNSHIN_ADMIN_ORIGIN ??
    "https://admin.twin-ai.online"
  ).replace(/\/$/, ""),
  webOrigin = (
    process.env.AI_BUNSHIN_WEB_ORIGIN ??
    "https://twin-ai.online"
  ).replace(/\/$/, "");
console.log("1/10 Checking Cloudflare authentication...");
run("pnpm", ["exec", "wrangler", "whoami"]);

console.log("2/10 Validating stable production secrets before any deployment...");
const secrets = loadSecrets();

console.log("3/10 Checking R2 access...");
const buckets = run("pnpm", ["exec", "wrangler", "r2", "bucket", "list"], undefined, true);
if (!buckets.includes("ai-bunshin-assets")) {
  throw new Error("R2 bucket ai-bunshin-assets is missing. Enable R2 in Cloudflare Dashboard, then create the bucket.");
}
console.log("4/10 Running quality gates...");
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("pnpm", ["build"]);

console.log("5/10 Deploying the private AI Runtime before any database or traffic change...");
run("pnpm", ["--filter", "@ai-bunshin/runtime", "run", "deploy"]);

console.log("6/10 Installing stable production secrets before traffic cutover...");
for (const [name, value] of Object.entries(secrets)) {
  const configs = name === "MASTER_ENCRYPTION_KEY"
    ? ["apps/web/wrangler.jsonc", "apps/admin/wrangler.jsonc"]
    : name === "AI_RUNTIME_AUTH_SECRET"
      ? [
          "apps/runtime/wrangler.jsonc",
          "apps/web/wrangler.jsonc",
          "apps/admin/wrangler.jsonc",
        ]
      : name === "DEPLOY_HEALTH_TOKEN"
        ? ["apps/web/wrangler.jsonc", "apps/admin/wrangler.jsonc"]
      : ["apps/admin/wrangler.jsonc"];
  for (const config of configs) {
    run("pnpm", ["exec", "wrangler", "secret", "put", name, "--config", config], `${value}\n`);
  }
}
if (process.env.CF_AIG_TOKEN) {
  for (const config of ["apps/web/wrangler.jsonc", "apps/admin/wrangler.jsonc"]) {
    run("pnpm", ["exec", "wrangler", "secret", "put", "CF_AIG_TOKEN", "--config", config], `${process.env.CF_AIG_TOKEN}\n`);
  }
}
if (process.env.PASSWORD_RESET_FROM_EMAIL) {
  run("pnpm", ["exec", "wrangler", "secret", "put", "PASSWORD_RESET_FROM_EMAIL", "--config", "apps/admin/wrangler.jsonc"], `${process.env.PASSWORD_RESET_FROM_EMAIL}\n`);
}

console.log("7/10 Applying remote D1 migrations after Runtime deployment succeeded...");
run("pnpm", ["db:migrate:remote"]);

console.log("8/10 Deploying Admin first and verifying its signed Runtime path...");
run("pnpm", ["--filter", "@ai-bunshin/admin", "run", "deploy"]);
await verifyHealth(
  `${adminOrigin}/api/admin/health?deep=1`,
  secrets.DEPLOY_HEALTH_TOKEN,
);

console.log("9/10 Deploying Web only after the Admin canary passed...");
run("pnpm", ["--filter", "@ai-bunshin/web", "run", "deploy"]);
await verifyHealth(
  `${webOrigin}/health?deep=1`,
  secrets.DEPLOY_HEALTH_TOKEN,
);

console.log("10/10 Verifying production deployments...");
run("pnpm", ["exec", "wrangler", "deployments", "list", "--name", "ai-bunshin-runtime"], undefined, true);
run("pnpm", ["exec", "wrangler", "deployments", "list", "--name", "ai-bunshin-web"], undefined, true);
run("pnpm", ["exec", "wrangler", "deployments", "list", "--name", "ai-bunshin-admin"], undefined, true);
console.log("Deployment complete.");
console.log(`Web:   ${webOrigin}`);
console.log(`Admin: ${adminOrigin}`);
console.log("Bootstrap and deployment secrets remain only in local .deploy-secrets.json (mode 0600).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
