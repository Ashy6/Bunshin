import { Hono } from "hono";
import { html, raw } from "hono/html";
import { chatRequestSchema } from "@ai-bunshin/validation";
import { decryptSecret, type EncryptedSecret } from "@ai-bunshin/crypto";
import { createEmbedding, streamChat } from "@ai-bunshin/ai";
import {
  buildGroundedPrompt,
  cosineSimilarity,
  createLocalEmbedding,
} from "@ai-bunshin/rag";

type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
  VECTORIZE: VectorizeIndex;
  ASSETS_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_ORIGIN?: string;
  MASTER_ENCRYPTION_KEY: string;
};
const app = new Hono<{ Bindings: Bindings }>();
type AgentConfig = {
  enabled: boolean;
  dailyLimit: number;
  minuteLimit: number;
  globalDailyLimit: number;
  welcomeMessage: string;
  systemInstruction: string;
};
const defaultAgentConfig: AgentConfig = {
  enabled: true,
  dailyLimit: 25,
  minuteLimit: 5,
  globalDailyLimit: 500,
  welcomeMessage:
    "你好，我是站长的个人分身。你可以问我有关经历、项目和文章的问题。",
  systemInstruction: "请简洁、准确地依据知识库回答。",
};
async function agentConfig(env: Bindings) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='agent_config'",
  ).first<{ value: string }>();
  if (!row) return defaultAgentConfig;
  try {
    return { ...defaultAgentConfig, ...JSON.parse(row.value) } as AgentConfig;
  } catch {
    return defaultAgentConfig;
  }
}
function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("Cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}
async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function visitorIdentity(request: Request, env: Bindings) {
  const existing = cookieValue(request, "bunshin_visitor"),
    id =
      existing && /^[a-f0-9-]{36}$/.test(existing)
        ? existing
        : crypto.randomUUID(),
    ip = request.headers.get("CF-Connecting-IP") ?? "local",
    hash = await sha256Text(`${env.MASTER_ENCRYPTION_KEY}:${id}:${ip}`);
  return {
    hash,
    setCookie: existing
      ? null
      : `bunshin_visitor=${id}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`,
  };
}
function shanghaiParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minute: `${get("year")}-${get("month")}-${get("day")}-${get("hour")}-${get("minute")}`,
  };
}
async function incrementLimit(
  env: Bindings,
  visitorHash: string,
  bucket: string,
  limit: number,
  expiresAt: string,
) {
  const row = await env.DB.prepare(
    "INSERT INTO rate_limit_buckets (visitor_hash,bucket,count,expires_at,updated_at) VALUES (?,?,1,?,?) ON CONFLICT(visitor_hash,bucket) DO UPDATE SET count=count+1,updated_at=excluded.updated_at WHERE count<? RETURNING count",
  )
    .bind(visitorHash, bucket, expiresAt, new Date().toISOString(), limit)
    .first<{ count: number }>();
  return row?.count ?? null;
}
async function releaseLimit(
  env: Bindings,
  visitorHash: string,
  bucket: string,
) {
  await env.DB.prepare(
    "UPDATE rate_limit_buckets SET count=MAX(0,count-1),updated_at=? WHERE visitor_hash=? AND bucket=?",
  )
    .bind(new Date().toISOString(), visitorHash, bucket)
    .run();
}
async function reserveAgentQuota(
  env: Bindings,
  visitorHash: string,
  config: AgentConfig,
) {
  const parts = shanghaiParts(),
    expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    buckets = [
      { hash: visitorHash, name: `day:${parts.day}`, limit: config.dailyLimit },
      {
        hash: visitorHash,
        name: `minute:${parts.minute}`,
        limit: config.minuteLimit,
      },
      {
        hash: "__global__",
        name: `day:${parts.day}`,
        limit: config.globalDailyLimit,
      },
    ],
    reserved: Array<{ hash: string; name: string }> = [];
  for (const bucket of buckets) {
    const count = await incrementLimit(
      env,
      bucket.hash,
      bucket.name,
      bucket.limit,
      expires,
    );
    if (count === null) {
      await Promise.all(
        reserved.map((item) => releaseLimit(env, item.hash, item.name)),
      );
      return {
        ok: false as const,
        reason: bucket.name.startsWith("minute:")
          ? "请求过于频繁，请一分钟后再试"
          : bucket.hash === "__global__"
            ? "今日全站问答额度已用完"
            : `你今天的 ${config.dailyLimit} 次问答额度已用完`,
      };
    }
    reserved.push({ hash: bucket.hash, name: bucket.name });
  }
  return {
    ok: true as const,
    remaining: Math.max(
      0,
      config.dailyLimit -
        (await env.DB.prepare(
          "SELECT count FROM rate_limit_buckets WHERE visitor_hash=? AND bucket=?",
        )
          .bind(visitorHash, `day:${parts.day}`)
          .first<{ count: number }>())!.count,
    ),
    release: () =>
      Promise.all(
        reserved.map((item) => releaseLimit(env, item.hash, item.name)),
      ),
  };
}
function renderSafeMarkdown(markdown: string) {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return raw(
    markdown
      .split(/\n{2,}/)
      .map((block) => {
        const value = escape(block.trim());
        if (value.startsWith("### ")) return `<h3>${value.slice(4)}</h3>`;
        if (value.startsWith("## ")) return `<h2>${value.slice(3)}</h2>`;
        if (value.startsWith("# ")) return `<h1>${value.slice(2)}</h1>`;
        if (value.split("\n").every((line) => line.startsWith("- ")))
          return `<ul>${value
            .split("\n")
            .map((line) => `<li>${line.slice(2)}</li>`)
            .join("")}</ul>`;
        return `<p>${value.replaceAll("\n", "<br>")}</p>`;
      })
      .join(""),
  );
}

