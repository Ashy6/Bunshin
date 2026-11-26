import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const secretsFile = resolve(root, ".deploy-secrets.json");

type Secrets = {
  MASTER_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  ADMIN_BOOTSTRAP_TOKEN: string;
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

function loadSecrets(): Secrets {
  if (existsSync(secretsFile)) return JSON.parse(readFileSync(secretsFile, "utf8")) as Secrets;
  const value = {
    MASTER_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SESSION_SECRET: secret(48),
    ADMIN_BOOTSTRAP_TOKEN: secret(32),
  };
  writeFileSync(secretsFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
}

console.log("1/7 Checking Cloudflare authentication...");
run("pnpm", ["exec", "wrangler", "whoami"]);

console.log("2/7 Checking that R2 is enabled and the production bucket exists...");
const buckets = run("pnpm", ["exec", "wrangler", "r2", "bucket", "list"], undefined, true);
if (!buckets.includes("ai-bunshin-assets")) {
  throw new Error("R2 bucket ai-bunshin-assets is missing. Enable R2 in Cloudflare Dashboard, then create the bucket.");
}

console.log("3/7 Running quality gates...");
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("pnpm", ["build"]);

console.log("4/7 Applying remote D1 migrations...");
run("pnpm", ["db:migrate:remote"]);

console.log("5/7 Deploying both Workers...");
run("pnpm", ["--filter", "@ai-bunshin/web", "deploy"]);
run("pnpm", ["--filter", "@ai-bunshin/admin", "deploy"]);

console.log("6/7 Installing stable production secrets...");
const secrets = loadSecrets();
for (const [name, value] of Object.entries(secrets)) {
  const configs = name === "MASTER_ENCRYPTION_KEY"
    ? ["apps/web/wrangler.jsonc", "apps/admin/wrangler.jsonc"]
    : ["apps/admin/wrangler.jsonc"];
  for (const config of configs) {
    run("pnpm", ["exec", "wrangler", "secret", "put", name, "--config", config], `${value}\n`);
  }
}

console.log("7/7 Verifying production health...");
for (const url of [
  "https://ai-bunshin-web.zengjx1998.workers.dev/health",
  "https://ai-bunshin-admin.zengjx1998.workers.dev/api/admin/health",
]) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Health check failed: ${url} returned ${response.status}`);
}
console.log("Deployment complete.");
console.log("Web:   https://ai-bunshin-web.zengjx1998.workers.dev");
console.log("Admin: https://ai-bunshin-admin.zengjx1998.workers.dev");
console.log(`First-run admin token: ${secrets.ADMIN_BOOTSTRAP_TOKEN}`);
console.log("The token is also stored locally in .deploy-secrets.json; never commit that file.");
