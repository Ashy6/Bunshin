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
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const inline = (value: string) =>
    escape(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  const lines = markdown.replaceAll("\\n", "\n").replace(/\r/g, "").split("\n"), output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = escape(line.slice(3).trim());
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) code.push(lines[index++]!);
      index += 1;
      output.push(`<pre><code${language ? ` data-language="${language}"` : ""}>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { const level = heading[1]!.length; output.push(`<h${level}>${inline(heading[2]!)}</h${level}>`); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) parts.push(lines[index++]!.replace(/^>\s?/, ""));
      output.push(`<blockquote>${inline(parts.join("<br>"))}</blockquote>`); continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index]!)) items.push(`<li>${inline(lines[index++]!.replace(/^[-*+]\s+/, ""))}</li>`);
      output.push(`<ul>${items.join("")}</ul>`); continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index]!)) items.push(`<li>${inline(lines[index++]!.replace(/^\d+[.)]\s+/, ""))}</li>`);
      output.push(`<ol>${items.join("")}</ol>`); continue;
    }
    if (/^---+$/.test(line.trim())) { output.push("<hr>"); index += 1; continue; }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,4})\s|^```|^>\s?|^[-*+]\s+|^\d+[.)]\s+/.test(lines[index]!)) paragraph.push(lines[index++]!);
    output.push(`<p>${inline(paragraph.join("\n")).replaceAll("\n", "<br>")}</p>`);
  }
  return raw(output.join(""));
}
type PublicProfile = {
  display_name: string; headline: string; bio: string; location: string | null;
  avatar_url: string | null; social_json: string; markdown_bio: string;
  skills_json: string; website_url: string | null; public_email: string | null;
  experience_json: string; project_json: string; education_json: string;
  avatar_position_x: number; avatar_position_y: number; updated_at: string;
};
type PublicArticle = {
  id: string; title: string; slug: string; excerpt: string; body: string;
  category_id: string | null; category_name: string | null; category_slug: string | null;
  published_at: string | null; updated_at: string; seo_description: string | null;
};
const parseJson = <T,>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
async function publicProfile(env: Bindings) {
  return env.DB.prepare(
    "SELECT display_name,headline,bio,location,avatar_url,social_json,markdown_bio,skills_json,website_url,public_email,experience_json,project_json,education_json,avatar_position_x,avatar_position_y,updated_at FROM profiles WHERE published=1 ORDER BY created_at LIMIT 1",
  ).first<PublicProfile>();
}
async function publicArticles(env: Bindings, categorySlug?: string | null) {
  const sql = `SELECT articles.id,articles.title,articles.slug,articles.excerpt,articles.body,articles.category_id,articles.published_at,articles.updated_at,articles.seo_description,categories.name category_name,categories.slug category_slug FROM articles LEFT JOIN categories ON categories.id=articles.category_id WHERE articles.status='published'${categorySlug ? " AND categories.slug=?" : ""} ORDER BY COALESCE(articles.published_at,articles.updated_at) DESC`;
  return (categorySlug ? await env.DB.prepare(sql).bind(categorySlug).all<PublicArticle>() : await env.DB.prepare(sql).all<PublicArticle>()).results;
}
function formatDate(value: string | null | undefined) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value));
}
function articleBodyWithoutDuplicateTitle(body: string, title: string) {
  const normalized = body.replaceAll("\\n", "\n");
  const [first, ...rest] = normalized.split("\n");
  return first?.trim() === `# ${title}` ? rest.join("\n").trimStart() : normalized;
}

