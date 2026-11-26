import { Hono } from "hono";
import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from "@ai-bunshin/crypto";
import { createEmbedding, testChatConnection } from "@ai-bunshin/ai";
import { bm25Search, chunkText, cosineSimilarity, createLocalEmbedding, reciprocalRankFusion, rerankHybrid } from "@ai-bunshin/rag";
import { extractText, getDocumentProxy } from "unpdf";
import {
  articleSchema,
  agentSettingsSchema,
  categorySchema,
  providerSchema,
  profileSchema,
  simpleProviderSchema,
  systemSettingsSchema,
} from "@ai-bunshin/validation";
import {
  clearSessionCookie,
  hashPassword,
  randomToken,
  readCookie,
  sessionCookie,
  sha256,
  verifyPassword,
} from "./auth";

type Env = {
  DB: D1Database;
  ASSETS_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  INGESTION_QUEUE: Queue;
  ASSETS: Fetcher;
  MASTER_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  ADMIN_BOOTSTRAP_TOKEN: string;
};
type Job = {
  type: "ingest";
  documentId: string;
  r2Key: string;
  mimeType: string;
};
const app = new Hono<{ Bindings: Env }>();
const providerPresets = {
  openai: {
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-5.4-mini",
    embeddingModel: "text-embedding-3-small",
    embeddingMode: "provider",
    inputPriceMicros: 750_000,
    outputPriceMicros: 4_500_000,
  },
  deepseek: {
    name: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    chatModel: "deepseek-flash",
    embeddingModel: "local-hash-v1",
    embeddingMode: "local",
    inputPriceMicros: 300_000,
    outputPriceMicros: 1_200_000,
  },
  openrouter: {
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    chatModel: "openai/gpt-5.4-mini",
    embeddingModel: "local-hash-v1",
    embeddingMode: "local",
    inputPriceMicros: 0,
    outputPriceMicros: 0,
  },
  custom: {
    name: "自定义兼容渠道",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-5.4-mini",
    embeddingModel: "local-hash-v1",
    embeddingMode: "local",
    inputPriceMicros: 0,
    outputPriceMicros: 0,
  },
} as const;
const defaultAgentConfig = {
  enabled: true,
  dailyLimit: 25,
  minuteLimit: 5,
  globalDailyLimit: 500,
  welcomeMessage:
    "你好，我是站长的个人分身。你可以问我有关经历、项目和文章的问题。",
  systemInstruction: "请简洁、准确地依据知识库回答。",
};
const defaultSystemConfig = {
  publicOrigin: "",
  defaultSeoDescription: "个人简历、文章与 AI 分身",
  seoKeywords: ["个人简历", "AI 分身", "RAG"],
  llmsFullEnabled: false,
  cacheTtlSeconds: 300,
};
function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function parseSystemConfig(value?: string | null) {
  try {
    return value
      ? { ...defaultSystemConfig, ...JSON.parse(value) }
      : defaultSystemConfig;
  } catch {
    return defaultSystemConfig;
  }
}
async function recordAdminTelemetry(env:Env,event:{eventType:string;severity?:"info"|"warning"|"error"|"critical";route?:string;scenario?:string;durationMs?:number;statusCode?:number;traceId?:string;detail?:Record<string,unknown>}){const traceId=event.traceId??crypto.randomUUID();try{await env.DB.prepare("INSERT INTO observability_events (id,service,event_type,severity,route,scenario,duration_ms,status_code,trace_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),"admin",event.eventType,event.severity??"info",event.route??null,event.scenario??null,event.durationMs??0,event.statusCode??0,traceId,JSON.stringify(event.detail??{}),new Date().toISOString()).run()}catch(error){console.error("telemetry_write_failed",error)}return traceId}
function providerErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "模型连接测试失败";
  if (message.includes("model.request") || message.includes("Missing scopes"))
    return "API Key 可以被识别，但缺少模型调用权限（model.request）。请在对应 OpenAI Project 的 API Keys 页面将该 Key 改为 All，或在 Restricted 权限中开启模型请求；同时确认当前账号属于该 Project（Member 或 Owner）。";
  if (message.includes("returned 401") || message.includes("返回 401"))
    return "API Key 无效或权限不足。请确认 Key 属于当前项目、尚未过期，并具有模型调用权限。";
  if (message.includes("returned 429") || message.includes("返回 429"))
    return "模型渠道返回 429：可能是余额不足、预算限制或请求频率过高，请检查厂商账单与限额。";
  if (message.includes("returned 404") || message.includes("返回 404"))
    return "模型不可用或当前项目没有该模型权限，请检查项目的 Model usage 设置。";
  return message;
}
function avatarSvg(displayName: string | null | undefined) {
  const first = Array.from(displayName?.trim() || "B")[0] ?? "B";
  const safe = first
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#31516f"/><stop offset="1" stop-color="#7899b5"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="64" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="44" font-weight="700" fill="white">${safe}</text></svg>`;
}
async function removeDocumentIndex(env: Env, documentId: string) {
  const vectorRows = (
    await env.DB.prepare(
      "SELECT COALESCE(vector_id,id) id FROM chunks WHERE document_id=?",
    )
      .bind(documentId)
      .all<{ id: string }>()
  ).results;
  if (vectorRows.length) {
    try {
      await env.VECTORIZE.deleteByIds(vectorRows.map((row) => row.id));
    } catch (error) {
      console.warn("Vector cleanup skipped", error);
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM local_vectors WHERE document_id=?").bind(documentId),
    env.DB.prepare("DELETE FROM chunks WHERE document_id=?").bind(documentId),
  ]);
}
async function audit(
  env: Env,
  request: Request,
  action: string,
  targetType: string,
  targetId?: string,
  detail: Record<string, unknown> = {},
) {
  const admin = await currentAdmin(request, env);
  await env.DB.prepare(
    "INSERT INTO audit_events (id,admin_id,action,target_type,target_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      admin?.id ?? null,
      action,
      targetType,
      targetId ?? null,
      JSON.stringify(detail),
      new Date().toISOString(),
    )
    .run();
}
function articleMarkdown(article: {
  title: string;
  excerpt: string;
  body: string;
}) {
  return `# ${article.title}\n\n${article.excerpt}\n\n${article.body}`;
}
async function syncArticleDocument(
  env: Env,
  article: {
    id: string;
    title: string;
    slug: string;
    excerpt: string;
    body: string;
    status: string;
    includeInRag: boolean;
    documentId?: string | null;
  },
) {
  const now = new Date().toISOString();
  if (article.status !== "published" || !article.includeInRag) {
    if (article.documentId) {
      await removeDocumentIndex(env, article.documentId);
      await env.DB.prepare(
        "UPDATE documents SET visibility='private',status='archived',archived_at=?,updated_at=? WHERE id=?",
      )
        .bind(now, now, article.documentId)
        .run();
    }
    return article.documentId ?? null;
  }
  const documentId = article.documentId ?? `article-${article.id}`,
    key = `generated/articles/${article.id}.md`;
  await env.ASSETS_BUCKET.put(key, articleMarkdown(article), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  await env.DB.prepare(
    "INSERT INTO documents (id,title,source_type,visibility,status,r2_key,purpose,original_name,file_size,source_url,created_at,updated_at) VALUES (?,?,?,'public','uploaded',?,'article',?,?,?, ?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,visibility='public',status='uploaded',r2_key=excluded.r2_key,source_url=excluded.source_url,archived_at=NULL,error_message=NULL,updated_at=excluded.updated_at",
  )
    .bind(
      documentId,
      article.title,
      "markdown",
      key,
      `${article.slug}.md`,
      articleMarkdown(article).length,
      `/articles/${article.slug}`,
      now,
      now,
    )
    .run();
  await env.INGESTION_QUEUE.send({
    type: "ingest",
    documentId,
    r2Key: key,
    mimeType: "text/markdown",
  } satisfies Job);
  return documentId;
}
function slugFrom(value: string) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
  return slug || `article-${Date.now()}`;
}
async function uniqueArticleSlug(env: Env, preferred: string, excludeId?: string) {
  const base = slugFrom(preferred);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const value = suffix ? `${base}-${suffix + 1}` : base;
    const existing = await env.DB.prepare(
      "SELECT id FROM articles WHERE slug=? AND (? IS NULL OR id!=?) LIMIT 1",
    ).bind(value, excludeId ?? null, excludeId ?? null).first();
    if (!existing) return value;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}
function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(h[1-6]|p|div|section|article|li|blockquote|pre|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function parseMarkdownImport(raw: string, fallbackTitle: string) {
  let body = raw.replace(/^\uFEFF/, "").trim(), metadata: Record<string, string> = {};
  const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(body);
  if (frontmatter) {
    for (const line of frontmatter[1]!.split("\n")) {
      const match = /^([a-zA-Z0-9_-]+):\s*["']?(.*?)["']?\s*$/.exec(line);
      if (match) metadata[match[1]!.toLowerCase()] = match[2]!.trim();
    }
    body = body.slice(frontmatter[0].length).trim();
  }
  const heading = /^#\s+(.+)$/m.exec(body);
  const title = metadata.title || heading?.[1]?.trim() || fallbackTitle;
  if (heading && heading.index === 0) body = body.slice(heading[0].length).trim();
  const plain = body.replace(/[#>*_`\[\]()!-]/g, " ").replace(/\s+/g, " ").trim();
  return {
    title,
    body: body || raw.trim(),
    excerpt: metadata.description || plain.slice(0, 180),
    preferredSlug: metadata.slug || title,
    tags: (metadata.tags || "").split(",").map((item) => item.trim()).filter(Boolean),
  };
}
async function extractImportedFile(file: File) {
  const fallbackTitle = file.name.replace(/\.[^.]+$/, "");
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(bytes, { maxImageSize: 16_777_216 });
    if (pdf.numPages > 100) throw new Error("PDF 页数不能超过 100 页");
    const extracted = await extractText(pdf, { mergePages: true });
    const text = String(extracted.text).trim();
    if (text.length < 40)
      return { title: fallbackTitle, body: "", excerpt: "", preferredSlug: fallbackTitle, tags: [] as string[], needsOcr: true };
    return { ...parseMarkdownImport(text, fallbackTitle), needsOcr: false };
  }
  return { ...parseMarkdownImport(await file.text(), fallbackTitle), needsOcr: false };
}
function validateImportUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("只允许导入 HTTPS 地址");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1"
  ) throw new Error("不允许导入本地或私有网络地址");
  return url;
}
async function saveArticleVersion(env: Env, articleId: string) {
  const article = await env.DB.prepare("SELECT * FROM articles WHERE id=?")
    .bind(articleId).first<Record<string, unknown>>();
  if (!article) return;
  await env.DB.prepare(
    "INSERT INTO article_versions (id,article_id,snapshot_json,created_at) VALUES (?,?,?,?)",
  ).bind(crypto.randomUUID(), articleId, JSON.stringify(article), new Date().toISOString()).run();
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function outputTextFromResponse(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .filter((item: any) => item?.type === "output_text")
    .map((item: any) => item?.text ?? "")
    .join("\n")
    .trim();
}
app.onError((error, c) => {
  console.error("Unhandled admin API error", error);
  return c.json(
    { error: "服务器处理失败，请稍后重试", code: "INTERNAL_ERROR" },
    500,
  );
});
app.use("/api/*", async (c, next) => {
  const started=Date.now(),traceId=c.req.header("cf-ray")??crypto.randomUUID();
  await next();
  const durationMs=Date.now()-started,statusCode=c.res.status;
  c.executionCtx.waitUntil(recordAdminTelemetry(c.env,{eventType:"http_request",severity:statusCode>=500?"error":statusCode>=400?"warning":"info",route:c.req.path,durationMs,statusCode,traceId,detail:{method:c.req.method}}));
  c.header("X-Trace-Id",traceId);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
});
app.get("/api/admin/health", (c) => c.json({ ok: true, service: "admin" }));
app.get("/api/admin/auth/status", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) count FROM admin_users",
  ).first<{ count: number }>();
  return c.json({ initialized: (row?.count ?? 0) > 0 });
});
app.post("/api/admin/auth/bootstrap", async (c) => {
  const body = await c.req
    .json<{ email?: string; password?: string; token?: string }>()
    .catch(() => ({}) as { email?: string; password?: string; token?: string });
  const hostname = new URL(c.req.url).hostname,
    isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isLocal && body.token !== c.env.ADMIN_BOOTSTRAP_TOKEN)
    return c.json({ error: "初始化令牌无效" }, 403);
  if (!body.email || !body.password || body.password.length < 12)
    return c.json({ error: "邮箱或密码不符合要求，密码至少 12 位" }, 400);
  const existing = await c.env.DB.prepare(
    "SELECT COUNT(*) count FROM admin_users",
  ).first<{ count: number }>();
  if ((existing?.count ?? 0) > 0)
    return c.json({ error: "管理员已经初始化" }, 409);
  const now = new Date().toISOString(),
    id = crypto.randomUUID(),
    passwordHash = await hashPassword(body.password);
  await c.env.DB.prepare(
    "INSERT INTO admin_users (id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)",
  )
    .bind(id, body.email.toLowerCase(), passwordHash, now, now)
    .run();
  return c.json({ ok: true }, 201);
});
app.post("/api/admin/auth/login", async (c) => {
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({}) as { email?: string; password?: string });
  if (!body.email || !body.password)
    return c.json({ error: "请输入邮箱和密码" }, 400);
  const admin = await c.env.DB.prepare(
    "SELECT id,email,password_hash FROM admin_users WHERE email=? LIMIT 1",
  )
    .bind(body.email.toLowerCase())
    .first<{ id: string; email: string; password_hash: string }>();
  if (!admin || !(await verifyPassword(body.password, admin.password_hash)))
    return c.json({ error: "邮箱或密码错误" }, 401);
  const token = randomToken(),
    tokenHash = await sha256(token),
    now = new Date(),
    expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await c.env.DB.prepare(
    "INSERT INTO sessions (id,admin_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      admin.id,
      tokenHash,
      expires.toISOString(),
      now.toISOString(),
    )
    .run();
  c.header(
    "Set-Cookie",
    sessionCookie(token, new URL(c.req.url).protocol === "https:"),
  );
  return c.json({ admin: { id: admin.id, email: admin.email } });
});
app.get("/api/admin/auth/session", async (c) => {
  const admin = await currentAdmin(c.req.raw, c.env);
  return admin ? c.json({ admin }) : c.json({ admin: null }, 401);
});
app.post("/api/admin/auth/logout", async (c) => {
  const token = readCookie(c.req.header("Cookie") ?? null, "bunshin_session");
  if (token)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await sha256(token))
      .run();
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});
app.use("/api/admin/*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/admin/auth/") ||
    c.req.path === "/api/admin/health"
  )
    return next();
  const admin = await currentAdmin(c.req.raw, c.env);
  if (!admin) return c.json({ error: "请先登录" }, 401);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin"),
      expected = new URL(c.req.url).origin;
    if (origin && origin !== expected)
      return c.json({ error: "请求来源校验失败" }, 403);
  }
  await next();
});
app.get("/api/admin/analytics/overview", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) requests, COALESCE(SUM(input_tokens+output_tokens+cached_tokens),0) tokens, COALESCE(SUM(cost_micros),0) cost FROM usage_events WHERE created_at >= datetime('now','start of month')",
  ).first();
  return c.json(row ?? { requests: 0, tokens: 0, cost: 0 });
});
app.get("/api/admin/analytics/trends", async (c) => {
  const days = boundedInteger(c.req.query("days"), 7, 1, 90),
    modifier = `-${days - 1} days`;
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT substr(created_at,1,10) day,COUNT(*) requests,COALESCE(SUM(input_tokens+output_tokens+cached_tokens),0) tokens,COALESCE(SUM(cost_micros),0) cost_micros FROM usage_events WHERE created_at>=datetime('now',?,'start of day') GROUP BY substr(created_at,1,10) ORDER BY day",
      ).bind(modifier).all()
    ).results,
  });
});
app.get("/api/admin/analytics/dashboard", async (c) => {
  const days = boundedInteger(c.req.query("days"), 7, 1, 90),
    modifier = `-${days - 1} days`,
    [summary, trends, providerShare, documentStats, recentDocuments] =
      await Promise.all([
        c.env.DB.prepare(
          "SELECT COUNT(*) requests,COALESCE(SUM(input_tokens+output_tokens+cached_tokens),0) tokens,COALESCE(SUM(cost_micros),0) cost_micros,COALESCE(AVG(latency_ms),0) avg_latency_ms,COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0),0) success_rate FROM usage_events WHERE created_at>=datetime('now',?,'start of day')",
        ).bind(modifier).first(),
        c.env.DB.prepare(
          "SELECT substr(created_at,1,10) day,COUNT(*) requests,COALESCE(SUM(input_tokens+output_tokens+cached_tokens),0) tokens FROM usage_events WHERE created_at>=datetime('now',?,'start of day') GROUP BY substr(created_at,1,10) ORDER BY day",
        ).bind(modifier).all(),
        c.env.DB.prepare(
          "SELECT COALESCE(providers.name,usage_events.model,'未知渠道') name,COUNT(*) requests,COALESCE(SUM(usage_events.input_tokens+usage_events.output_tokens+usage_events.cached_tokens),0) tokens,COALESCE(SUM(usage_events.cost_micros),0) cost_micros FROM usage_events LEFT JOIN providers ON providers.id=usage_events.provider_id WHERE usage_events.created_at>=datetime('now',?,'start of day') GROUP BY COALESCE(providers.name,usage_events.model,'未知渠道') ORDER BY cost_micros DESC,requests DESC",
        ).bind(modifier).all(),
        c.env.DB.prepare(
          "SELECT COUNT(*) total,SUM(CASE WHEN status='indexed' THEN 1 ELSE 0 END) ready,SUM(CASE WHEN status IN ('uploaded','parsing','embedding') THEN 1 ELSE 0 END) processing,SUM(CASE WHEN status IN ('failed','needs_ocr') THEN 1 ELSE 0 END) failed FROM documents",
        ).first(),
        c.env.DB.prepare(
          "SELECT documents.id,documents.title,documents.source_type,documents.status,documents.chunk_count,documents.ingestion_progress,documents.updated_at,categories.name category_name FROM documents LEFT JOIN categories ON categories.id=documents.category_id ORDER BY documents.updated_at DESC LIMIT 6",
        ).all(),
      ]);
  return c.json({
    days,
    summary: summary ?? {
      requests: 0,
      tokens: 0,
      cost_micros: 0,
      avg_latency_ms: 0,
      success_rate: 0,
    },
    trends: trends.results,
    providerShare: providerShare.results,
    documents: documentStats ?? { total: 0, ready: 0, processing: 0, failed: 0 },
    recentDocuments: recentDocuments.results,
  });
});
app.get("/api/admin/usage", async (c) => {
  const days = boundedInteger(c.req.query("days"), 30, 1, 365),
    page = boundedInteger(c.req.query("page"), 1, 1, 100000),
    pageSize = boundedInteger(c.req.query("pageSize"), 20, 10, 100),
    providerId = (c.req.query("providerId") ?? "").trim(),
    scenario = (c.req.query("scenario") ?? "").trim(),
    status = (c.req.query("status") ?? "").trim(),
    where = ["usage_events.created_at>=datetime('now',?,'start of day')"],
    params: Array<string | number> = [`-${days - 1} days`];
  if (providerId) {
    where.push("usage_events.provider_id=?");
    params.push(providerId);
  }
  if (scenario) {
    where.push("usage_events.scenario=?");
    params.push(scenario);
  }
  if (status) {
    where.push("usage_events.status=?");
    params.push(status);
  }
  const clause = where.join(" AND "),
    [items, total, summary, providers, scenarios] = await Promise.all([
      c.env.DB.prepare(
        `SELECT usage_events.id,usage_events.scenario,usage_events.model,usage_events.input_tokens,usage_events.output_tokens,usage_events.cached_tokens,usage_events.cost_micros,usage_events.currency,usage_events.latency_ms,usage_events.status,usage_events.estimated,usage_events.trace_id,usage_events.created_at,providers.name provider_name FROM usage_events LEFT JOIN providers ON providers.id=usage_events.provider_id WHERE ${clause} ORDER BY usage_events.created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...params, pageSize, (page - 1) * pageSize).all(),
      c.env.DB.prepare(
        `SELECT COUNT(*) count FROM usage_events WHERE ${clause}`,
      ).bind(...params).first<{ count: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) requests,COALESCE(SUM(input_tokens+output_tokens+cached_tokens),0) tokens,COALESCE(SUM(cost_micros),0) cost_micros,COALESCE(AVG(latency_ms),0) avg_latency_ms,COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0),0) success_rate FROM usage_events WHERE ${clause}`,
      ).bind(...params).first(),
      c.env.DB.prepare(
        "SELECT id,name,chat_model,embedding_model FROM providers ORDER BY is_default DESC,name",
      ).all(),
      c.env.DB.prepare(
        "SELECT DISTINCT scenario FROM usage_events ORDER BY scenario",
      ).all(),
    ]);
  return c.json({
    items: items.results,
    total: total?.count ?? 0,
    page,
    pageSize,
    days,
    summary: summary ?? {
      requests: 0,
      tokens: 0,
      cost_micros: 0,
      avg_latency_ms: 0,
      success_rate: 0,
    },
    providers: providers.results,
    scenarios: scenarios.results,
  });
});
app.get("/api/admin/settings", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT value,updated_at FROM settings WHERE key='system_config'",
  ).first<{ value: string; updated_at: string }>();
  return c.json({
    config: parseSystemConfig(row?.value),
    updatedAt: row?.updated_at ?? null,
  });
});
app.put("/api/admin/settings", async (c) => {
  const parsed = systemSettingsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success)
    return c.json({ error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES ('system_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(JSON.stringify(parsed.data), now),
    c.env.DB.prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES ('llms_full_enabled',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(String(parsed.data.llmsFullEnabled), now),
  ]);
  await audit(c.env, c.req.raw, "settings.update", "system", "system_config", {
    publicOrigin: parsed.data.publicOrigin,
    llmsFullEnabled: parsed.data.llmsFullEnabled,
    cacheTtlSeconds: parsed.data.cacheTtlSeconds,
  });
  return c.json({ config: parsed.data, updatedAt: now });
});
app.post("/api/admin/maintenance/repair-document-metadata", async (c) => {
  const result = await repairDocumentMetadata(c.env);
  await audit(c.env, c.req.raw, "documents.repair_metadata", "document", undefined, result);
  return c.json(result);
});
app.get("/api/admin/observability", async (c) => {
  const hours=boundedInteger(c.req.query("hours"),24,1,168),modifier=`-${hours} hours`;
  await evaluateOperationalAlerts(c.env);
  const [requests,usage,rag,queue,alerts,events,budgets,stuck]=await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN severity IN ('error','critical') OR status_code>=500 THEN 1 ELSE 0 END) errors,COALESCE(AVG(duration_ms),0) avg_duration_ms,SUM(CASE WHEN duration_ms>=12000 THEN 1 ELSE 0 END) slow FROM observability_events WHERE created_at>=datetime('now',?)").bind(modifier).first(),
    c.env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) errors,COALESCE(AVG(latency_ms),0) avg_latency_ms,COALESCE(SUM(cost_micros),0) cost_micros FROM usage_events WHERE created_at>=datetime('now',?)").bind(modifier).first(),
    c.env.DB.prepare("SELECT COUNT(*) queries,COALESCE(AVG(retrieval_ms),0) avg_retrieval_ms,SUM(CASE WHEN answer_status='no_match' THEN 1 ELSE 0 END) no_match,COALESCE(AVG(top_score),0) avg_top_score FROM rag_query_events WHERE created_at>=datetime('now',?)").bind(modifier).first(),
    c.env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing,SUM(CASE WHEN status IN ('retrying','dead_letter_risk') THEN 1 ELSE 0 END) retrying,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM queue_job_runs WHERE heartbeat_at>=datetime('now',?)").bind(modifier).first(),
    c.env.DB.prepare("SELECT * FROM operational_alerts WHERE status!='resolved' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,last_seen_at DESC LIMIT 100").all(),
    c.env.DB.prepare("SELECT * FROM observability_events WHERE created_at>=datetime('now',?) ORDER BY created_at DESC LIMIT 100").bind(modifier).all(),
    c.env.DB.prepare("SELECT providers.id,providers.name,providers.monthly_budget_micros,COALESCE(SUM(usage_events.cost_micros),0) spent_micros FROM providers LEFT JOIN usage_events ON usage_events.provider_id=providers.id AND usage_events.created_at>=datetime('now','start of month') GROUP BY providers.id ORDER BY providers.is_default DESC,providers.name").all(),
    c.env.DB.prepare("SELECT id,title,status,ingestion_progress,updated_at FROM documents WHERE status IN ('parsing','embedding') AND updated_at<datetime('now','-15 minutes') ORDER BY updated_at").all(),
  ]);
  return c.json({hours,requests:requests??{},usage:usage??{},rag:rag??{},queue:queue??{},alerts:alerts.results,events:events.results,budgets:budgets.results,stuck:stuck.results});
});
app.post("/api/admin/observability/alerts/:id/ack", async (c) => {
  await c.env.DB.prepare("UPDATE operational_alerts SET status='acknowledged',acknowledged_at=? WHERE id=? AND status='open'").bind(new Date().toISOString(),c.req.param("id")).run();
  await audit(c.env,c.req.raw,"alert.acknowledge","operational_alert",c.req.param("id"));
  return c.json({ok:true});
});
app.get("/api/admin/agent", async (c) => {
  const [setting, provider, documents, today] = await Promise.all([
    c.env.DB.prepare(
      "SELECT value FROM settings WHERE key='agent_config'",
    ).first<{
      value: string;
    }>(),
    c.env.DB.prepare(
      "SELECT id,name,chat_model,embedding_model,embedding_mode,health_status,last_checked_at,last_error,monthly_budget_micros,(SELECT COALESCE(SUM(cost_micros),0) FROM usage_events WHERE provider_id=providers.id AND created_at>=datetime('now','start of month')) month_spent_micros FROM providers WHERE enabled=1 AND is_default=1 LIMIT 1",
    ).first(),
    c.env.DB.prepare(
      "SELECT COUNT(*) total,SUM(CASE WHEN status='indexed' AND visibility!='private' THEN 1 ELSE 0 END) ready,SUM(CASE WHEN status IN ('uploaded','parsing','embedding') THEN 1 ELSE 0 END) processing,SUM(CASE WHEN status IN ('failed','needs_ocr') THEN 1 ELSE 0 END) failed FROM documents",
    ).first(),
    c.env.DB.prepare(
      "SELECT COUNT(*) requests,COALESCE(SUM(input_tokens+output_tokens),0) tokens,COALESCE(SUM(cost_micros),0) cost_micros FROM usage_events WHERE scenario='chat' AND status='success' AND created_at>=datetime('now','start of day')",
    ).first(),
  ]);
  const config = setting?.value
    ? { ...defaultAgentConfig, ...JSON.parse(setting.value) }
    : defaultAgentConfig;
  return c.json({
    config,
    provider: provider ?? null,
    documents: documents ?? { total: 0, ready: 0, processing: 0, failed: 0 },
    today: today ?? { requests: 0, tokens: 0, cost_micros: 0 },
    ready: Boolean(
      config.enabled &&
        provider &&
        (provider as { health_status?: string }).health_status === "healthy" &&
        (Number(
          (provider as { monthly_budget_micros?: number })
            .monthly_budget_micros ?? 0,
        ) === 0 ||
          Number(
            (provider as { month_spent_micros?: number }).month_spent_micros ??
              0,
          ) <
            Number(
              (provider as { monthly_budget_micros?: number })
                .monthly_budget_micros ?? 0,
            )) &&
        Number((documents as { ready?: number } | null)?.ready ?? 0) > 0,
    ),
  });
});
app.put("/api/admin/agent", async (c) => {
  const parsed = agentSettingsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  await c.env.DB.prepare(
    "INSERT INTO settings (key,value,updated_at) VALUES ('agent_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind(JSON.stringify(parsed.data), new Date().toISOString())
    .run();
  return c.json({ config: parsed.data });
});
app.get("/api/admin/profile", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id,display_name,headline,bio,location,avatar_url,social_json,published,rag_enabled,website_url,public_email,markdown_bio,skills_json,resume_document_id,experience_json,project_json,education_json,avatar_position_x,avatar_position_y,updated_at FROM profiles ORDER BY created_at LIMIT 1",
  ).first();
  return c.json({ profile: row ?? null });
});
app.get("/api/admin/profile/versions", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT id FROM profiles ORDER BY created_at LIMIT 1",
  ).first<{ id: string }>();
  if (!profile) return c.json({ items: [] });
  const items = (
    await c.env.DB.prepare(
      "SELECT id,snapshot_json,created_at FROM profile_versions WHERE profile_id=? ORDER BY created_at DESC LIMIT 30",
    )
      .bind(profile.id)
      .all()
  ).results;
  return c.json({ items });
});
app.put("/api/admin/profile", async (c) => {
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const p = parsed.data,
    now = new Date().toISOString(),
    existing = await c.env.DB.prepare(
      "SELECT * FROM profiles ORDER BY created_at LIMIT 1",
    ).first<Record<string, unknown> & { id: string }>(),
    id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await c.env.DB.prepare(
      "INSERT INTO profile_versions (id,profile_id,snapshot_json,created_at) VALUES (?,?,?,?)",
    )
      .bind(crypto.randomUUID(), id, JSON.stringify(existing), now)
      .run();
    await c.env.DB.prepare(
      "UPDATE profiles SET display_name=?,headline=?,bio=?,location=?,social_json=?,published=?,rag_enabled=?,website_url=?,public_email=?,markdown_bio=?,skills_json=?,experience_json=?,project_json=?,education_json=?,avatar_position_x=?,avatar_position_y=?,updated_at=? WHERE id=?",
    )
      .bind(
        p.displayName,
        p.headline,
        p.bio,
        p.location,
        JSON.stringify(p.social),
        p.published ? 1 : 0,
        p.ragEnabled ? 1 : 0,
        p.websiteUrl || null,
        p.publicEmail || null,
        p.markdownBio,
        JSON.stringify(p.skills),
        JSON.stringify(p.experiences),
        JSON.stringify(p.projects),
        JSON.stringify(p.education),
        p.avatarPositionX,
        p.avatarPositionY,
        now,
        id,
      )
      .run();
  } else
    await c.env.DB.prepare(
      "INSERT INTO profiles (id,display_name,headline,bio,location,social_json,published,rag_enabled,website_url,public_email,markdown_bio,skills_json,experience_json,project_json,education_json,avatar_position_x,avatar_position_y,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        p.displayName,
        p.headline,
        p.bio,
        p.location,
        JSON.stringify(p.social),
        p.published ? 1 : 0,
        p.ragEnabled ? 1 : 0,
        p.websiteUrl || null,
        p.publicEmail || null,
        p.markdownBio,
        JSON.stringify(p.skills),
        JSON.stringify(p.experiences),
        JSON.stringify(p.projects),
        JSON.stringify(p.education),
        p.avatarPositionX,
        p.avatarPositionY,
        now,
        now,
      )
      .run();
  const profileDocumentId = "generated-profile",
    profileKey = "generated/profile.md",
    socialLines = Object.entries(p.social)
      .filter(([, value]) => value)
      .map(([label, value]) => `- ${label}: ${value}`)
      .join("\n"),
    experienceLines = p.experiences
      .map((item) => `### ${item.title} · ${item.organization}\n${item.period}\n\n${item.summary}`)
      .join("\n\n"),
    projectLines = p.projects
      .map((item) => `### ${item.name}${item.role ? ` · ${item.role}` : ""}\n${item.summary}${item.url ? `\n${item.url}` : ""}`)
      .join("\n\n"),
    educationLines = p.education
      .map((item) => `### ${item.school}${item.degree ? ` · ${item.degree}` : ""}\n${item.period}\n\n${item.summary}`)
      .join("\n\n"),
    profileMarkdown = `# ${p.displayName}\n\n${p.headline}\n\n${p.bio}\n\n${p.location ? `所在地：${p.location}\n\n` : ""}${p.markdownBio}\n\n## 技能\n\n${p.skills.join("、")}\n\n${experienceLines ? `## 经历\n\n${experienceLines}\n\n` : ""}${projectLines ? `## 项目\n\n${projectLines}\n\n` : ""}${educationLines ? `## 教育\n\n${educationLines}\n\n` : ""}${socialLines ? `## 公开链接\n\n${socialLines}` : ""}`;
  if (p.ragEnabled) {
    await c.env.ASSETS_BUCKET.put(profileKey, profileMarkdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    await c.env.DB.prepare(
      "INSERT INTO documents (id,title,source_type,visibility,status,r2_key,purpose,original_name,file_size,created_at,updated_at) VALUES (?,?,?,'rag_only','uploaded',?,'profile','profile.md',?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,visibility='rag_only',status='uploaded',r2_key=excluded.r2_key,file_size=excluded.file_size,archived_at=NULL,error_message=NULL,updated_at=excluded.updated_at",
    )
      .bind(
        profileDocumentId,
        `${p.displayName}的个人资料`,
        "markdown",
        profileKey,
        profileMarkdown.length,
        now,
        now,
      )
      .run();
    await c.env.INGESTION_QUEUE.send({
      type: "ingest",
      documentId: profileDocumentId,
      r2Key: profileKey,
      mimeType: "text/markdown",
    } satisfies Job);
  } else {
    await removeDocumentIndex(c.env, profileDocumentId);
    await c.env.DB.prepare(
      "UPDATE documents SET visibility='private',status='archived',archived_at=?,updated_at=? WHERE id=?",
    )
      .bind(now, now, profileDocumentId)
      .run();
  }
  await audit(c.env, c.req.raw, "profile.update", "profile", id, {
    published: p.published,
    ragEnabled: p.ragEnabled,
  });
  return c.json({ id });
});
app.get("/api/admin/profile/avatar", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT display_name,avatar_url FROM profiles ORDER BY created_at LIMIT 1",
  ).first<{ display_name: string; avatar_url: string | null }>();
  if (profile?.avatar_url?.startsWith("r2://")) {
    const object = await c.env.ASSETS_BUCKET.get(profile.avatar_url.slice(5));
    if (object)
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
  }
  return new Response(avatarSvg(profile?.display_name), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.post("/api/admin/profile/avatar", async (c) => {
  const form = await c.req.formData(),
    file = form.get("file");
  const allowedTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);
  if (
    !(file instanceof File) ||
    !allowedTypes.has(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    return c.json(
      { error: "请选择 5MB 以内的 JPG、PNG、WebP 或 GIF 图片" },
      400,
    );
  let profile = await c.env.DB.prepare(
    "SELECT id,avatar_url FROM profiles ORDER BY created_at LIMIT 1",
  ).first<{ id: string; avatar_url: string | null }>();
  if (!profile) {
    const now = new Date().toISOString(), id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO profiles (id,display_name,headline,bio,social_json,published,rag_enabled,markdown_bio,skills_json,experience_json,project_json,education_json,created_at,updated_at) VALUES (?,'Bunshin','','','{}',0,1,'','[]','[]','[]','[]',?,?)",
    ).bind(id, now, now).run();
    profile = { id, avatar_url: null };
  }
  const extension =
      (
        {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
        } as Record<string, string>
      )[file.type] ?? "img",
    key = `profile/avatar-${crypto.randomUUID()}.${extension}`;
  await c.env.ASSETS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  await c.env.DB.prepare(
    "UPDATE profiles SET avatar_url=?,updated_at=? WHERE id=?",
  )
    .bind(`r2://${key}`, new Date().toISOString(), profile.id)
    .run();
  if (profile.avatar_url?.startsWith("r2://"))
    c.executionCtx.waitUntil(
      c.env.ASSETS_BUCKET.delete(profile.avatar_url.slice(5)),
    );
  return c.json({ key });
});
app.delete("/api/admin/profile/avatar", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT id,avatar_url FROM profiles ORDER BY created_at LIMIT 1",
  ).first<{ id: string; avatar_url: string | null }>();
  if (!profile) return c.json({ ok: true });
  await c.env.DB.prepare(
    "UPDATE profiles SET avatar_url=NULL,avatar_position_x=50,avatar_position_y=50,updated_at=? WHERE id=?",
  ).bind(new Date().toISOString(), profile.id).run();
  if (profile.avatar_url?.startsWith("r2://"))
    await c.env.ASSETS_BUCKET.delete(profile.avatar_url.slice(5));
  await audit(c.env, c.req.raw, "profile.avatar.delete", "profile", profile.id);
  return c.json({ ok: true });
});
app.get("/api/admin/provider-presets", (c) =>
  c.json({
    items: Object.entries(providerPresets).map(([id, value]) => ({
      id,
      ...value,
    })),
  }),
);
app.get("/api/admin/articles", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT articles.*,categories.name category_name,(SELECT COUNT(*) FROM article_versions WHERE article_id=articles.id) version_count FROM articles LEFT JOIN categories ON categories.id=articles.category_id ORDER BY articles.updated_at DESC LIMIT 200",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/categories", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT categories.id,categories.name,categories.slug,CASE WHEN categories.scope='both' THEN 'shared' ELSE categories.scope END scope,categories.description,categories.sort_order,categories.show_in_portal,(SELECT COUNT(*) FROM articles WHERE category_id=categories.id) article_count,(SELECT COUNT(*) FROM documents WHERE category_id=categories.id AND purpose='knowledge') document_count FROM categories ORDER BY sort_order,name",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/documents", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT documents.id,documents.title,documents.source_type,documents.category_id,documents.visibility,documents.status,documents.r2_key,documents.chunk_count,documents.error_message,documents.purpose,documents.original_name,documents.file_size,documents.source_url,documents.archived_at,documents.tags_json,documents.ingestion_progress,documents.ocr_status,documents.current_version,documents.created_at,documents.updated_at,categories.name category_name FROM documents LEFT JOIN categories ON categories.id=documents.category_id ORDER BY documents.updated_at DESC LIMIT 300",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/documents/:id/download", async (c) => {
  const document = await c.env.DB.prepare(
    "SELECT title,r2_key,source_type,original_name FROM documents WHERE id=? LIMIT 1",
  )
    .bind(c.req.param("id"))
    .first<{ title: string; r2_key: string | null; source_type: string; original_name: string | null }>();
  if (!document?.r2_key) return c.json({ error: "附件不存在" }, 404);
  const object = await c.env.ASSETS_BUCKET.get(document.r2_key);
  if (!object) return c.json({ error: "R2 中未找到原文件" }, 404);
  const storedName = document.original_name || document.r2_key.split("/").at(-1) ||
    `${document.title}.${document.source_type === "pdf" ? "pdf" : "md"}`;
  const fallbackName = storedName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(storedName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.get("/api/admin/providers", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,name,kind,base_url,key_preview,chat_model,embedding_model,embedding_mode,preset_id,monthly_budget_micros,enabled,is_default,health_status,last_checked_at,last_error,updated_at FROM providers ORDER BY updated_at DESC",
      ).all()
    ).results,
  }),
);
app.post("/api/admin/articles/import", async (c) => {
  const form = await c.req.formData(), files = form.getAll("files");
  if (!files.length || files.some((file) => !(file instanceof File)))
    return c.json({ error: "请选择要导入的 PDF、Markdown 或 TXT" }, 400);
  if (files.length > 10) return c.json({ error: "一次最多导入 10 个文件" }, 400);
  const categoryId = String(form.get("categoryId") || "") || null,
    results: Array<{ id: string; title: string; status: string }> = [];
  for (const entry of files) {
    const file = entry as File;
    if (file.size > 20 * 1024 * 1024) return c.json({ error: `${file.name} 超过 20MB` }, 413);
    const allowed = file.type === "application/pdf" || file.type === "text/markdown" ||
      file.type === "text/plain" || /\.(pdf|md|markdown|txt)$/i.test(file.name);
    if (!allowed) return c.json({ error: `${file.name} 的格式不受支持` }, 415);
    const id = crypto.randomUUID(), now = new Date().toISOString(),
      sourceKey = `article-sources/${id}/${encodeURIComponent(file.name).replaceAll("%", "_")}`;
    await c.env.ASSETS_BUCKET.put(sourceKey, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    try {
      const imported = await extractImportedFile(file), slug = await uniqueArticleSlug(c.env, imported.preferredSlug);
      await c.env.DB.prepare(
        "INSERT INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,published_at,seo_description,seo_title,tags_json,source_r2_key,source_name,source_type,import_status,import_error,created_at,updated_at) VALUES (?,?,?,?,?,?,'draft',1,NULL,NULL,NULL,?,?,?,?,?,?,?,?)",
      ).bind(
        id, imported.title, slug, imported.excerpt, imported.body || `# ${imported.title}\n\n> 该 PDF 需要 OCR，请在文章编辑器中执行 OCR 后再发布。`,
        categoryId, JSON.stringify(imported.tags), sourceKey, file.name,
        file.type === "application/pdf" ? "pdf" : "markdown",
        imported.needsOcr ? "needs_ocr" : "ready",
        imported.needsOcr ? "PDF 未检测到可复制文字" : null, now, now,
      ).run();
      results.push({ id, title: imported.title, status: imported.needsOcr ? "needs_ocr" : "ready" });
    } catch (error) {
      const title = file.name.replace(/\.[^.]+$/, ""), slug = await uniqueArticleSlug(c.env, title);
      await c.env.DB.prepare(
        "INSERT INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,tags_json,source_r2_key,source_name,source_type,import_status,import_error,created_at,updated_at) VALUES (?,?,?,?,?,?,'draft',1,'[]',?,?,?,'failed',?,?,?)",
      ).bind(id, title, slug, "", `# ${title}`, categoryId, sourceKey, file.name, file.type || "file", error instanceof Error ? error.message : "解析失败", now, now).run();
      results.push({ id, title, status: "failed" });
    }
  }
  await audit(c.env, c.req.raw, "article.import", "article", undefined, { count: results.length });
  return c.json({ items: results }, 202);
});
app.post("/api/admin/articles/import-url", async (c) => {
  const body = await c.req.json<{ url?: string; categoryId?: string | null }>().catch(() => ({} as { url?: string; categoryId?: string | null }));
  let url: URL;
  try { url = validateImportUrl(String(body.url || "")); } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "URL 不正确" }, 400);
  }
  const response = await fetch(url, { headers: { "User-Agent": "BunshinContentImporter/1.0" }, redirect: "follow" });
  if (!response.ok) return c.json({ error: `来源返回 ${response.status}` }, 400);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 5 * 1024 * 1024) return c.json({ error: "网页内容不能超过 5MB" }, 413);
  const contentType = response.headers.get("content-type") || "", raw = await response.text();
  if (raw.length > 5_000_000) return c.json({ error: "网页内容不能超过 5MB" }, 413);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw),
    imported = parseMarkdownImport(contentType.includes("html") ? stripHtml(raw) : raw, titleMatch?.[1]?.trim() || url.hostname),
    id = crypto.randomUUID(), now = new Date().toISOString(), slug = await uniqueArticleSlug(c.env, imported.preferredSlug),
    sourceKey = `article-sources/${id}/imported.md`;
  await c.env.ASSETS_BUCKET.put(sourceKey, imported.body, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await c.env.DB.prepare(
    "INSERT INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,tags_json,source_r2_key,source_name,source_type,import_status,created_at,updated_at) VALUES (?,?,?,?,?,?,'draft',1,?,?,?,'url','ready',?,?)",
  ).bind(id, imported.title, slug, imported.excerpt, imported.body, body.categoryId || null, JSON.stringify(imported.tags), sourceKey, url.toString(), now, now).run();
  await audit(c.env, c.req.raw, "article.import_url", "article", id, { url: url.origin });
  return c.json({ id }, 201);
});
app.post("/api/admin/articles", async (c) => {
  const parsed = articleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString(),
    id = crypto.randomUUID(),
    a = parsed.data;
  if (a.status === "scheduled" && (!a.scheduledAt || new Date(a.scheduledAt).getTime() <= Date.now()))
    return c.json({ error: "定时发布时间必须晚于当前时间" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,published_at,seo_description,seo_title,tags_json,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      a.title,
      a.slug,
      a.excerpt,
      a.body,
      a.categoryId,
      a.status,
      a.includeInRag ? 1 : 0,
      a.status === "published" ? now : null,
      a.seoDescription || null,
      a.seoTitle || null,
      JSON.stringify(a.tags),
      a.status === "scheduled" ? a.scheduledAt : null,
      now,
      now,
    )
    .run();
  const documentId = await syncArticleDocument(c.env, {
    id,
    ...a,
  });
  if (documentId)
    await c.env.DB.prepare("UPDATE articles SET document_id=? WHERE id=?")
      .bind(documentId, id).run();
  await audit(c.env, c.req.raw, "article.create", "article", id, { status: a.status });
  return c.json({ id, documentId }, 201);
});
app.put("/api/admin/articles/:id", async (c) => {
  const parsed = articleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const existing = await c.env.DB.prepare(
    "SELECT id,document_id,published_at FROM articles WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; document_id: string | null; published_at: string | null }>();
  if (!existing) return c.json({ error: "文章不存在" }, 404);
  const a = parsed.data, now = new Date().toISOString();
  if (a.status === "scheduled" && (!a.scheduledAt || new Date(a.scheduledAt).getTime() <= Date.now()))
    return c.json({ error: "定时发布时间必须晚于当前时间" }, 400);
  await saveArticleVersion(c.env, existing.id);
  await c.env.DB.prepare(
    "UPDATE articles SET title=?,slug=?,excerpt=?,body=?,category_id=?,status=?,include_in_rag=?,published_at=?,seo_description=?,seo_title=?,tags_json=?,scheduled_at=?,updated_at=? WHERE id=?",
  ).bind(
    a.title, a.slug, a.excerpt, a.body, a.categoryId, a.status,
    a.includeInRag ? 1 : 0,
    a.status === "published" ? (existing.published_at ?? now) : existing.published_at,
    a.seoDescription || null, a.seoTitle || null, JSON.stringify(a.tags),
    a.status === "scheduled" ? a.scheduledAt : null, now, existing.id,
  ).run();
  const documentId = await syncArticleDocument(c.env, {
    id: existing.id,
    ...a,
    documentId: existing.document_id,
  });
  await c.env.DB.prepare("UPDATE articles SET document_id=? WHERE id=?")
    .bind(documentId, existing.id).run();
  await audit(c.env, c.req.raw, "article.update", "article", existing.id, { status: a.status });
  return c.json({ id: existing.id, documentId });
});
app.delete("/api/admin/articles/:id", async (c) => {
  const article = await c.env.DB.prepare(
    "SELECT id,document_id,cover_r2_key,source_r2_key FROM articles WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; document_id: string | null; cover_r2_key: string | null; source_r2_key: string | null }>();
  if (!article) return c.json({ error: "文章不存在" }, 404);
  if (article.document_id) {
    await removeDocumentIndex(c.env, article.document_id);
    const document = await c.env.DB.prepare("SELECT r2_key FROM documents WHERE id=?")
      .bind(article.document_id).first<{ r2_key: string | null }>();
    if (document?.r2_key) await c.env.ASSETS_BUCKET.delete(document.r2_key);
    await c.env.DB.prepare("DELETE FROM documents WHERE id=?").bind(article.document_id).run();
  }
  await Promise.all([article.cover_r2_key, article.source_r2_key].filter(Boolean).map((key) => c.env.ASSETS_BUCKET.delete(key!)));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM article_versions WHERE article_id=?").bind(article.id),
    c.env.DB.prepare("DELETE FROM articles WHERE id=?").bind(article.id),
  ]);
  await audit(c.env, c.req.raw, "article.delete", "article", article.id);
  return c.json({ ok: true });
});
app.get("/api/admin/articles/:id/versions", async (c) =>
  c.json({ items: (await c.env.DB.prepare(
    "SELECT id,snapshot_json,created_at FROM article_versions WHERE article_id=? ORDER BY created_at DESC LIMIT 50",
  ).bind(c.req.param("id")).all()).results }),
);
app.post("/api/admin/articles/:id/versions/:versionId/restore", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT snapshot_json FROM article_versions WHERE id=? AND article_id=?",
  ).bind(c.req.param("versionId"), c.req.param("id")).first<{ snapshot_json: string }>();
  if (!row) return c.json({ error: "历史版本不存在" }, 404);
  const snapshot = JSON.parse(row.snapshot_json) as Record<string, any>, now = new Date().toISOString();
  await saveArticleVersion(c.env, c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE articles SET title=?,slug=?,excerpt=?,body=?,category_id=?,status='draft',include_in_rag=?,seo_description=?,seo_title=?,tags_json=?,scheduled_at=NULL,updated_at=? WHERE id=?",
  ).bind(snapshot.title, snapshot.slug, snapshot.excerpt || "", snapshot.body, snapshot.category_id || null,
    Number(snapshot.include_in_rag ?? 1), snapshot.seo_description || null, snapshot.seo_title || null,
    snapshot.tags_json || "[]", now, c.req.param("id")).run();
  await audit(c.env, c.req.raw, "article.restore", "article", c.req.param("id"), { versionId: c.req.param("versionId") });
  return c.json({ ok: true });
});
app.put("/api/admin/articles/:id/cover", async (c) => {
  const form = await c.req.formData(), file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "请选择封面图片" }, 400);
  if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024)
    return c.json({ error: "封面必须是 5MB 以内的图片" }, 400);
  const article = await c.env.DB.prepare("SELECT cover_r2_key FROM articles WHERE id=?")
    .bind(c.req.param("id")).first<{ cover_r2_key: string | null }>();
  if (!article) return c.json({ error: "文章不存在" }, 404);
  const key = `article-covers/${c.req.param("id")}/${crypto.randomUUID()}-${encodeURIComponent(file.name).replaceAll("%", "_")}`;
  await c.env.ASSETS_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare("UPDATE articles SET cover_r2_key=?,updated_at=? WHERE id=?")
    .bind(key, new Date().toISOString(), c.req.param("id")).run();
  if (article.cover_r2_key) await c.env.ASSETS_BUCKET.delete(article.cover_r2_key);
  return c.json({ ok: true });
});
app.delete("/api/admin/articles/:id/cover", async (c) => {
  const article = await c.env.DB.prepare("SELECT cover_r2_key FROM articles WHERE id=?")
    .bind(c.req.param("id")).first<{ cover_r2_key: string | null }>();
  if (article?.cover_r2_key) await c.env.ASSETS_BUCKET.delete(article.cover_r2_key);
  await c.env.DB.prepare("UPDATE articles SET cover_r2_key=NULL,updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), c.req.param("id")).run();
  return c.json({ ok: true });
});
app.get("/api/admin/articles/:id/source", async (c) => {
  const article = await c.env.DB.prepare("SELECT source_r2_key,source_name,source_type FROM articles WHERE id=?")
    .bind(c.req.param("id")).first<{ source_r2_key: string | null; source_name: string | null; source_type: string | null }>();
  if (!article?.source_r2_key) return c.json({ error: "没有导入源文件" }, 404);
  const object = await c.env.ASSETS_BUCKET.get(article.source_r2_key);
  if (!object) return c.json({ error: "源文件不存在" }, 404);
  const name = article.source_name || `article.${article.source_type === "pdf" ? "pdf" : "md"}`;
  return new Response(object.body, { headers: {
    "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "private, no-store",
  } });
});
app.post("/api/admin/articles/batch-action", async (c) => {
  const body = await c.req.json<{ ids?: string[]; action?: string; categoryId?: string | null }>().catch(() => ({} as { ids?: string[]; action?: string; categoryId?: string | null }));
  const ids = [...new Set(body.ids || [])].slice(0, 100);
  if (!ids.length) return c.json({ error: "请选择文章" }, 400);
  if (body.action === "category") {
    await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE articles SET category_id=?,updated_at=? WHERE id=?")
      .bind(body.categoryId || null, new Date().toISOString(), id)));
  } else if (["draft", "archived", "published"].includes(body.action || "")) {
    const now = new Date().toISOString();
    await c.env.DB.batch(ids.map((id) => c.env.DB.prepare(
      "UPDATE articles SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE published_at END,scheduled_at=NULL,updated_at=? WHERE id=?",
    ).bind(body.action, body.action, now, now, id)));
    for (const id of ids) {
      const article = await c.env.DB.prepare("SELECT id,title,slug,excerpt,body,status,include_in_rag,document_id FROM articles WHERE id=?")
        .bind(id).first<any>();
      if (article) await syncArticleDocument(c.env, { ...article, includeInRag: Boolean(article.include_in_rag), documentId: article.document_id });
    }
  } else return c.json({ error: "批量操作不受支持" }, 400);
  await audit(c.env, c.req.raw, "article.batch", "article", undefined, { action: body.action, count: ids.length });
  return c.json({ ok: true, count: ids.length });
});
app.post("/api/admin/articles/reindex", async (c) => {
  const articles = (
    await c.env.DB.prepare(
      "SELECT id,title,slug,excerpt,body,status,include_in_rag,document_id FROM articles WHERE status='published' AND include_in_rag=1",
    ).all<{
      id: string; title: string; slug: string; excerpt: string; body: string;
      status: string; include_in_rag: number; document_id: string | null;
    }>()
  ).results;
  for (const article of articles) {
    const documentId = await syncArticleDocument(c.env, {
      ...article,
      includeInRag: Boolean(article.include_in_rag),
      documentId: article.document_id,
    });
    await c.env.DB.prepare("UPDATE articles SET document_id=? WHERE id=?")
      .bind(documentId, article.id).run();
  }
  await audit(c.env, c.req.raw, "article.reindex", "article", undefined, { count: articles.length });
  return c.json({ ok: true, count: articles.length }, 202);
});
app.post("/api/admin/categories", async (c) => {
  const parsed = categorySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString(),
    id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO categories (id,name,slug,scope,description,sort_order,show_in_portal,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, parsed.data.name, parsed.data.slug, parsed.data.scope, parsed.data.description,
      parsed.data.sortOrder, parsed.data.showInPortal ? 1 : 0, now, now)
    .run();
  return c.json({ id }, 201);
});
app.put("/api/admin/categories/:id", async (c) => {
  const parsed = categorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const result = await c.env.DB.prepare(
    "UPDATE categories SET name=?,slug=?,scope=?,description=?,sort_order=?,show_in_portal=?,updated_at=? WHERE id=?",
  ).bind(parsed.data.name, parsed.data.slug, parsed.data.scope, parsed.data.description,
    parsed.data.sortOrder, parsed.data.showInPortal ? 1 : 0, new Date().toISOString(), c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "分类不存在" }, 404);
  await audit(c.env, c.req.raw, "category.update", "category", c.req.param("id"));
  return c.json({ ok: true });
});
app.delete("/api/admin/categories/:id", async (c) => {
  const id = c.req.param("id"), body = await c.req.json<{ replacementCategoryId?: string | null; uncategorize?: boolean }>().catch(() => ({} as { replacementCategoryId?: string | null; uncategorize?: boolean }));
  const counts = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM articles WHERE category_id=?) article_count,(SELECT COUNT(*) FROM documents WHERE category_id=?) document_count",
  ).bind(id, id).first<{ article_count: number; document_count: number }>();
  if ((Number(counts?.article_count) || Number(counts?.document_count)) && !body.replacementCategoryId && !body.uncategorize)
    return c.json({ error: "分类仍有关联内容，请选择迁移目标或确认移动到未分类", counts }, 409);
  if (body.replacementCategoryId === id) return c.json({ error: "不能合并到自身" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE articles SET category_id=? WHERE category_id=?").bind(body.replacementCategoryId || null, id),
    c.env.DB.prepare("UPDATE documents SET category_id=? WHERE category_id=?").bind(body.replacementCategoryId || null, id),
    c.env.DB.prepare("DELETE FROM categories WHERE id=?").bind(id),
  ]);
  await audit(c.env, c.req.raw, "category.delete", "category", id, { replacementCategoryId: body.replacementCategoryId || null });
  return c.json({ ok: true });
});
app.post("/api/admin/providers", async (c) => {
  const parsed = providerSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const p = parsed.data,
    now = new Date().toISOString(),
    id = crypto.randomUUID();
  const encrypted = await encryptSecret(p.apiKey, c.env.MASTER_ENCRYPTION_KEY);
  await c.env.DB.prepare(
    "INSERT INTO providers (id,name,kind,base_url,encrypted_api_key,key_preview,chat_model,embedding_model,monthly_budget_micros,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      p.name,
      p.kind,
      p.baseUrl,
      JSON.stringify(encrypted),
      `${p.apiKey.slice(0, Math.min(4, Math.max(0, p.apiKey.length - 2)))}*****${p.apiKey.slice(-2)}`,
      p.chatModel,
      p.embeddingModel,
      p.monthlyBudgetMicros,
      1,
      now,
      now,
    )
    .run();
  return c.json({ id, keyPreview: `••••${p.apiKey.slice(-4)}` }, 201);
});
app.post("/api/admin/providers/simple", async (c) => {
  const parsed = simpleProviderSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const input = parsed.data,
    preset = providerPresets[input.presetId],
    baseUrl =
      input.presetId === "custom"
        ? (input.baseUrl ?? preset.baseUrl)
        : preset.baseUrl,
    chatModel = input.chatModel ?? preset.chatModel,
    encrypted = await encryptSecret(input.apiKey, c.env.MASTER_ENCRYPTION_KEY),
    now = new Date().toISOString(),
    id = crypto.randomUUID(),
    preview = `${input.apiKey.slice(0, 4)}*****${input.apiKey.slice(-2)}`,
    embeddingMode =
      input.allowExternalEmbedding && preset.embeddingMode === "provider"
        ? "provider"
        : "local";
  try {
    await testChatConnection({
      baseUrl,
      apiKey: input.apiKey,
      model: chatModel,
    });
  } catch (error) {
    return c.json(
      {
        error: providerErrorMessage(error),
      },
      400,
    );
  }
  await c.env.DB.prepare("UPDATE providers SET is_default=0").run();
  await c.env.DB.prepare(
    "INSERT INTO providers (id,name,kind,base_url,encrypted_api_key,key_preview,chat_model,embedding_model,input_price_micros,output_price_micros,monthly_budget_micros,is_default,preset_id,embedding_mode,health_status,last_checked_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      preset.name,
      preset.kind,
      baseUrl,
      JSON.stringify(encrypted),
      preview,
      chatModel,
      preset.embeddingModel,
      preset.inputPriceMicros,
      preset.outputPriceMicros,
      input.monthlyBudgetMicros,
      1,
      input.presetId,
      embeddingMode,
      "healthy",
      now,
      null,
      now,
      now,
    )
    .run();
  if (embeddingMode === "provider") {
    const documents = (
      await c.env.DB.prepare(
        "SELECT id,r2_key,source_type FROM documents WHERE visibility!='private' AND r2_key IS NOT NULL",
      ).all<{ id: string; r2_key: string; source_type: string }>()
    ).results;
    for (const document of documents) {
      await c.env.DB.prepare(
        "UPDATE documents SET status='uploaded',error_message=NULL,updated_at=? WHERE id=?",
      )
        .bind(now, document.id)
        .run();
      await c.env.INGESTION_QUEUE.send({
        type: "ingest",
        documentId: document.id,
        r2Key: document.r2_key,
        mimeType:
          document.source_type === "pdf" ? "application/pdf" : "text/plain",
      } satisfies Job);
    }
  }
  return c.json(
    {
      id,
      keyPreview: preview,
      embeddingMode,
      healthStatus: "healthy",
    },
    201,
  );
});
app.post("/api/admin/providers/:id/test", async (c) => {
  const provider = await c.env.DB.prepare(
    "SELECT id,base_url,encrypted_api_key,chat_model FROM providers WHERE id=? LIMIT 1",
  )
    .bind(c.req.param("id"))
    .first<{
      id: string;
      base_url: string;
      encrypted_api_key: string;
      chat_model: string;
    }>();
  if (!provider) return c.json({ error: "渠道不存在" }, 404);
  const now = new Date().toISOString();
  try {
    const apiKey = await decryptSecret(
      JSON.parse(provider.encrypted_api_key) as EncryptedSecret,
      c.env.MASTER_ENCRYPTION_KEY,
    );
    await testChatConnection({
      baseUrl: provider.base_url,
      apiKey,
      model: provider.chat_model,
    });
    await c.env.DB.prepare(
      "UPDATE providers SET health_status='healthy',last_checked_at=?,last_error=NULL,updated_at=? WHERE id=?",
    )
      .bind(now, now, provider.id)
      .run();
    return c.json({ healthStatus: "healthy" });
  } catch (error) {
    const message = providerErrorMessage(error);
    await c.env.DB.prepare(
      "UPDATE providers SET health_status='error',last_checked_at=?,last_error=?,updated_at=? WHERE id=?",
    )
      .bind(now, message, now, provider.id)
      .run();
    return c.json({ error: message }, 400);
  }
});
app.post("/api/admin/documents", async (c) => {
  const form = await c.req.formData(),
    file = form.get("file"),
    textInput = String(form.get("text") || "").trim(),
    title = String(form.get("title") || "").trim(),
    categoryId = String(form.get("categoryId") || "") || null,
    visibility = String(form.get("visibility") || "rag_only");
  const purpose = String(form.get("purpose") || "");
  const resumeProfile = purpose === "resume"
    ? await c.env.DB.prepare(
        "SELECT id,resume_document_id FROM profiles ORDER BY created_at LIMIT 1",
      ).first<{ id: string; resume_document_id: string | null }>()
    : null;
  if (purpose === "resume" && !resumeProfile)
    return c.json({ error: "请先保存个人资料" }, 409);
  if (!(file instanceof File) && !textInput || !title)
    return c.json({ error: "请提供文件或文字内容，并填写标题" }, 400);
  if (file instanceof File && file.size > 20 * 1024 * 1024)
    return c.json({ error: "文件不能超过 20MB" }, 413);
  const allowed = new Set(["application/pdf", "text/plain", "text/markdown"]);
  if (file instanceof File && !allowed.has(file.type))
    return c.json({ error: "不支持的文件类型" }, 415);
  const id = crypto.randomUUID(),
    originalName = file instanceof File ? file.name : `${title}.md`,
    r2Key = `documents/${id}/${encodeURIComponent(originalName).replaceAll("%", "_")}`,
    now = new Date().toISOString();
  const mimeType = file instanceof File ? file.type : "text/markdown";
  await c.env.ASSETS_BUCKET.put(r2Key, file instanceof File ? file.stream() : textInput, {
    httpMetadata: { contentType: mimeType },
  });
  await c.env.DB.prepare(
    "INSERT INTO documents (id,title,source_type,category_id,visibility,status,r2_key,purpose,original_name,file_size,ingestion_progress,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,10,?,?)",
  )
    .bind(
      id,
      title,
      mimeType.includes("pdf") ? "pdf" : mimeType.includes("markdown") ? "markdown" : "text",
      categoryId,
      visibility,
      "uploaded",
      r2Key,
      purpose === "resume" ? "resume" : "knowledge",
      originalName,
      file instanceof File ? file.size : new TextEncoder().encode(textInput).length,
      now,
      now,
    )
    .run();
  await c.env.DB.prepare(
    "INSERT INTO document_versions (id,document_id,version_number,r2_key,original_name,source_type,file_size,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(crypto.randomUUID(), id, 1, r2Key, originalName,
    mimeType.includes("pdf") ? "pdf" : mimeType.includes("markdown") ? "markdown" : "text",
    file instanceof File ? file.size : new TextEncoder().encode(textInput).length, now).run();
  await c.env.INGESTION_QUEUE.send({
    type: "ingest",
    documentId: id,
    r2Key,
    mimeType,
  } satisfies Job);
  if (purpose === "resume") {
    if (resumeProfile?.resume_document_id && resumeProfile.resume_document_id !== id) {
      await removeDocumentIndex(c.env, resumeProfile.resume_document_id);
      await c.env.DB.prepare(
        "UPDATE documents SET visibility='private',status='archived',archived_at=?,updated_at=? WHERE id=?",
      ).bind(now, now, resumeProfile.resume_document_id).run();
    }
    await c.env.DB.prepare(
      "UPDATE profiles SET resume_document_id=?,updated_at=? WHERE id=?",
    )
      .bind(id, now, resumeProfile!.id)
      .run();
  }
  await audit(c.env, c.req.raw, "document.create", "document", id, { purpose, visibility });
  return c.json({ id, status: "uploaded" }, 202);
});
app.get("/api/admin/documents/:id/detail", async (c) => {
  const item = await c.env.DB.prepare(
    "SELECT documents.*,categories.name category_name FROM documents LEFT JOIN categories ON categories.id=documents.category_id WHERE documents.id=?",
  ).bind(c.req.param("id")).first();
  if (!item) return c.json({ error: "文档不存在" }, 404);
  const [chunks, versions] = await Promise.all([
    c.env.DB.prepare("SELECT id,chunk_index,content,heading_path,page_number FROM chunks WHERE document_id=? ORDER BY chunk_index LIMIT 200")
      .bind(c.req.param("id")).all(),
    c.env.DB.prepare("SELECT id,version_number,original_name,source_type,file_size,created_at FROM document_versions WHERE document_id=? ORDER BY version_number DESC")
      .bind(c.req.param("id")).all(),
  ]);
  return c.json({ item, chunks: chunks.results, versions: versions.results });
});
app.get("/api/admin/documents/:id/versions/:versionId/download", async (c) => {
  const version = await c.env.DB.prepare(
    "SELECT document_versions.r2_key,document_versions.original_name,document_versions.source_type FROM document_versions JOIN documents ON documents.id=document_versions.document_id WHERE document_versions.id=? AND document_versions.document_id=?",
  ).bind(c.req.param("versionId"), c.req.param("id")).first<{ r2_key: string; original_name: string; source_type: string }>();
  if (!version) return c.json({ error: "版本不存在" }, 404);
  const object = await c.env.ASSETS_BUCKET.get(version.r2_key);
  if (!object) return c.json({ error: "版本文件不存在" }, 404);
  const fallbackType = version.source_type === "pdf" ? "application/pdf" : version.source_type === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
  return new Response(object.body, { headers: {
    "Content-Type": object.httpMetadata?.contentType || fallbackType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(version.original_name)}`,
    "Cache-Control": "private, no-store",
  } });
});
app.post("/api/admin/documents/:id/versions/:versionId/restore", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT documents.id,documents.purpose,documents.current_version,document_versions.r2_key,document_versions.original_name,document_versions.source_type,document_versions.file_size FROM document_versions JOIN documents ON documents.id=document_versions.document_id WHERE document_versions.id=? AND document_versions.document_id=?",
  ).bind(c.req.param("versionId"), c.req.param("id")).first<{ id: string; purpose: string; current_version: number; r2_key: string; original_name: string; source_type: string; file_size: number }>();
  if (!row) return c.json({ error: "版本不存在" }, 404);
  if (row.purpose !== "knowledge") return c.json({ error: "只能恢复普通知识资料" }, 409);
  const version = Number(row.current_version || 1) + 1, now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO document_versions (id,document_id,version_number,r2_key,original_name,source_type,file_size,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), row.id, version, row.r2_key, row.original_name, row.source_type, row.file_size, now),
    c.env.DB.prepare("UPDATE documents SET r2_key=?,original_name=?,source_type=?,file_size=?,current_version=?,status='uploaded',ingestion_progress=10,error_message=NULL,ocr_status='none',ocr_r2_key=NULL,updated_at=? WHERE id=?")
      .bind(row.r2_key, row.original_name, row.source_type, row.file_size, version, now, row.id),
  ]);
  await removeDocumentIndex(c.env, row.id);
  const mimeType = row.source_type === "pdf" ? "application/pdf" : row.source_type === "markdown" ? "text/markdown" : "text/plain";
  await c.env.INGESTION_QUEUE.send({ type: "ingest", documentId: row.id, r2Key: row.r2_key, mimeType } satisfies Job);
  await audit(c.env, c.req.raw, "document.version.restore", "document", row.id, { version });
  return c.json({ ok: true, version }, 202);
});
app.post("/api/admin/documents/:id/replace", async (c) => {
  const form = await c.req.formData(), file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "请选择替换文件" }, 400);
  if (file.size > 20 * 1024 * 1024) return c.json({ error: "文件不能超过 20MB" }, 413);
  const allowed = new Set(["application/pdf", "text/plain", "text/markdown"]);
  if (!allowed.has(file.type)) return c.json({ error: "不支持的文件类型" }, 415);
  const document = await c.env.DB.prepare(
    "SELECT id,current_version,purpose FROM documents WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; current_version: number; purpose: string }>();
  if (!document || document.purpose !== "knowledge") return c.json({ error: "只能在知识库替换普通资料" }, 409);
  const version = Number(document.current_version || 1) + 1, now = new Date().toISOString(),
    type = file.type === "application/pdf" ? "pdf" : file.type === "text/markdown" ? "markdown" : "text",
    key = `documents/${document.id}/v${version}-${encodeURIComponent(file.name).replaceAll("%", "_")}`;
  await c.env.ASSETS_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO document_versions (id,document_id,version_number,r2_key,original_name,source_type,file_size,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), document.id, version, key, file.name, type, file.size, now),
    c.env.DB.prepare("UPDATE documents SET r2_key=?,original_name=?,source_type=?,file_size=?,current_version=?,status='uploaded',ingestion_progress=10,error_message=NULL,ocr_status='none',ocr_r2_key=NULL,updated_at=? WHERE id=?")
      .bind(key, file.name, type, file.size, version, now, document.id),
  ]);
  await removeDocumentIndex(c.env, document.id);
  await c.env.INGESTION_QUEUE.send({ type: "ingest", documentId: document.id, r2Key: key, mimeType: file.type } satisfies Job);
  await audit(c.env, c.req.raw, "document.replace", "document", document.id, { version });
  return c.json({ ok: true, version }, 202);
});
app.post("/api/admin/documents/:id/ocr-result", async (c) => {
  const form = await c.req.formData(), file = form.get("file"), textInput = String(form.get("text") || "").trim(),
    text = file instanceof File ? (file.size > 5 * 1024 * 1024 ? "" : await file.text()) : textInput;
  if (text.length < 40) return c.json({ error: "请上传或粘贴至少 40 个字符的 OCR 结果" }, 400);
  const document = await c.env.DB.prepare("SELECT id,title FROM documents WHERE id=?")
    .bind(c.req.param("id")).first<{ id: string; title: string }>();
  if (!document) return c.json({ error: "文档不存在" }, 404);
  const key = `documents/${document.id}/ocr-${Date.now()}.md`, now = new Date().toISOString();
  await c.env.ASSETS_BUCKET.put(key, text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await c.env.DB.prepare(
    "UPDATE documents SET ocr_status='provided',ocr_r2_key=?,status='uploaded',ingestion_progress=10,error_message=NULL,updated_at=? WHERE id=?",
  ).bind(key, now, document.id).run();
  await c.env.INGESTION_QUEUE.send({ type: "ingest", documentId: document.id, r2Key: key, mimeType: "text/markdown" } satisfies Job);
  await audit(c.env, c.req.raw, "document.ocr_result", "document", document.id);
  return c.json({ ok: true }, 202);
});
app.post("/api/admin/documents/import-url", async (c) => {
  const body = await c.req.json<{ url?: string; title?: string; categoryId?: string | null; visibility?: string }>().catch(() => ({} as { url?: string; title?: string; categoryId?: string | null; visibility?: string }));
  let url: URL;
  try { url = validateImportUrl(String(body.url || "")); } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "URL 不正确" }, 400);
  }
  const response = await fetch(url, { headers: { "User-Agent": "BunshinKnowledgeImporter/1.0" }, redirect: "follow" });
  if (!response.ok) return c.json({ error: `来源返回 ${response.status}` }, 400);
  const raw = await response.text();
  if (raw.length > 5_000_000) return c.json({ error: "网页内容不能超过 5MB" }, 413);
  const contentType = response.headers.get("content-type") || "", titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw),
    text = contentType.includes("html") ? stripHtml(raw) : raw,
    title = String(body.title || titleMatch?.[1] || url.hostname).trim(), id = crypto.randomUUID(), now = new Date().toISOString(),
    key = `documents/${id}/imported.md`, size = new TextEncoder().encode(text).length,
    visibility = ["public", "rag_only", "private"].includes(body.visibility || "") ? body.visibility! : "rag_only";
  if (text.length < 40) return c.json({ error: "网页没有可导入的正文" }, 400);
  await c.env.ASSETS_BUCKET.put(key, text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO documents (id,title,source_type,category_id,visibility,status,r2_key,purpose,original_name,file_size,source_url,ingestion_progress,created_at,updated_at) VALUES (?,?,?,?,?,'uploaded',?,'knowledge','imported.md',?,?,10,?,?)")
      .bind(id, title, "markdown", body.categoryId || null, visibility, key, size, url.toString(), now, now),
    c.env.DB.prepare("INSERT INTO document_versions (id,document_id,version_number,r2_key,original_name,source_type,file_size,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), id, 1, key, "imported.md", "markdown", size, now),
  ]);
  await c.env.INGESTION_QUEUE.send({ type: "ingest", documentId: id, r2Key: key, mimeType: "text/markdown" } satisfies Job);
  await audit(c.env, c.req.raw, "document.import_url", "document", id, { origin: url.origin });
  return c.json({ id }, 202);
});
app.post("/api/admin/documents/:id/search-test", async (c) => {
  const body = await c.req.json<{ query?: string }>().catch(() => ({} as { query?: string })), query = String(body.query || "").trim();
  if (!query) return c.json({ error: "请输入测试问题" }, 400);
  const rows = (await c.env.DB.prepare(
    "SELECT chunks.id,chunks.chunk_index,chunks.content,chunks.heading_path,local_vectors.embedding_json FROM chunks JOIN local_vectors ON local_vectors.chunk_id=chunks.id WHERE chunks.document_id=?",
  ).bind(c.req.param("id")).all<any>()).results;
  const vector = createLocalEmbedding(query), vectorItems = rows.map((row) => ({
    id: row.id, chunkIndex: row.chunk_index, content: row.content, headingPath: JSON.parse(row.heading_path || "[]"),
    score: cosineSimilarity(vector, JSON.parse(row.embedding_json)),
  })).sort((a, b) => b.score - a.score).slice(0, 12),
    lexicalItems=bm25Search(query,rows.map((row)=>({id:row.id,chunkIndex:row.chunk_index,content:row.content,headingPath:JSON.parse(row.heading_path||"[]")})),12),
    items=rerankHybrid(query,reciprocalRankFusion([lexicalItems,vectorItems],8),5);
  return c.json({ items });
});
app.post("/api/admin/documents/batch-action", async (c) => {
  const body = await c.req.json<{ ids?: string[]; action?: string; categoryId?: string | null; visibility?: string }>().catch(() => ({} as { ids?: string[]; action?: string; categoryId?: string | null; visibility?: string })),
    ids = [...new Set(body.ids || [])].slice(0, 100), now = new Date().toISOString();
  if (!ids.length) return c.json({ error: "请选择资料" }, 400);
  if (body.action === "category")
    await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE documents SET category_id=?,updated_at=? WHERE id=? AND purpose='knowledge'").bind(body.categoryId || null, now, id)));
  else if (body.action === "visibility" && ["public", "rag_only", "private"].includes(body.visibility || "")) {
    await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE documents SET visibility=?,updated_at=? WHERE id=? AND purpose='knowledge'").bind(body.visibility, now, id)));
    for (const id of ids) {
      if (body.visibility === "private") await removeDocumentIndex(c.env, id);
      else {
        const item = await c.env.DB.prepare("SELECT r2_key,source_type FROM documents WHERE id=? AND purpose='knowledge'").bind(id).first<{ r2_key: string; source_type: string }>();
        if (item?.r2_key) await c.env.INGESTION_QUEUE.send({ type: "ingest", documentId: id, r2Key: item.r2_key, mimeType: item.source_type === "pdf" ? "application/pdf" : "text/markdown" } satisfies Job);
      }
    }
  }
  else if (body.action === "retry") {
    for (const id of ids) {
      const item = await c.env.DB.prepare("SELECT r2_key,source_type FROM documents WHERE id=? AND purpose='knowledge'").bind(id).first<{ r2_key: string; source_type: string }>();
      if (!item?.r2_key) continue;
      await c.env.DB.prepare("UPDATE documents SET status='uploaded',ingestion_progress=10,error_message=NULL,updated_at=? WHERE id=?").bind(now, id).run();
      await c.env.INGESTION_QUEUE.send({ type: "ingest", documentId: id, r2Key: item.r2_key, mimeType: item.source_type === "pdf" ? "application/pdf" : "text/markdown" } satisfies Job);
    }
  } else return c.json({ error: "批量操作不受支持" }, 400);
  await audit(c.env, c.req.raw, "document.batch", "document", undefined, { action: body.action, count: ids.length });
  return c.json({ ok: true, count: ids.length });
});
app.patch("/api/admin/documents/:id", async (c) => {
  const body = await c.req.json<{ title?: string; categoryId?: string | null; visibility?: string }>().catch(() => ({} as { title?: string; categoryId?: string | null; visibility?: string }));
  const visibility = body.visibility;
  if (visibility && !["public", "rag_only", "private"].includes(visibility))
    return c.json({ error: "可见性不正确" }, 400);
  const current = await c.env.DB.prepare(
    "SELECT id,title,category_id,visibility,r2_key,source_type FROM documents WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; title: string; category_id: string | null; visibility: string; r2_key: string | null; source_type: string }>();
  if (!current) return c.json({ error: "文档不存在" }, 404);
  const nextVisibility = visibility ?? current.visibility;
  await c.env.DB.prepare(
    "UPDATE documents SET title=?,category_id=?,visibility=?,updated_at=? WHERE id=?",
  ).bind(
    body.title?.trim() || current.title,
    body.categoryId === undefined ? current.category_id : body.categoryId,
    nextVisibility,
    new Date().toISOString(),
    current.id,
  ).run();
  if (nextVisibility === "private") await removeDocumentIndex(c.env, current.id);
  else if (current.visibility === "private" && current.r2_key) {
    await c.env.DB.prepare(
      "UPDATE documents SET status='uploaded',archived_at=NULL,error_message=NULL,updated_at=? WHERE id=?",
    ).bind(new Date().toISOString(), current.id).run();
    await c.env.INGESTION_QUEUE.send({
      type: "ingest", documentId: current.id, r2Key: current.r2_key,
      mimeType: current.source_type === "pdf" ? "application/pdf" : "text/markdown",
    } satisfies Job);
  }
  await audit(c.env, c.req.raw, "document.update", "document", current.id, { visibility: nextVisibility });
  return c.json({ ok: true });
});
app.post("/api/admin/documents/:id/retry", async (c) => {
  const document = await c.env.DB.prepare(
    "SELECT id,r2_key,source_type FROM documents WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; r2_key: string | null; source_type: string }>();
  if (!document?.r2_key) return c.json({ error: "原文件不存在" }, 404);
  await c.env.DB.prepare(
    "UPDATE documents SET status='uploaded',ingestion_progress=10,error_message=NULL,archived_at=NULL,updated_at=? WHERE id=?",
  ).bind(new Date().toISOString(), document.id).run();
  await c.env.INGESTION_QUEUE.send({
    type: "ingest", documentId: document.id, r2Key: document.r2_key,
    mimeType: document.source_type === "pdf" ? "application/pdf" : "text/markdown",
  } satisfies Job);
  await audit(c.env, c.req.raw, "document.retry", "document", document.id);
  return c.json({ ok: true }, 202);
});
app.delete("/api/admin/documents/:id", async (c) => {
  const document = await c.env.DB.prepare(
    "SELECT id,r2_key,ocr_r2_key,purpose FROM documents WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; r2_key: string | null; ocr_r2_key: string | null; purpose: string }>();
  if (!document) return c.json({ error: "文档不存在" }, 404);
  if (["profile", "article"].includes(document.purpose))
    return c.json({ error: "该文档由资料或文章生成，请在对应模块管理" }, 409);
  await removeDocumentIndex(c.env, document.id);
  const versionKeys = (await c.env.DB.prepare("SELECT r2_key FROM document_versions WHERE document_id=?")
    .bind(document.id).all<{ r2_key: string }>()).results.map((item) => item.r2_key);
  await Promise.all([...new Set([document.r2_key, document.ocr_r2_key, ...versionKeys].filter(Boolean))].map((key) => c.env.ASSETS_BUCKET.delete(key!)));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE profiles SET resume_document_id=NULL WHERE resume_document_id=?").bind(document.id),
    c.env.DB.prepare("DELETE FROM document_versions WHERE document_id=?").bind(document.id),
    c.env.DB.prepare("DELETE FROM documents WHERE id=?").bind(document.id),
  ]);
  await audit(c.env, c.req.raw, "document.delete", "document", document.id);
  return c.json({ ok: true });
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

async function currentAdmin(request: Request, env: Env) {
  const token = readCookie(request.headers.get("Cookie"), "bunshin_session");
  if (!token) return null;
  return env.DB.prepare(
    "SELECT admin_users.id,admin_users.email FROM sessions JOIN admin_users ON admin_users.id=sessions.admin_id WHERE sessions.token_hash=? AND sessions.expires_at>?",
  )
    .bind(await sha256(token), new Date().toISOString())
    .first<{ id: string; email: string }>();
}

async function syncOperationalAlert(env:Env,input:{fingerprint:string;active:boolean;kind:string;severity:"warning"|"error"|"critical";title:string;message:string;metric?:number;threshold?:number}){const now=new Date().toISOString();if(!input.active){await env.DB.prepare("UPDATE operational_alerts SET status='resolved',resolved_at=?,last_seen_at=? WHERE fingerprint=? AND status!='resolved'").bind(now,now,input.fingerprint).run();return}await env.DB.prepare("INSERT INTO operational_alerts (id,fingerprint,kind,severity,title,message,status,metric_value,threshold_value,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,'open',?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET kind=excluded.kind,severity=excluded.severity,title=excluded.title,message=excluded.message,metric_value=excluded.metric_value,threshold_value=excluded.threshold_value,last_seen_at=excluded.last_seen_at,status=CASE WHEN operational_alerts.status='resolved' THEN 'open' ELSE operational_alerts.status END,resolved_at=NULL").bind(crypto.randomUUID(),input.fingerprint,input.kind,input.severity,input.title,input.message,input.metric??null,input.threshold??null,now,now).run()}

async function evaluateOperationalAlerts(env:Env){const setting=await env.DB.prepare("SELECT value FROM settings WHERE key='observability_config'").first<{value:string}>(),config={errorRateThreshold:20,minimumRequests:5,stuckMinutes:15,budgetWarningPercent:80,slowRequestMs:12000,...(setting?.value?JSON.parse(setting.value):{})},[usage,stuck,queue,budgets,turnstile]=await Promise.all([
  env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) errors FROM usage_events WHERE created_at>=datetime('now','-15 minutes')").first<{total:number;errors:number}>(),
  env.DB.prepare("SELECT COUNT(*) count FROM documents WHERE status IN ('parsing','embedding') AND updated_at<datetime('now',?)").bind(`-${config.stuckMinutes} minutes`).first<{count:number}>(),
  env.DB.prepare("SELECT COUNT(*) count FROM queue_job_runs WHERE status IN ('retrying','dead_letter_risk') OR (status='processing' AND heartbeat_at<datetime('now',?))").bind(`-${config.stuckMinutes} minutes`).first<{count:number}>(),
  env.DB.prepare("SELECT providers.id,providers.name,providers.monthly_budget_micros,COALESCE(SUM(usage_events.cost_micros),0) spent FROM providers LEFT JOIN usage_events ON usage_events.provider_id=providers.id AND usage_events.created_at>=datetime('now','start of month') GROUP BY providers.id").all<{id:string;name:string;monthly_budget_micros:number;spent:number}>(),
  env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN event_type='turnstile_fail' THEN 1 ELSE 0 END) failed FROM observability_events WHERE event_type IN ('turnstile_pass','turnstile_fail') AND created_at>=datetime('now','-15 minutes')").first<{total:number;failed:number}>(),
]);const errorRate=(usage?.total??0)>0?((usage?.errors??0)/(usage?.total??1))*100:0,turnstileRate=(turnstile?.total??0)>0?((turnstile?.failed??0)/(turnstile?.total??1))*100:0;await Promise.all([
  syncOperationalAlert(env,{fingerprint:"usage_error_rate",active:(usage?.total??0)>=config.minimumRequests&&errorRate>=config.errorRateThreshold,kind:"error_rate",severity:"error",title:"模型调用错误率升高",message:`最近 15 分钟错误率 ${errorRate.toFixed(1)}%`,metric:errorRate,threshold:config.errorRateThreshold}),
  syncOperationalAlert(env,{fingerprint:"stuck_documents",active:(stuck?.count??0)>0,kind:"stuck",severity:"critical",title:"文档处理可能卡死",message:`${stuck?.count??0} 个任务超过 ${config.stuckMinutes} 分钟未推进`,metric:stuck?.count??0,threshold:1}),
  syncOperationalAlert(env,{fingerprint:"queue_retry_risk",active:(queue?.count??0)>0,kind:"dead_letter",severity:"critical",title:"Queue 重试或死信风险",message:`${queue?.count??0} 个 Queue 任务正在重试或心跳超时`,metric:queue?.count??0,threshold:1}),
  syncOperationalAlert(env,{fingerprint:"turnstile_failure_rate",active:(turnstile?.total??0)>=10&&turnstileRate>=50,kind:"security",severity:"warning",title:"人机验证失败率异常",message:`最近 15 分钟 Turnstile 失败率 ${turnstileRate.toFixed(1)}%`,metric:turnstileRate,threshold:50}),
  ...budgets.results.map((provider)=>{const percent=provider.monthly_budget_micros>0?provider.spent/provider.monthly_budget_micros*100:0;return syncOperationalAlert(env,{fingerprint:`budget:${provider.id}`,active:provider.monthly_budget_micros>0&&percent>=config.budgetWarningPercent,kind:"budget",severity:percent>=100?"critical":"warning",title:`${provider.name} 预算预警`,message:`本月预算已使用 ${percent.toFixed(1)}%`,metric:percent,threshold:config.budgetWarningPercent})}),
]);}

async function updateQueueRun(env:Env,input:{id:string;documentId:string;status:string;attempt:number;traceId:string;startedAt:string;error?:string}){const now=new Date().toISOString();await env.DB.prepare("INSERT INTO queue_job_runs (id,document_id,status,attempt,trace_id,error_message,started_at,heartbeat_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempt=excluded.attempt,error_message=excluded.error_message,heartbeat_at=excluded.heartbeat_at,completed_at=excluded.completed_at").bind(input.id,input.documentId,input.status,input.attempt,input.traceId,input.error??null,input.startedAt,now,input.status==='completed'?now:null).run()}

async function consume(batch: MessageBatch<Job>, env: Env) {
  for (const message of batch.messages) {
    const job = message.body;
    const attempt=(message as Message<Job>&{attempts?:number}).attempts??1,
      runId=`${job.documentId}:${attempt}`,
      traceId=crypto.randomUUID(),
      startedAt=new Date().toISOString();
    try {
      await updateQueueRun(env,{id:runId,documentId:job.documentId,status:"processing",attempt,traceId,startedAt});
      await recordAdminTelemetry(env,{eventType:"queue_started",scenario:"ingestion",traceId,detail:{documentId:job.documentId,attempt}});
      await env.DB.prepare(
        "UPDATE documents SET status='parsing',ingestion_progress=35, updated_at=? WHERE id=?",
      )
        .bind(new Date().toISOString(), job.documentId)
        .run();
      const object = await env.ASSETS_BUCKET.get(job.r2Key);
      if (!object) throw new Error("R2 object missing");
      let text: string;
      if (job.mimeType === "application/pdf") {
        const pdf = await getDocumentProxy(
          new Uint8Array(await object.arrayBuffer()),
          { maxImageSize: 16_777_216 },
        );
        if (pdf.numPages > 100) throw new Error("PDF 页数不能超过 100 页");
        const extracted = await extractText(pdf, { mergePages: true });
        text = String(extracted.text).trim();
        if (text.length < 40) {
          await env.DB.prepare(
            "UPDATE documents SET status='needs_ocr',ingestion_progress=100,ocr_status='required', error_message='未检测到足够的可复制文字，可能是扫描版 PDF', updated_at=? WHERE id=?",
          )
            .bind(new Date().toISOString(), job.documentId)
            .run();
          await updateQueueRun(env,{id:runId,documentId:job.documentId,status:"completed",attempt,traceId,startedAt});
          message.ack();
          continue;
        }
      } else text = await object.text();
      const chunks = chunkText(text);
      const documentMeta = await env.DB.prepare(
        "SELECT visibility FROM documents WHERE id=?",
      ).bind(job.documentId).first<{ visibility: string }>();
      if (!documentMeta || documentMeta.visibility === "private") {
        await removeDocumentIndex(env, job.documentId);
        await env.DB.prepare(
          "UPDATE documents SET status='archived',ingestion_progress=100,updated_at=? WHERE id=?",
        ).bind(new Date().toISOString(), job.documentId).run();
        await updateQueueRun(env,{id:runId,documentId:job.documentId,status:"completed",attempt,traceId,startedAt});
        message.ack();
        continue;
      }
      await removeDocumentIndex(env, job.documentId);
      await env.DB.batch(
        chunks.map((chunk) =>
          env.DB.prepare(
            "INSERT INTO chunks (id,document_id,chunk_index,content,heading_path,visibility,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)",
          ).bind(
            chunk.id,
            job.documentId,
            chunk.index,
            chunk.text,
            JSON.stringify(chunk.headingPath),
            documentMeta.visibility,
            String(chunk.text.length),
            new Date().toISOString(),
          ),
        ),
      );
      if (chunks.length)
        await env.DB.batch(
          chunks.map((chunk) =>
            env.DB.prepare(
              "INSERT INTO local_vectors (chunk_id,document_id,embedding_json,created_at) VALUES (?,?,?,?)",
            ).bind(
              chunk.id,
              job.documentId,
              JSON.stringify(createLocalEmbedding(chunk.text)),
              new Date().toISOString(),
            ),
          ),
        );
      const provider = await env.DB.prepare(
        "SELECT id,base_url,encrypted_api_key,embedding_model,embedding_mode FROM providers WHERE enabled=1 AND is_default=1 LIMIT 1",
      ).first<{
        id: string;
        base_url: string;
        encrypted_api_key: string;
        embedding_model: string;
        embedding_mode: string;
      }>();
      if (provider?.embedding_mode === "provider" && chunks.length) {
        await updateQueueRun(env,{id:runId,documentId:job.documentId,status:"processing",attempt,traceId,startedAt});
        await env.DB.prepare(
          "UPDATE documents SET status='embedding',ingestion_progress=75,updated_at=? WHERE id=?",
        )
          .bind(new Date().toISOString(), job.documentId)
          .run();
        const apiKey = await decryptSecret(
          JSON.parse(provider.encrypted_api_key) as EncryptedSecret,
          env.MASTER_ENCRYPTION_KEY,
        );
        const started = Date.now(),
          embedded = await createEmbedding(
            {
              baseUrl: provider.base_url,
              apiKey,
              model: provider.embedding_model,
            },
            chunks.map((chunk) => chunk.text),
          );
        await env.VECTORIZE.upsert(
          chunks.map((chunk, index) => ({
            id: chunk.id,
            values: embedded.vectors[index]!,
            metadata: { documentId: job.documentId },
          })),
        );
        await env.DB.batch(
          chunks.map((chunk) =>
            env.DB.prepare("UPDATE chunks SET vector_id=? WHERE id=?").bind(
              chunk.id,
              chunk.id,
            ),
          ),
        );
        await env.DB.prepare(
          "INSERT INTO usage_events (id,scenario,provider_id,model,input_tokens,output_tokens,cached_tokens,cost_micros,currency,latency_ms,status,estimated,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            crypto.randomUUID(),
            "document_embedding",
            provider.id,
            provider.embedding_model,
            embedded.usage.inputTokens,
            0,
            0,
            0,
            "USD",
            Date.now() - started,
            "success",
            embedded.usage.estimated ? 1 : 0,
            crypto.randomUUID(),
            new Date().toISOString(),
          )
          .run();
      }
      await env.DB.prepare(
        "UPDATE documents SET status='indexed',ingestion_progress=100, parsed_text=?, chunk_count=?, error_message=NULL, updated_at=? WHERE id=?",
      )
        .bind(text, chunks.length, new Date().toISOString(), job.documentId)
        .run();
      await updateQueueRun(env,{id:runId,documentId:job.documentId,status:"completed",attempt,traceId,startedAt});
      await recordAdminTelemetry(env,{eventType:"queue_completed",scenario:"ingestion",traceId,durationMs:Date.now()-new Date(startedAt).getTime(),detail:{documentId:job.documentId,chunks:chunks.length,attempt}});
      message.ack();
    } catch (error) {
      const messageText=error instanceof Error?error.message:"Unknown error",
        queueStatus=attempt>=3?"dead_letter_risk":"retrying";
      await env.DB.prepare(
        "UPDATE documents SET status='failed',ingestion_progress=100, error_message=?, updated_at=? WHERE id=?",
      )
        .bind(
          messageText,
          new Date().toISOString(),
          job.documentId,
        )
        .run();
      await updateQueueRun(env,{id:runId,documentId:job.documentId,status:queueStatus,attempt,traceId,startedAt,error:messageText});
      await recordAdminTelemetry(env,{eventType:"queue_failed",severity:attempt>=3?"critical":"error",scenario:"ingestion",traceId,durationMs:Date.now()-new Date(startedAt).getTime(),detail:{documentId:job.documentId,attempt,error:messageText}});
      message.retry();
    }
  }
}
async function publishScheduledArticles(env: Env) {
  const now = new Date().toISOString(), articles = (await env.DB.prepare(
    "SELECT id,title,slug,excerpt,body,include_in_rag,document_id FROM articles WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at LIMIT 50",
  ).bind(now).all<any>()).results;
  for (const article of articles) {
    await env.DB.prepare("UPDATE articles SET status='published',published_at=COALESCE(published_at,scheduled_at,?),scheduled_at=NULL,updated_at=? WHERE id=?")
      .bind(now, now, article.id).run();
    const documentId = await syncArticleDocument(env, {
      ...article, status: "published", includeInRag: Boolean(article.include_in_rag), documentId: article.document_id,
    });
    await env.DB.prepare("UPDATE articles SET document_id=? WHERE id=?").bind(documentId, article.id).run();
  }
}
async function repairDocumentMetadata(env: Env) {
  const documents = (
    await env.DB.prepare(
      "SELECT id,r2_key,original_name,file_size,status,ingestion_progress,current_version FROM documents WHERE r2_key IS NOT NULL AND (file_size=0 OR original_name IS NULL OR original_name='' OR (status IN ('indexed','archived','failed','needs_ocr') AND ingestion_progress!=100)) LIMIT 200",
    ).all<{
      id: string;
      r2_key: string;
      original_name: string | null;
      file_size: number;
      status: string;
      ingestion_progress: number;
      current_version: number;
    }>()
  ).results;
  let repaired = 0,
    missing = 0;
  for (const document of documents) {
    const [object, version] = await Promise.all([
      env.ASSETS_BUCKET.head(document.r2_key),
      env.DB.prepare(
        "SELECT original_name,file_size FROM document_versions WHERE document_id=? ORDER BY version_number DESC LIMIT 1",
      )
        .bind(document.id)
        .first<{ original_name: string; file_size: number }>(),
    ]);
    if (!object) {
      missing += 1;
      continue;
    }
    const originalName =
        document.original_name ||
        version?.original_name ||
        document.r2_key.split("/").pop() ||
        "attachment",
      fileSize = object.size || version?.file_size || document.file_size || 0,
      progress = ["indexed", "archived", "failed", "needs_ocr"].includes(
        document.status,
      )
        ? 100
        : document.ingestion_progress;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE documents SET original_name=?,file_size=?,ingestion_progress=?,updated_at=updated_at WHERE id=?",
      ).bind(originalName, fileSize, progress, document.id),
      env.DB.prepare(
        "UPDATE document_versions SET original_name=?,file_size=? WHERE document_id=? AND version_number=?",
      ).bind(originalName, fileSize, document.id, document.current_version),
    ]);
    repaired += 1;
  }
  return { scanned: documents.length, repaired, missing };
}
export default {
  fetch: app.fetch,
  queue: consume,
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      Promise.all([publishScheduledArticles(env), repairDocumentMetadata(env),evaluateOperationalAlerts(env)]),
    );
  },
};
