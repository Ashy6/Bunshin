import { Hono } from "hono";
import { encryptSecret } from "@ai-bunshin/crypto";
import { chunkText, createLocalEmbedding } from "@ai-bunshin/rag";
import { extractText, getDocumentProxy } from "unpdf";
import {
  articleSchema,
  categorySchema,
  providerSchema,
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
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Content-Type-Options", "nosniff");
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
  await next();
});
app.get("/api/admin/analytics/overview", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) requests, COALESCE(SUM(input_tokens+output_tokens+cached_tokens),0) tokens, COALESCE(SUM(cost_micros),0) cost FROM usage_events WHERE created_at >= datetime('now','start of month')",
  ).first();
  return c.json(row ?? { requests: 0, tokens: 0, cost: 0 });
});
app.get("/api/admin/articles", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,title,slug,status,updated_at FROM articles ORDER BY updated_at DESC LIMIT 100",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/categories", async (c) => c.json({ items: (await c.env.DB.prepare("SELECT id,name,slug,scope,description,sort_order FROM categories ORDER BY sort_order,name").all()).results }));
app.get("/api/admin/documents", async (c) => c.json({ items: (await c.env.DB.prepare("SELECT documents.id,documents.title,documents.source_type,documents.visibility,documents.status,documents.chunk_count,documents.error_message,documents.updated_at,categories.name category_name FROM documents LEFT JOIN categories ON categories.id=documents.category_id ORDER BY documents.updated_at DESC LIMIT 100").all()).results }));
app.get("/api/admin/providers", async (c) => c.json({ items: (await c.env.DB.prepare("SELECT id,name,kind,base_url,key_preview,chat_model,embedding_model,monthly_budget_micros,enabled,is_default,updated_at FROM providers ORDER BY updated_at DESC").all()).results }));
app.post("/api/admin/articles", async (c) => {
  const parsed = articleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString(),
    id = crypto.randomUUID(),
    a = parsed.data;
  await c.env.DB.prepare(
    "INSERT INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
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
      now,
      now,
    )
    .run();
  return c.json({ id }, 201);
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
      `${p.apiKey.slice(0, Math.min(4, Math.max(0, p.apiKey.length - 2)))}${"*".repeat(Math.max(4, p.apiKey.length - 6))}${p.apiKey.slice(-2)}`,
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
app.post("/api/admin/documents", async (c) => {
  const form = await c.req.formData(),
    file = form.get("file"),
    title = String(form.get("title") || "").trim(),
    categoryId = String(form.get("categoryId") || "") || null,
    visibility = String(form.get("visibility") || "rag_only");
  if (!(file instanceof File) || !title)
    return c.json({ error: "缺少文件或标题" }, 400);
  if (file.size > 20 * 1024 * 1024)
    return c.json({ error: "文件不能超过 20MB" }, 413);
  const allowed = new Set(["application/pdf", "text/plain", "text/markdown"]);
  if (!allowed.has(file.type))
    return c.json({ error: "不支持的文件类型" }, 415);
  const id = crypto.randomUUID(),
    r2Key = `documents/${id}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    now = new Date().toISOString();
  await c.env.ASSETS_BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  await c.env.DB.prepare(
    "INSERT INTO documents (id,title,source_type,category_id,visibility,status,r2_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      title,
      file.type.includes("pdf") ? "pdf" : "text",
      categoryId,
      visibility,
      "uploaded",
      r2Key,
      now,
      now,
    )
    .run();
  await c.env.INGESTION_QUEUE.send({
    type: "ingest",
    documentId: id,
    r2Key,
    mimeType: file.type,
  } satisfies Job);
  return c.json({ id, status: "uploaded" }, 202);
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
        const pdf = await getDocumentProxy(new Uint8Array(await object.arrayBuffer()), { maxImageSize: 16_777_216 });
        if (pdf.numPages > 100) throw new Error("PDF 页数不能超过 100 页");
        const extracted = await extractText(pdf, { mergePages: true });
        text = String(extracted.text).trim();
        if (text.length < 40) {
          await env.DB.prepare("UPDATE documents SET status='needs_ocr', error_message='未检测到足够的可复制文字，可能是扫描版 PDF', updated_at=? WHERE id=?").bind(new Date().toISOString(), job.documentId).run();
          message.ack();
          continue;
        }
      } else text = await object.text();
      const
        chunks = chunkText(text);
      await env.DB.prepare("DELETE FROM local_vectors WHERE document_id=?").bind(job.documentId).run();
      await env.DB.prepare("DELETE FROM chunks WHERE document_id=?").bind(job.documentId).run();
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
            "rag_only",
            String(chunk.text.length),
            new Date().toISOString(),
          ),
        ),
      );
      if (chunks.length) await env.DB.batch(chunks.map((chunk) => env.DB.prepare("INSERT INTO local_vectors (chunk_id,document_id,embedding_json,created_at) VALUES (?,?,?,?)").bind(chunk.id,job.documentId,JSON.stringify(createLocalEmbedding(chunk.text)),new Date().toISOString())));
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