type PublicNav = "ask" | "articles" | "categories" | "archives" | "about";
function navIcon(name: PublicNav) {
  const path = {
    ask: html`<circle cx="10" cy="10" r="7"/><path d="M7.5 8.5h.01M12.5 8.5h.01M7.5 12c1.5 1.2 3.5 1.2 5 0"/>`,
    articles: html`<path d="M5 3h10a2 2 0 0 1 2 2v12H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 7h6M7 10h6M7 13h4"/>`,
    categories: html`<path d="M4 5h5l1.5 2H16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>`,
    archives: html`<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.8 1.8"/>`,
    about: html`<circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/>`,
  }[name];
  return html`<svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function publicNav(active: PublicNav, className = "") {
  const items: Array<{ id: PublicNav; href: string; label: string }> = [
    { id: "ask", href: "/", label: "问问分身" },
    { id: "articles", href: "/articles", label: "文章" },
    { id: "categories", href: "/categories", label: "分类" },
    { id: "archives", href: "/archives", label: "归档" },
    { id: "about", href: "/about", label: "关于" },
  ];
  return html`<nav class=${className} aria-label="主导航">
    ${items.map((item) => html`<a data-nav=${item.id} class=${active === item.id ? "active" : "nav-link"} href=${item.href}>${navIcon(item.id)}<span>${item.label}</span></a>`)}
  </nav>`;
}

function layout(
  title: string,
  content: ReturnType<typeof html>,
  description = "个人简历、文章与 AI 分身",
  active: PublicNav = "ask",
  profile: PublicProfile | null = null,
  origin = "",
  canonicalPath = "/",
  article?: PublicArticle,
) {
  const pageLabel =
    active === "ask"
      ? ""
      : ({
          articles: "文章",
          categories: "分类",
          archives: "归档",
          about: "关于",
        } as const)[active];
  const ownerName = profile?.display_name || "个人分身",
    siteTitle = `${ownerName}-AI分身`,
    social = parseJson<Record<string, string>>(profile?.social_json, {}),
    canonical = `${origin}${canonicalPath}`,
    personLd = {
      "@context": "https://schema.org", "@type": "Person", name: ownerName,
      url: `${origin}/`, description: profile?.bio || description,
      jobTitle: profile?.headline || undefined,
      homeLocation: profile?.location || undefined,
      sameAs: [profile?.website_url, ...Object.values(social)].filter((value) => value?.startsWith("http")),
    },
    structuredData = article ? [personLd, {
      "@context": "https://schema.org", "@type": "Article", headline: article.title,
      description: article.seo_description || article.excerpt, datePublished: article.published_at,
      dateModified: article.updated_at, mainEntityOfPage: canonical,
      author: { "@type": "Person", name: ownerName },
    }, {
      "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "首页", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: "文章", item: `${origin}/articles` },
        { "@type": "ListItem", position: 3, name: article.title, item: canonical },
      ],
    }] : [personLd, { "@context": "https://schema.org", "@type": "WebSite", name: siteTitle, url: `${origin}/`, description }];
  return html`<!doctype html>
    <html lang="zh-CN" data-theme="system">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title}</title>
        <meta name="description" content="${description}" />
        <link rel="canonical" href=${canonical} />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${description}" />
        <meta property="og:type" content=${article ? "article" : "website"} />
        <meta property="og:url" content=${canonical} />
        <meta name="author" content=${ownerName} />
        <link rel="stylesheet" href="/styles.css?v=20261126.2" />
        <style>
          /* Critical shell styles keep navigation usable if the external stylesheet is delayed. */
          * { box-sizing: border-box; }
          body { margin: 0; }
          .desktop-header { display: none; }
          .page { min-height: 100vh; }
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
          .answer-sources ul { margin: 6px 0 0; padding-left: 18px; }
          @media (min-width: 1200px) {
            .sidebar, .topbar { display: none !important; }
            .desktop-header { display: flex; }
            .page { margin-left: 0 !important; }
          }
        </style>
        <script type="application/ld+json">
          ${raw(JSON.stringify(structuredData).replaceAll("<", "\\u003c"))}
        </script>
      </head>
      <body>
        <header class="desktop-header">
          <a class="desktop-brand" href="/">
            <img src="/avatar" alt="" style=${`object-position:${profile?.avatar_position_x ?? 50}% ${profile?.avatar_position_y ?? 50}%`} />
            <span><strong>${ownerName}</strong><small>AI 分身</small></span>
          </a>
          ${publicNav(active, "desktop-nav")}
          <div class="desktop-actions">
            ${social.github ? html`<a href=${social.github} rel="noreferrer" target="_blank">GitHub</a>` : ""}
            <button data-theme-toggle aria-label="切换主题">◐</button>
          </div>
        </header>
        <aside class="sidebar">
          <div class="profile">
            <div class="avatar"><img src="/avatar" alt=${`${ownerName}的头像`} style=${`object-position:${profile?.avatar_position_x ?? 50}% ${profile?.avatar_position_y ?? 50}%`} /></div>
            <a class="site-title" id="profile-name" href="/">${ownerName}</a>
            <p id="profile-headline">${profile?.headline || "个人资料暂未公开"}</p>
          </div>
          ${publicNav(active)}
          <div class="sidebar-foot">
            <button data-theme-toggle aria-label="切换主题">◐</button
            >${social.github ? html`<a href=${social.github} rel="noreferrer">GitHub</a>` : ""}
          </div>
        </aside>
        <div class="page">
          <header class="topbar">
            <button id="menu-toggle" aria-label="打开菜单">☰</button
            ><span id="page-title" data-page-label=${pageLabel}>${title}</span
            ><button id="search-toggle" aria-label="搜索">⌕</button>
          </header>
          <main class=${active === "ask" ? "agent-main" : ""}>${content}</main>
          <footer>
            © ${new Date().getFullYear()} ${ownerName} · 内容由站长维护，AI
            回答请以引用来源为准。
          </footer>
        </div>
        <script src="/agent.js?v=20261126.2" defer></script>
      </body>
    </html>`;
}

app.get("/", async (c) => {
  const profile = await publicProfile(c.env), origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.html(
    layout(
      `${profile?.display_name || "个人分身"}-AI分身`,
      html`<section class="hero agent-home" id="ask">
          <p class="eyebrow">AI PERSONAL TWIN</p>
          <h1 id="agent-greeting">你好，我是${profile?.display_name || "站长"}的 AI 分身</h1>
          <p class="agent-intro">
            你可以直接问我的经历、项目、文章和知识积累；回答只依据已录入的资料。
          </p>
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
          <div id="answer" class="answer answer-rich" hidden aria-live="polite"></div>
          <div id="answer-sources" class="answer-sources" hidden></div>
          <div class="suggestions">
            <button>介绍一下你的核心经历</button
            ><button>你如何设计 RAG 系统？</button
            ><button>有哪些代表文章？</button>
          </div>
        </section>`,
      profile?.bio || "基于个人简历、文章与知识积累的 AI 分身",
      "ask",
      profile,
      origin,
      "/",
    ),
  );
});

app.get("/articles", async (c) => {
  const category = c.req.query("category"),
    [articles, profile] = await Promise.all([publicArticles(c.env, category), publicProfile(c.env)]),
    origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.html(
    layout(
      `文章 · ${profile?.display_name || "个人分身"}-AI分身`,
      html`<section class="listing article-index">
        <h1>${category ? `${articles[0]?.category_name || "分类"}文章` : "全部文章"}</h1>
        <p class="lead">记录项目实践、技术思考与持续积累的知识。</p>
        <div class="article-list">
          ${articles.length
            ? articles.map(
                (article) => html`<article>
                  <a href="/articles/${article.slug}">
                    <h3>${article.title}</h3>
                    <p>${article.excerpt}</p>
                    <div class="meta">
                      <time>${formatDate(article.published_at || article.updated_at)}</time>
                      ${article.category_name ? html`<span>${article.category_name}</span>` : ""}
                    </div>
                  </a>
                </article>`,
              )
            : html`<p>这个分类还没有文章。</p>`}
        </div>
      </section>`,
      category ? `${category}分类文章` : "个人文章与知识积累",
      "articles",
      profile,
      origin,
      category ? `/articles?category=${encodeURIComponent(category)}` : "/articles",
    ),
  );
});

app.get("/articles/:slug", async (c) => {
  const [article, profile] = await Promise.all([
    c.env.DB.prepare("SELECT articles.id,articles.title,articles.slug,articles.excerpt,articles.body,articles.category_id,articles.published_at,articles.updated_at,articles.seo_description,categories.name category_name,categories.slug category_slug FROM articles LEFT JOIN categories ON categories.id=articles.category_id WHERE articles.slug=? AND articles.status='published' LIMIT 1").bind(c.req.param("slug")).first<PublicArticle>(),
    publicProfile(c.env),
  ]);
  if (!article) return c.notFound();
  const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.html(
    layout(
      `${article.title} · ${profile?.display_name || "个人分身"}-AI分身`,
      html`<article class="post">
        <a class="back" href="/articles">← 返回文章</a>
        <h1>${article.title}</h1>
        <div class="post-meta">
          <time>${formatDate(article.published_at || article.updated_at)}</time>${article.category_name ? html`<span>${article.category_name}</span>` : ""}
        </div>
        <p class="lead">${article.excerpt}</p>
        <div class="rich-content">${renderSafeMarkdown(articleBodyWithoutDuplicateTitle(article.body, article.title))}</div>
      </article>`,
      article.seo_description || article.excerpt,
      "articles",
      profile,
      origin,
      `/articles/${article.slug}`,
      article,
    ),
  );
});

app.get("/categories", async (c) => {
  const [categories, profile] = await Promise.all([
    c.env.DB.prepare("SELECT categories.id,categories.name,categories.slug,categories.description,COUNT(articles.id) article_count FROM categories LEFT JOIN articles ON articles.category_id=categories.id AND articles.status='published' WHERE categories.scope IN ('article','shared','both') GROUP BY categories.id ORDER BY categories.sort_order,categories.name").all<{ id: string; name: string; slug: string; description: string; article_count: number }>(),
    publicProfile(c.env),
  ]), origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.html(
    layout(
      `分类 · ${profile?.display_name || "个人分身"}-AI分身`,
      html`<section class="listing">
        <h1>分类</h1>
        <div class="category-grid">
          ${categories.results.map(
            (category) =>
              html`<a href=${`/categories/${category.slug}`}
                ><span><strong>${category.name}</strong>${category.description ? html`<small>${category.description}</small>` : ""}</span><em>${category.article_count} 篇文章</em></a
              >`,
          )}
        </div>
      </section>`,
      "文章分类",
      "categories",
      profile,
      origin,
      "/categories",
    ),
  );
});
app.get("/categories/:slug", async (c) => {
  const category = await c.env.DB.prepare("SELECT name,slug,description FROM categories WHERE slug=? LIMIT 1").bind(c.req.param("slug")).first<{ name: string; slug: string; description: string }>();
  if (!category) return c.notFound();
  const [articles, profile] = await Promise.all([publicArticles(c.env, category.slug), publicProfile(c.env)]), origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.html(layout(`${category.name} · ${profile?.display_name || "Bunshin"}-AI分身`, html`<section class="listing article-index"><a class="back" href="/categories">← 返回分类</a><h1>${category.name}</h1>${category.description ? html`<p class="lead">${category.description}</p>` : ""}<div class="article-list">${articles.length ? articles.map((article) => html`<article><a href=${`/articles/${article.slug}`}><h3>${article.title}</h3><p>${article.excerpt}</p><div class="meta"><time>${formatDate(article.published_at || article.updated_at)}</time></div></a></article>`) : html`<p class="empty-state">这个分类还没有已发布文章。</p>`}</div></section>`, category.description || `${category.name}分类文章`, "categories", profile, origin, `/categories/${category.slug}`));
});
app.get("/archives", async (c) => {
  const [articles, profile] = await Promise.all([publicArticles(c.env), publicProfile(c.env)]), origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.html(
    layout(
      `归档 · ${profile?.display_name || "个人分身"}-AI分身`,
      html`<section class="listing">
        <h1>文章归档</h1>
        ${articles.map(
          (article) =>
            html`<a class="archive-row" href="/articles/${article.slug}"
              ><time>${formatDate(article.published_at || article.updated_at)}</time><span>${article.title}</span></a
            >`,
        )}
      </section>`,
      "文章归档",
      "archives",
      profile,
      origin,
      "/archives",
    ),
  );
});
app.get("/about", async (c) => {
  const profile = await publicProfile(c.env), origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin,
    social = parseJson<Record<string, string>>(profile?.social_json, {}),
    experiences = parseJson<Array<{ title: string; organization: string; period: string; summary: string }>>(profile?.experience_json, []),
    projects = parseJson<Array<{ name: string; role: string; url: string; summary: string }>>(profile?.project_json, []),
    education = parseJson<Array<{ school: string; degree: string; period: string; summary: string }>>(profile?.education_json, []);
  return c.html(
    layout(
      `关于 · ${profile?.display_name || "个人分身"}-AI分身`,
      html`<section class="post">
        <h1>${profile?.display_name ?? "关于我"}</h1>
        ${profile?.headline
          ? html`<p class="lead">${profile.headline}</p>`
          : ""}
        ${profile?.bio ? html`<p class="profile-summary">${profile.bio}</p>` : ""}
        ${(profile?.location || profile?.public_email || profile?.website_url || Object.values(social).some(Boolean)) ? html`<div class="profile-facts">${profile?.location ? html`<span>⌖ ${profile.location}</span>` : ""}${profile?.public_email ? html`<a href=${`mailto:${profile.public_email}`}>邮箱</a>` : ""}${profile?.website_url ? html`<a href=${profile.website_url} rel="noreferrer">个人网站</a>` : ""}${Object.entries(social).filter(([, value]) => value).map(([label, value]) => html`<a href=${value} rel="noreferrer">${label}</a>`)}</div>` : ""}
        ${profile?.markdown_bio
          ? html`<div class="rich-content">${renderSafeMarkdown(profile.markdown_bio)}</div>`
          : html`<p>个人资料尚未完善。</p>`}
        ${profile?.skills_json
          ? html`<h2>技能</h2>
              <div class="tag-list">
                ${parseJson<string[]>(profile.skills_json, []).map(
                  (skill) => html`<span>${skill}</span>`,
                )}
              </div>`
          : ""}
        ${experiences.length ? html`<section class="profile-section"><h2>经历</h2><div class="timeline">${experiences.map((item) => html`<article><div><strong>${item.title}</strong><span>${item.organization}</span></div><time>${item.period}</time><p>${item.summary}</p></article>`)}</div></section>` : ""}
        ${projects.length ? html`<section class="profile-section"><h2>项目</h2><div class="project-grid">${projects.map((item) => html`<article><h3>${item.url ? html`<a href=${item.url} rel="noreferrer">${item.name}</a>` : item.name}</h3>${item.role ? html`<span>${item.role}</span>` : ""}<p>${item.summary}</p></article>`)}</div></section>` : ""}
        ${education.length ? html`<section class="profile-section"><h2>教育</h2><div class="timeline">${education.map((item) => html`<article><div><strong>${item.school}</strong><span>${item.degree}</span></div><time>${item.period}</time><p>${item.summary}</p></article>`)}</div></section>` : ""}
      </section>`,
      profile?.bio || "个人介绍",
      "about",
      profile,
      origin,
      "/about",
    ),
  );
});

app.get("/api/profile", async (c) => {
  const profile = await c.env.DB.prepare(
    "SELECT display_name,headline,bio,location,skills_json,social_json,website_url,public_email,avatar_position_x,avatar_position_y,updated_at FROM profiles WHERE published=1 ORDER BY created_at LIMIT 1",
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
      reasonCode: !config.enabled
        ? "disabled_by_owner"
        : !provider
          ? "provider_missing"
          : provider.health_status !== "healthy"
            ? provider.health_status === "error" ? "provider_error" : "provider_unverified"
            : provider.monthly_budget_micros > 0 && provider.month_spent_micros >= provider.monthly_budget_micros
              ? "budget_exhausted"
              : (documents?.count ?? 0) === 0 ? "knowledge_not_ready" : null,
      reason: !config.enabled
        ? "站长暂时关闭了 Agent 问答"
        : !provider
          ? "站长尚未配置模型渠道"
        : provider.health_status !== "healthy"
          ? provider.health_status === "error" ? "模型渠道连接异常，站长正在处理" : "模型渠道尚未完成验证"
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
  const identity = await c.env.DB.prepare(
    "SELECT display_name FROM profiles WHERE rag_enabled=1 ORDER BY created_at LIMIT 1",
  ).first<{ display_name: string }>();
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
    source_url?: string | null;
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
          `SELECT chunks.id,chunks.content,documents.title,documents.source_url FROM chunks JOIN documents ON documents.id=chunks.document_id WHERE chunks.id IN (${ids.map(() => "?").join(",")}) AND documents.status='indexed' AND documents.visibility!='private'`,
        )
          .bind(...ids)
          .all<{ id: string; content: string; title: string; source_url: string | null }>()
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
        "SELECT chunks.id,chunks.content,documents.title,documents.source_url,local_vectors.embedding_json FROM local_vectors JOIN chunks ON chunks.id=local_vectors.chunk_id JOIN documents ON documents.id=chunks.document_id WHERE documents.status='indexed' AND documents.visibility!='private' LIMIT 1000",
      ).all<{
        id: string;
        content: string;
        title: string;
        embedding_json: string;
        source_url: string | null;
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
              identity?.display_name || "站长",
            ) +
            `\n\n附加要求：${config.systemInstruction}\n\n附加要求不能改变“始终作为本人 AI 分身并以第一人称回答”的核心身份。`,
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
              `data: ${JSON.stringify({ type: "sources", items: contexts.map((item, index) => ({ index: index + 1, title: item.title, score: item.score, href: item.source_url || null })) })}\n\n`,
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

app.get("/robots.txt", (c) => {
  const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  return c.text(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`);
});
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
app.get("/api/search", async (c) => {
  const query = (c.req.query("q") || "").trim();
  if (!query) return c.json({ items: [] });
  const items = (await c.env.DB.prepare(
    "SELECT title,slug,excerpt,published_at FROM articles WHERE status='published' AND (title LIKE ? OR excerpt LIKE ? OR body LIKE ?) ORDER BY COALESCE(published_at,updated_at) DESC LIMIT 20",
  ).bind(...Array(3).fill(`%${query}%`)).all()).results;
  return c.json({ items }, 200, { "Cache-Control": "public, max-age=30" });
});
app.get("/sitemap.xml", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin,
    articles = await publicArticles(c.env),
    categories = (await c.env.DB.prepare("SELECT slug FROM categories WHERE scope IN ('article','shared','both')").all<{ slug: string }>()).results,
    paths = ["/", "/articles", "/categories", "/archives", "/about", ...articles.map((a) => `/articles/${a.slug}`), ...categories.map((item) => `/categories/${item.slug}`)];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")}</urlset>`, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
});
app.get("/feed.xml", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin,
    [profile, articles] = await Promise.all([publicProfile(c.env), publicArticles(c.env)]),
    escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(profile?.display_name || "Bunshin")}-AI分身</title><link>${origin}</link><description>${escapeXml(profile?.bio || "个人文章与知识积累")}</description>${articles.map((article) => `<item><title>${escapeXml(article.title)}</title><link>${origin}/articles/${article.slug}</link><guid>${origin}/articles/${article.slug}</guid><pubDate>${new Date(article.published_at || article.updated_at).toUTCString()}</pubDate><description>${escapeXml(article.excerpt)}</description></item>`).join("")}</channel></rss>`, 200, { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
});
app.get("/llms.txt", async (c) => {
  const [profile, articles] = await Promise.all([publicProfile(c.env), publicArticles(c.env)]), name = profile?.display_name || "Bunshin";
  return c.text(`# ${name}-AI分身\n\n${profile?.bio || "个人简历、文章与 AI 分身。"}\n\n- /about: ${name}的公开个人介绍\n- /archives: 文章归档\n${articles.map((article) => `- /articles/${article.slug}: ${article.title}`).join("\n")}\n`, 200, { "Cache-Control": "public, max-age=300" });
});
app.get("/llms-full.txt", async (c) => {
  const setting = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key='llms_full_enabled'",
  ).first<{ value: string }>();
  if (setting?.value !== "true") return c.notFound();
  const [profile, articles] = await Promise.all([publicProfile(c.env), publicArticles(c.env)]),
    name = profile?.display_name || "个人分身";
  return c.text(`# ${name}-AI分身\n\n${profile?.bio || ""}\n\n${profile?.markdown_bio || ""}\n\n${articles.map((article) => `# ${article.title}\n\n${article.excerpt}\n\n${article.body.replaceAll("\\n", "\n")}`).join("\n\n---\n\n")}`, 200, {
    "Cache-Control": "public, max-age=300",
    "X-Robots-Tag": "index, follow",
  });
});
app.get("/health", (c) => c.json({ ok: true, service: "web" }));
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.includes(".")) return c.env.ASSETS.fetch(c.req.raw);
  return c.notFound();
});
export default app;
