import { Hono } from "hono";
import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from "@ai-bunshin/crypto";
import { createEmbedding, testChatConnection } from "@ai-bunshin/ai";
import { chunkText, createLocalEmbedding } from "@ai-bunshin/rag";
import { extractText, getDocumentProxy } from "unpdf";
import {
  articleSchema,
  agentSettingsSchema,
  categorySchema,
  providerSchema,
  profileSchema,
  simpleProviderSchema,
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
app.onError((error, c) => {
  console.error("Unhandled admin API error", error);
  return c.json(
    { error: "服务器处理失败，请稍后重试", code: "INTERNAL_ERROR" },
    500,
  );
});
app.use("/api/*", async (c, next) => {
  await next();
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
app.get("/api/admin/analytics/trends", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT substr(created_at,1,10) day,COUNT(*) requests,SUM(input_tokens+output_tokens+cached_tokens) tokens,SUM(cost_micros) cost_micros FROM usage_events WHERE created_at>=datetime('now','-30 days') GROUP BY substr(created_at,1,10) ORDER BY day",
      ).all()
    ).results,
  }),
);
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
        "SELECT articles.id,articles.title,articles.slug,articles.excerpt,articles.body,articles.category_id,articles.status,articles.include_in_rag,articles.published_at,articles.seo_description,articles.document_id,articles.created_at,articles.updated_at,categories.name category_name FROM articles LEFT JOIN categories ON categories.id=articles.category_id ORDER BY articles.updated_at DESC LIMIT 100",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/categories", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,name,slug,scope,description,sort_order FROM categories ORDER BY sort_order,name",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/documents", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT documents.id,documents.title,documents.source_type,documents.category_id,documents.visibility,documents.status,documents.r2_key,documents.chunk_count,documents.error_message,documents.purpose,documents.original_name,documents.file_size,documents.source_url,documents.archived_at,documents.created_at,documents.updated_at,categories.name category_name FROM documents LEFT JOIN categories ON categories.id=documents.category_id ORDER BY documents.updated_at DESC LIMIT 200",
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
app.post("/api/admin/articles", async (c) => {
  const parsed = articleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString(),
    id = crypto.randomUUID(),
    a = parsed.data;
  await c.env.DB.prepare(
    "INSERT INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,published_at,seo_description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
  await c.env.DB.prepare(
    "UPDATE articles SET title=?,slug=?,excerpt=?,body=?,category_id=?,status=?,include_in_rag=?,published_at=?,seo_description=?,updated_at=? WHERE id=?",
  ).bind(
    a.title, a.slug, a.excerpt, a.body, a.categoryId, a.status,
    a.includeInRag ? 1 : 0,
    a.status === "published" ? (existing.published_at ?? now) : existing.published_at,
    a.seoDescription || null, now, existing.id,
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
    "SELECT id,document_id FROM articles WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; document_id: string | null }>();
  if (!article) return c.json({ error: "文章不存在" }, 404);
  if (article.document_id) {
    await removeDocumentIndex(c.env, article.document_id);
    const document = await c.env.DB.prepare("SELECT r2_key FROM documents WHERE id=?")
      .bind(article.document_id).first<{ r2_key: string | null }>();
    if (document?.r2_key) await c.env.ASSETS_BUCKET.delete(document.r2_key);
    await c.env.DB.prepare("DELETE FROM documents WHERE id=?").bind(article.document_id).run();
  }
  await c.env.DB.prepare("DELETE FROM articles WHERE id=?").bind(article.id).run();
  await audit(c.env, c.req.raw, "article.delete", "article", article.id);
  return c.json({ ok: true });
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
    "INSERT INTO categories (id,name,slug,scope,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, parsed.data.name, parsed.data.slug, parsed.data.scope, now, now)
    .run();
  return c.json({ id }, 201);
});
app.delete("/api/admin/categories/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE articles SET category_id=NULL WHERE category_id=?").bind(id),
    c.env.DB.prepare("UPDATE documents SET category_id=NULL WHERE category_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM categories WHERE id=?").bind(id),
  ]);
  await audit(c.env, c.req.raw, "category.delete", "category", id);
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
    "INSERT INTO documents (id,title,source_type,category_id,visibility,status,r2_key,purpose,original_name,file_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
    "UPDATE documents SET status='uploaded',error_message=NULL,archived_at=NULL,updated_at=? WHERE id=?",
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
    "SELECT id,r2_key,purpose FROM documents WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; r2_key: string | null; purpose: string }>();
  if (!document) return c.json({ error: "文档不存在" }, 404);
  if (["profile", "article"].includes(document.purpose))
    return c.json({ error: "该文档由资料或文章生成，请在对应模块管理" }, 409);
  await removeDocumentIndex(c.env, document.id);
  if (document.r2_key) await c.env.ASSETS_BUCKET.delete(document.r2_key);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE profiles SET resume_document_id=NULL WHERE resume_document_id=?").bind(document.id),
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

async function consume(batch: MessageBatch<Job>, env: Env) {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await env.DB.prepare(
        "UPDATE documents SET status='parsing', updated_at=? WHERE id=?",
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
            "UPDATE documents SET status='needs_ocr', error_message='未检测到足够的可复制文字，可能是扫描版 PDF', updated_at=? WHERE id=?",
          )
            .bind(new Date().toISOString(), job.documentId)
            .run();
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
          "UPDATE documents SET status='archived',updated_at=? WHERE id=?",
        ).bind(new Date().toISOString(), job.documentId).run();
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
        await env.DB.prepare(
          "UPDATE documents SET status='embedding',updated_at=? WHERE id=?",
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
        "UPDATE documents SET status='indexed', parsed_text=?, chunk_count=?, error_message=NULL, updated_at=? WHERE id=?",
      )
        .bind(text, chunks.length, new Date().toISOString(), job.documentId)
        .run();
      message.ack();
    } catch (error) {
      await env.DB.prepare(
        "UPDATE documents SET status='failed', error_message=?, updated_at=? WHERE id=?",
      )
        .bind(
          error instanceof Error ? error.message : "Unknown error",
          new Date().toISOString(),
          job.documentId,
        )
        .run();
      message.retry();
    }
  }
}
export default { fetch: app.fetch, queue: consume };