const demoArticles = [
  {
    slug: "building-a-personal-ai-twin",
    title: "如何构建可信的个人 AI 分身",
    excerpt:
      "从个人资料、文章和项目中建立可追溯的知识库，让回答有依据，也知道什么时候应该说不知道。",
    date: "2026/11/24",
    category: "AI 与 Agent",
    tags: ["RAG", "Agent"],
  },
  {
    slug: "knowledge-that-compounds",
    title: "让知识持续复利：我的记录与整理方法",
    excerpt: "把零散笔记转化为可检索、可引用、可继续演进的知识资产。",
    date: "2026/11/18",
    category: "知识管理",
    tags: ["写作", "知识库"],
  },
  {
    slug: "engineering-notes",
    title: "从产品想法到可维护的工程",
    excerpt:
      "用清晰边界、渐进交付和可观测性，将一个个人项目做成真正可长期运行的系统。",
    date: "2026/11/05",
    category: "工程实践",
    tags: ["架构", "Cloudflare"],
  },
];

type PublicNav = "home" | "ask" | "articles" | "categories" | "archives" | "about";
function navIcon(name: PublicNav) {
  const path = {
    home: html`<path d="M3 10.5 10 4l7 6.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5z"/><path d="M8 18v-5h4v5"/>`,
    ask: html`<circle cx="10" cy="10" r="7"/><path d="M7.5 8.5h.01M12.5 8.5h.01M7.5 12c1.5 1.2 3.5 1.2 5 0"/>`,
    articles: html`<path d="M5 3h10a2 2 0 0 1 2 2v12H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 7h6M7 10h6M7 13h4"/>`,
    categories: html`<path d="M4 5h5l1.5 2H16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>`,
    archives: html`<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.8 1.8"/>`,
    about: html`<circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/>`,
  }[name];
  return html`<svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function layout(
  title: string,
  content: ReturnType<typeof html>,
  description = "个人简历、文章与 AI 分身",
  active: PublicNav = "home",
) {
  const pageLabel =
    active === "home"
      ? ""
      : ({
          ask: "问问分身",
          articles: "文章",
          categories: "分类",
          archives: "归档",
          about: "关于",
        } as const)[active];
  return html`<!doctype html>
    <html lang="zh-CN" data-theme="system">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title}</title>
        <meta name="description" content="${description}" />
        <link rel="canonical" href="/" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${description}" />
        <meta property="og:type" content="website" />
        <link rel="stylesheet" href="/styles.css" />
        <style>
          .avatar {
            overflow: hidden;
          }
          .avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .agent-meta {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            margin-top: 9px;
            color: var(--muted);
            font-size: 12px;
          }
          .ask-form button:disabled,
          .ask-form textarea:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .answer-sources {
            margin-top: 10px;
            padding: 12px 16px;
            border: 1px solid var(--line);
            border-radius: 10px;
            color: var(--muted);
            font-size: 12px;
          }
          .answer-sources strong {
            color: var(--text);
          }
          .answer-sources ul {
            margin: 6px 0 0;
            padding-left: 18px;
          }
        </style>
        <script type="application/ld+json">
          ${JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Person",
            name: "你的名字",
            url: "/",
            description,
          })}
        </script>
      </head>
      <body>
        <aside class="sidebar">
          <div class="profile">
            <div class="avatar"><img src="/avatar" alt="站长头像" /></div>
            <a class="site-title" id="profile-name" href="/">Bunshin</a>
            <p id="profile-headline">保持好奇，持续构建</p>
          </div>
          <nav aria-label="主导航">
            <a class=${active === "home" ? "active" : ""} href="/">${navIcon("home")}<span>首页</span></a
            ><a class=${active === "ask" ? "active" : ""} href="/#ask">${navIcon("ask")}<span>问问分身</span></a
            ><a class=${active === "articles" ? "active" : ""} href="/#articles">${navIcon("articles")}<span>文章</span></a
            ><a class=${active === "categories" ? "active" : ""} href="/categories">${navIcon("categories")}<span>分类</span></a
            ><a class=${active === "archives" ? "active" : ""} href="/archives">${navIcon("archives")}<span>归档</span></a
            ><a class=${active === "about" ? "active" : ""} href="/about">${navIcon("about")}<span>关于</span></a>
          </nav>
          <div class="sidebar-foot">
            <button id="theme-toggle" aria-label="切换主题">◐</button
            ><a href="https://github.com/Ashy6" rel="noreferrer">GitHub</a>
          </div>
        </aside>
        <div class="page">
          <header class="topbar">
            <button id="menu-toggle" aria-label="打开菜单">☰</button
            ><span id="page-title" data-page-label=${pageLabel}>${title}</span
            ><button id="search-toggle" aria-label="搜索">⌕</button>
          </header>
          <main>${content}</main>
          <footer>
            © ${new Date().getFullYear()} Bunshin · 内容由站长维护，AI
            回答请以引用来源为准。
          </footer>
        </div>
        <script src="/profile.js" defer></script>
        <script src="/agent.js" defer></script>
      </body>
    </html>`;
}

app.get("/", (c) =>
  c.html(
    layout(
      "Bunshin · 个人分身",
      html`<section class="hero" id="ask">
          <p class="eyebrow">AI PERSONAL TWIN</p>
          <h1>下午好，想了解我的经历，<br />或找某个话题的文章？</h1>
          <form id="ask-form" class="ask-form">
            <textarea
              id="ask-input"
              rows="1"
              maxlength="1000"
              placeholder="在这里问我，例如：你做过哪些代表项目？"
            ></textarea
            ><button type="submit" aria-label="发送">↑</button>
          </form>
          <div class="agent-meta">
            <span id="agent-status">正在读取 Agent 状态…</span
            ><span id="agent-quota"></span>
          </div>
          <div id="answer" class="answer" hidden></div>
          <div id="answer-sources" class="answer-sources" hidden></div>
          <div class="suggestions">
            <button>介绍一下你的核心经历</button
            ><button>你如何设计 RAG 系统？</button
            ><button>有哪些代表文章？</button>
          </div>
        </section>
        <section id="articles" class="section">
          <div class="section-title">
            <h2>最近文章</h2>
            <a href="/archives">查看归档 →</a>
          </div>
          <div class="article-list">
            ${demoArticles.map(
              (article) =>
                html`<article>
                  <a href="/articles/${article.slug}"
                    ><h3>${article.title}</h3>
                    <p>${article.excerpt}</p>
                    <div class="meta">
                      <time>${article.date}</time
                      ><span>${article.category}</span>
                    </div></a
                  >
                </article>`,
            )}
          </div>
        </section>
        <aside class="right-panel">
          <section>
            <h2>最近更新</h2>
            ${demoArticles.map(
              (article) =>
                html`<a href="/articles/${article.slug}">${article.title}</a>`,
            )}
          </section>
          <section>
            <h2>热门标签</h2>
            <div class="tag-list">
              <span>RAG</span><span>Agent</span><span>架构</span
              ><span>Cloudflare</span><span>知识管理</span>
            </div>
          </section>
        </aside>`,
    ),
  ),
);

app.get("/articles/:slug", (c) => {
  const article = demoArticles.find(
    (item) => item.slug === c.req.param("slug"),
  );
  if (!article) return c.notFound();
  return c.html(
    layout(
      `${article.title} · Bunshin`,
      html`<article class="post">
        <a class="back" href="/">← 返回首页</a>
        <h1>${article.title}</h1>
        <div class="post-meta">
          <time>${article.date}</time><span>${article.category}</span>
        </div>
        <p class="lead">${article.excerpt}</p>
        <h2>从内容开始，而不是从模型开始</h2>
        <p>
          一个可信的个人分身，首先需要明确、结构化并且能够持续更新的资料。模型负责表达，知识库负责事实边界。
        </p>
        <blockquote>
          当资料不足时，系统应该诚实地说不知道，而不是用流畅的语言补全不存在的经历。
        </blockquote>
        <h2>可追溯的回答</h2>
        <p>
          每个关键事实都应该关联到简历条目、项目说明或公开文章，让访客能够继续核实和阅读。
        </p>
      </article>`,
      article.excerpt,
      "articles",
    ),
  );
});

app.get("/categories", (c) =>
  c.html(
    layout(
      "分类 · Bunshin",
      html`<section class="listing">
        <h1>分类</h1>
        <div class="category-grid">
          ${["AI 与 Agent", "知识管理", "工程实践"].map(
            (name, index) =>
              html`<a href="/?category=${index}"
                ><strong>${name}</strong><span>${index + 1} 篇文章</span></a
              >`,
          )}
        </div>
      </section>`,
      "文章分类",
      "categories",
    ),
  ),
);
app.get("/archives", (c) =>
  c.html(
    layout(
      "归档 · Bunshin",
      html`<section class="listing">
        <h1>文章归档</h1>
        ${demoArticles.map(
          (article) =>
            html`<a class="archive-row" href="/articles/${article.slug}"
              ><time>${article.date}</time><span>${article.title}</span></a
            >`,
        )}
      </section>`,
      "文章归档",
      "archives",
    ),
  ),
);
app.get("/about", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT display_name,headline,bio,location,markdown_bio,skills_json,social_json FROM profiles WHERE published=1 ORDER BY created_at LIMIT 1",
  ).first<{
    display_name: string;
    headline: string;
    bio: string;
    location: string | null;
    markdown_bio: string;
    skills_json: string;
    social_json: string;
  }>();
  return c.html(
    layout(
      "关于 · Bunshin",
      html`<section class="post">
        <h1>${profile?.display_name ?? "关于我"}</h1>
        ${profile?.headline
          ? html`<p class="lead">${profile.headline}</p>`
          : ""}
        ${profile?.bio ? html`<p>${profile.bio}</p>` : ""}
        ${profile?.markdown_bio
          ? renderSafeMarkdown(profile.markdown_bio)
          : html`<p>个人资料尚未完善。</p>`}
        ${profile?.skills_json
          ? html`<h2>技能</h2>
              <div class="tag-list">
                ${(JSON.parse(profile.skills_json) as string[]).map(
                  (skill) => html`<span>${skill}</span>`,
                )}
              </div>`
          : ""}
      </section>`,
      "个人介绍",
      "about",
    ),
  );
});

app.get("/api/profile", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT display_name,headline,bio,location,skills_json,social_json,updated_at FROM profiles WHERE published=1 ORDER BY created_at LIMIT 1",
  ).first();
  return c.json({ profile: profile ?? null }, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/api/agent/status", async (c) => {
  const [config, provider, documents, visitor] = await Promise.all([
    agentConfig(c.env),
    c.env.DB.prepare(
      "SELECT id,health_status,monthly_budget_micros,(SELECT COALESCE(SUM(cost_micros),0) FROM usage_events WHERE provider_id=providers.id AND created_at>=datetime('now','start of month')) month_spent_micros FROM providers WHERE enabled=1 AND is_default=1 LIMIT 1",
    ).first<{
      health_status: string;
      monthly_budget_micros: number;
      month_spent_micros: number;
    }>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) count FROM documents WHERE status='indexed' AND visibility!='private'",
    ).first<{ count: number }>(),
    visitorIdentity(c.req.raw, c.env),
  ]);
  const parts = shanghaiParts(),
    usage = await c.env.DB.prepare(
      "SELECT count FROM rate_limit_buckets WHERE visitor_hash=? AND bucket=?",
    )
      .bind(visitor.hash, `day:${parts.day}`)
      .first<{ count: number }>(),
    ready = Boolean(
      config.enabled &&
        provider?.health_status === "healthy" &&
        (provider.monthly_budget_micros === 0 ||
          provider.month_spent_micros < provider.monthly_budget_micros) &&
        (documents?.count ?? 0) > 0,
    );
  if (visitor.setCookie) c.header("Set-Cookie", visitor.setCookie);
  return c.json(
    {
      enabled: config.enabled,
      ready,
      remaining: Math.max(0, config.dailyLimit - (usage?.count ?? 0)),
      dailyLimit: config.dailyLimit,
      welcomeMessage: config.welcomeMessage,
      reason: !config.enabled
        ? "站长暂时关闭了 Agent 问答"
        : provider?.health_status !== "healthy"
          ? "模型渠道尚未完成验证"
          : provider.monthly_budget_micros > 0 &&
              provider.month_spent_micros >= provider.monthly_budget_micros
            ? "本月模型预算已用完"
            : (documents?.count ?? 0) === 0
              ? "知识库尚未准备完成"
              : null,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

app.post("/api/chat", async (c) => {
  const parsed = chatRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "问题格式不正确" }, 400);
  const question = parsed.data.message,
    config = await agentConfig(c.env),
    visitor = await visitorIdentity(c.req.raw, c.env);
  const provider = await c.env.DB.prepare(
    "SELECT id,base_url,encrypted_api_key,chat_model,embedding_model,embedding_mode,health_status,input_price_micros,output_price_micros,monthly_budget_micros,(SELECT COALESCE(SUM(cost_micros),0) FROM usage_events WHERE provider_id=providers.id AND created_at>=datetime('now','start of month')) month_spent_micros FROM providers WHERE enabled=1 ORDER BY is_default DESC,updated_at DESC LIMIT 1",
  ).first<{
    id: string;
    base_url: string;
    encrypted_api_key: string;
    chat_model: string;
    embedding_model: string;
    embedding_mode: string;
    health_status: string;
    input_price_micros: number;
    output_price_micros: number;
    monthly_budget_micros: number;
    month_spent_micros: number;
  }>();
  const readyDocuments = await c.env.DB.prepare(
    "SELECT COUNT(*) count FROM documents WHERE status='indexed' AND visibility!='private'",
  ).first<{ count: number }>();
  if (
    !config.enabled ||
    provider?.health_status !== "healthy" ||
    (provider.monthly_budget_micros > 0 &&
      provider.month_spent_micros >= provider.monthly_budget_micros) ||
    (readyDocuments?.count ?? 0) === 0
  )
    return c.json(
      { error: "Agent 尚未就绪，请稍后再试" },
      503,
      visitor.setCookie ? { "Set-Cookie": visitor.setCookie } : undefined,
    );
  let apiKey: string | null = null;
  if (provider)
    apiKey = await decryptSecret(
      JSON.parse(provider.encrypted_api_key) as EncryptedSecret,
      c.env.MASTER_ENCRYPTION_KEY,
    );
  let contexts: Array<{
    id: string;
    content: string;
    title: string;
    score: number;
  }> = [];
  if (provider?.embedding_mode === "provider" && apiKey) {
    const started = Date.now();
    const embedded = await createEmbedding(
      { baseUrl: provider.base_url, apiKey, model: provider.embedding_model },
      [question],
    );
    const matches = await c.env.VECTORIZE.query(embedded.vectors[0]!, {
      topK: 5,
    });
    const ids = matches.matches.map((match) => match.id);
    if (ids.length) {
      const rows = (
        await c.env.DB.prepare(
          `SELECT chunks.id,chunks.content,documents.title FROM chunks JOIN documents ON documents.id=chunks.document_id WHERE chunks.id IN (${ids.map(() => "?").join(",")}) AND documents.status='indexed' AND documents.visibility!='private'`,
        )
          .bind(...ids)
          .all<{ id: string; content: string; title: string }>()
      ).results;
      const scores = new Map(
        matches.matches.map((match) => [match.id, match.score]),
      );
      contexts = rows
        .map((row) => ({ ...row, score: scores.get(row.id) ?? 0 }))
        .sort((a, b) => b.score - a.score);
    }
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        "INSERT INTO usage_events (id,scenario,provider_id,model,input_tokens,output_tokens,cached_tokens,cost_micros,currency,latency_ms,status,estimated,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          "query_embedding",
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
        .run(),
    );
  } else {
    const rows = (
      await c.env.DB.prepare(
        "SELECT chunks.id,chunks.content,documents.title,local_vectors.embedding_json FROM local_vectors JOIN chunks ON chunks.id=local_vectors.chunk_id JOIN documents ON documents.id=chunks.document_id WHERE documents.status='indexed' AND documents.visibility!='private' LIMIT 1000",
      ).all<{
        id: string;
        content: string;
        title: string;
        embedding_json: string;
      }>()
    ).results;
    const query = createLocalEmbedding(question);
    contexts = rows
      .map((row) => ({
        ...row,
        score: cosineSimilarity(
          query,
          JSON.parse(row.embedding_json) as number[],
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .filter((row) => row.score > 0);
  }
  const enc = new TextEncoder();
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    ...(visitor.setCookie ? { "Set-Cookie": visitor.setCookie } : {}),
  };
  if (!contexts.length) {
    return new Response(
      `data: ${JSON.stringify({ type: "delta", text: "现有资料中没有相关信息。请先在后台上传简历、文章或知识文档。" })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
      { headers },
    );
  }
  const quota = await reserveAgentQuota(c.env, visitor.hash, config);
  if (!quota.ok)
    return c.json(
      { error: quota.reason },
      429,
      visitor.setCookie ? { "Set-Cookie": visitor.setCookie } : undefined,
    );
  if (!provider) {
    const evidence = contexts
      .map((item, index) => `[${index + 1}] ${item.title}：${item.content}`)
      .join("\n\n");
    return new Response(
      `data: ${JSON.stringify({ type: "delta", text: `已找到以下相关资料（尚未配置模型渠道，因此展示检索结果）：\n\n${evidence}` })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
      { headers },
    );
  }
  try {
    if (!apiKey) throw new Error("Provider key unavailable");
    const chatStarted = Date.now();
    const upstream = await streamChat(
      { baseUrl: provider.base_url, apiKey, model: provider.chat_model },
      [
        {
          role: "system",
          content:
            buildGroundedPrompt(
              question,
              contexts.map((item) => ({
                title: item.title,
                text: item.content,
              })),
            ) + `\n\n附加要求：${config.systemInstruction}`,
        },
        { role: "user", content: question },
      ],
    );
    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body!.getReader(),
          decoder = new TextDecoder();
        let buffer = "",
          outputChars = 0,
          providerInputTokens = 0,
          providerOutputTokens = 0;
        try {
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ type: "sources", items: contexts.map((item) => ({ title: item.title, score: item.score })) })}\n\n`,
            ),
          );
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (raw === "[DONE]") continue;
              try {
                const event = JSON.parse(raw) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                  usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                  };
                };
                if (event.usage) {
                  providerInputTokens = event.usage.prompt_tokens ?? 0;
                  providerOutputTokens = event.usage.completion_tokens ?? 0;
                }
                const text = event.choices?.[0]?.delta?.content;
                if (text) {
                  outputChars += text.length;
                  controller.enqueue(
                    enc.encode(
                      `data: ${JSON.stringify({ type: "delta", text })}\n\n`,
                    ),
                  );
                }
              } catch {}
            }
          }
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ type: "done", remaining: quota.remaining })}\n\n`,
            ),
          );
          const estimatedInput = Math.ceil(
              (question.length +
                contexts.reduce((sum, item) => sum + item.content.length, 0)) /
                3,
            ),
            inputTokens = providerInputTokens || estimatedInput,
            outputTokens = providerOutputTokens || Math.ceil(outputChars / 3),
            costMicros = Math.ceil(
              (inputTokens * provider.input_price_micros +
                outputTokens * provider.output_price_micros) /
                1_000_000,
            );
          c.executionCtx.waitUntil(
            c.env.DB.prepare(
              "INSERT INTO usage_events (id,scenario,provider_id,model,input_tokens,output_tokens,cached_tokens,cost_micros,currency,latency_ms,status,estimated,visitor_hash,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
              .bind(
                crypto.randomUUID(),
                "chat",
                provider.id,
                provider.chat_model,
                inputTokens,
                outputTokens,
                0,
                costMicros,
                "USD",
                Date.now() - chatStarted,
                "success",
                providerInputTokens > 0 ? 0 : 1,
                visitor.hash,
                crypto.randomUUID(),
                new Date().toISOString(),
              )
              .run(),
          );
          controller.close();
        } catch {
          await quota.release();
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ type: "error", text: "模型响应中断" })}\n\n`,
            ),
          );
          controller.close();
        }
      },
    });
    return new Response(stream, { headers });
  } catch (error) {
    await quota.release();
    return new Response(
      `data: ${JSON.stringify({ type: "error", text: "模型渠道暂时不可用，请稍后重试。" })}\n\n`,
      { status: 502, headers },
    );
  }
});

app.get("/robots.txt", (c) =>
  c.text("User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: /sitemap.xml\n"),
);
app.get("/avatar", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT display_name,avatar_url FROM profiles WHERE published=1 ORDER BY created_at LIMIT 1",
  ).first<{ display_name: string; avatar_url: string | null }>();
  if (profile?.avatar_url?.startsWith("r2://")) {
    const object = await c.env.ASSETS_BUCKET.get(profile.avatar_url.slice(5));
    if (object)
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
  }
  const initial = Array.from(profile?.display_name?.trim() || "B")[0] ?? "B";
  const safeInitial = initial
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  return c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#31516f"/><stop offset="1" stop-color="#7899b5"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="64" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="44" font-weight="700" fill="white">${safeInitial}</text></svg>`,
    200,
    {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=60",
    },
  );
});
app.get("/sitemap.xml", (c) =>
  c.body(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url>${demoArticles.map((a) => `<url><loc>/articles/${a.slug}</loc></url>`).join("")}</urlset>`,
    200,
    { "Content-Type": "application/xml" },
  ),
);
app.get("/llms.txt", (c) =>
  c.text(
    "# Bunshin\n\n个人简历、文章与 AI 分身。\n\n- /about: 个人介绍\n- /archives: 文章归档\n",
  ),
);
app.get("/health", (c) => c.json({ ok: true, service: "web" }));
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.includes(".")) return c.env.ASSETS.fetch(c.req.raw);
  return c.notFound();
});
export default app;
