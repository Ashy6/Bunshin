import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { adminFetch } from "./api";

const ProfileManager = lazy(() => import("./management").then((module) => ({ default: module.ProfileManager })));
const ArticlesManagerV2 = lazy(() => import("./content-management").then((module) => ({ default: module.ArticlesManagerV2 })));
const CategoriesManager = lazy(() => import("./content-management").then((module) => ({ default: module.CategoriesManager })));
const KnowledgeManagerV2 = lazy(() => import("./content-management").then((module) => ({ default: module.KnowledgeManagerV2 })));
const DashboardOperations = lazy(() => import("./operations").then((module) => ({ default: module.DashboardOperations })));
const ObservabilityManager = lazy(() => import("./operations").then((module) => ({ default: module.ObservabilityManager })));
const SystemSettings = lazy(() => import("./operations").then((module) => ({ default: module.SystemSettings })));
const UsageManager = lazy(() => import("./operations").then((module) => ({ default: module.UsageManager })));
type View =
  | "dashboard"
  | "content"
  | "articles"
  | "categories"
  | "knowledge"
  | "agent"
  | "providers"
  | "usage"
  | "observability"
  | "settings";
const nav: Array<{ id: View; label: string; icon: string }> = [
  { id: "dashboard", label: "概览", icon: "⌂" },
  { id: "content", label: "个人资料", icon: "◎" },
  { id: "articles", label: "文章管理", icon: "▤" },
  { id: "knowledge", label: "知识库", icon: "◇" },
  { id: "categories", label: "内容分类", icon: "⌗" },
  { id: "agent", label: "Agent 设置", icon: "◉" },
  { id: "providers", label: "模型渠道", icon: "⌘" },
  { id: "usage", label: "用量明细", icon: "⌁" },
  { id: "observability", label: "生产监控", icon: "◫" },
  { id: "settings", label: "系统设置", icon: "⚙" },
];
function maskApiKey(value: string) {
  if (!value) return "尚未输入";
  if (value.length <= 4) return "•".repeat(value.length);
  const head = value.slice(0, Math.min(4, value.length - 2));
  const tail = value.slice(-2);
  return `${head}*****${tail}`;
}
function KnowledgeLegacy() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="page-head">
        <div>
          <p>知识库</p>
          <h1>管理分身可以使用的资料</h1>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          ＋ 添加数据源
        </button>
      </header>
      <div className="toolbar">
        <input placeholder="搜索文档…" />
        <select>
          <option>全部分类</option>
          <option>个人经历</option>
          <option>AI 与 Agent</option>
        </select>
        <select>
          <option>全部状态</option>
          <option>已索引</option>
          <option>处理中</option>
        </select>
      </div>
      <section className="panel">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>分类</th>
              <th>可见性</th>
              <th>状态</th>
              <th>切片</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>个人简历.pdf</strong>
                <small>1.8 MB</small>
              </td>
              <td>PDF</td>
              <td>个人经历</td>
              <td>仅供 RAG</td>
              <td>
                <span className="status ok">已索引</span>
              </td>
              <td>36</td>
              <td>•••</td>
            </tr>
            <tr>
              <td>
                <strong>RAG 系统设计</strong>
                <small>文字录入</small>
              </td>
              <td>Text</td>
              <td>AI 与 Agent</td>
              <td>公开</td>
              <td>
                <span className="status running">向量化中</span>
              </td>
              <td>18</td>
              <td>•••</td>
            </tr>
          </tbody>
        </table>
      </section>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <form
            className="modal"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setOpen(false);
            }}
          >
            <div className="modal-head">
              <h2>添加知识数据源</h2>
              <button type="button" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <label>
              数据类型
              <select>
                <option>上传 PDF / Markdown / TXT</option>
                <option>直接输入文字</option>
              </select>
            </label>
            <label className="upload">
              <input type="file" accept=".pdf,.md,.txt" />
              <strong>选择文件或拖放到这里</strong>
              <span>文本型 PDF，单文件不超过 20 MB</span>
            </label>
            <label>
              分类
              <div className="inline">
                <select>
                  <option>不分类</option>
                  <option>个人经历</option>
                  <option>AI 与 Agent</option>
                </select>
                <button type="button">新建分类</button>
              </div>
            </label>
            <label>
              可见性
              <select>
                <option>仅供 RAG</option>
                <option>公开并允许引用</option>
                <option>私有，不参与检索</option>
              </select>
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button className="primary">上传并解析</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
type KnowledgeDocument = {
  id: string;
  title: string;
  source_type: string;
  visibility: string;
  status: string;
  chunk_count: number;
  error_message?: string;
  category_name?: string;
  r2_key?: string;
  updated_at?: string;
};
type KnowledgeCategory = { id: string; name: string };
const documentStatusLabel = (status: string) =>
  ({
    uploaded: "等待处理",
    parsing: "解析中",
    embedding: "向量化中",
    indexed: "已完成索引",
    needs_ocr: "需要 OCR",
    failed: "处理失败",
  })[status] ?? status;
function Knowledge() {
  const [open, setOpen] = useState(false),
    [documents, setDocuments] = useState<KnowledgeDocument[]>([]),
    [categories, setCategories] = useState<KnowledgeCategory[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    const [docs, cats] = await Promise.all([
      adminFetch("/api/admin/documents"),
      adminFetch("/api/admin/categories"),
    ]);
    if (docs.status === 401 || cats.status === 401) {
      location.reload();
      return;
    }
    setDocuments(((await docs.json()) as { items: KnowledgeDocument[] }).items);
    setCategories(
      ((await cats.json()) as { items: KnowledgeCategory[] }).items,
    );
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await adminFetch("/api/admin/documents", {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    const body = (await response.json()) as { error?: string };
    setBusy(false);
    if (!response.ok) {
      setError(typeof body.error === "string" ? body.error : "上传失败");
      return;
    }
    setOpen(false);
    event.currentTarget.reset();
    await load();
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p>知识库</p>
          <h1>上传后自动解析并进入 RAG</h1>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          ＋ 上传简历或资料
        </button>
      </header>
      <div className="notice">
        支持文本型 PDF、Markdown 和 TXT，最大 20 MB。扫描版 PDF 会标记为需要
        OCR。
      </div>
      <section className="panel">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>分类</th>
              <th>可见性</th>
              <th>状态</th>
              <th>切片</th>
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 ? (
              <tr>
                <td colSpan={6}>还没有资料，请上传你的第一份简历。</td>
              </tr>
            ) : (
              documents.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title}</strong>
                    {item.error_message && <small>{item.error_message}</small>}
                  </td>
                  <td>{item.source_type.toUpperCase()}</td>
                  <td>{item.category_name ?? "未分类"}</td>
                  <td>
                    {item.visibility === "public" ? "公开引用" : "仅供 RAG"}
                  </td>
                  <td>
                    <span
                      className={`status ${item.status === "indexed" ? "ok" : item.status === "parsing" ? "running" : ""}`}
                    >
                      {documentStatusLabel(item.status)}
                    </span>
                  </td>
                  <td>{item.chunk_count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <form
            className="modal"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={submit}
          >
            <div className="modal-head">
              <h2>上传知识资料</h2>
              <button type="button" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <label>
              标题
              <input name="title" required placeholder="例如：个人简历" />
            </label>
            <label className="upload">
              <input
                name="file"
                required
                type="file"
                accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown"
              />
              <strong>选择 PDF / Markdown / TXT</strong>
              <span>上传后自动解析、切片并建立索引</span>
            </label>
            <label>
              分类
              <select name="categoryId">
                <option value="">不分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              可见性
              <select name="visibility" defaultValue="rag_only">
                <option value="rag_only">仅供 RAG</option>
                <option value="public">公开并允许引用</option>
                <option value="private">私有，不参与检索</option>
              </select>
            </label>
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "上传中…" : "上传并建立索引"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function ProvidersLegacy() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [items, setItems] = useState<
    Array<{
      id: string;
      name: string;
      key_preview: string;
      chat_model: string;
      embedding_model: string;
      enabled: number;
    }>
  >([]);
  const [error, setError] = useState("");
  const load = () =>
    adminFetch("/api/admin/providers")
      .then((r) => r.json() as Promise<{ items: typeof items }>)
      .then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <header className="page-head">
        <div>
          <p>模型渠道</p>
          <h1>连接你自己的模型服务</h1>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          ＋ 新增渠道
        </button>
      </header>
      <div className="notice">
        API Key 在录入时也不会明文显示，保存后只保留末尾标识；密文使用
        AES-256-GCM 保存。
      </div>
      <section className="provider-grid">
        {items.map((item) => (
          <article className="provider" key={item.id}>
            <div>
              <span className="provider-logo">{item.name[0]}</span>
              <div>
                <h2>{item.name}</h2>
                <p>{maskApiKey(item.key_preview)}</p>
              </div>
              <span className="status ok">
                {item.enabled ? "正常" : "停用"}
              </span>
            </div>
            <dl>
              <div>
                <dt>Chat</dt>
                <dd>{item.chat_model}</dd>
              </div>
              <div>
                <dt>Embedding</dt>
                <dd>{item.embedding_model}</dd>
              </div>
            </dl>
          </article>
        ))}
        <article className="provider add">
          <button onClick={() => setOpen(true)}>
            ＋<strong>添加任意 OpenAI-compatible 渠道</strong>
            <span>配置 Base URL、API Key 与模型</span>
          </button>
        </article>
      </section>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <form
            className="modal"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              const form = new FormData(e.currentTarget);
              const response = await adminFetch("/api/admin/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: form.get("name"),
                  kind: "openai-compatible",
                  baseUrl: form.get("baseUrl"),
                  apiKey: key,
                  chatModel: form.get("chatModel"),
                  embeddingModel: form.get("embeddingModel"),
                  monthlyBudgetMicros: 0,
                }),
              });
              if (!response.ok) {
                setError("渠道保存失败，请检查字段");
                return;
              }
              setOpen(false);
              setKey("");
              await load();
            }}
          >
            <div className="modal-head">
              <h2>新增模型渠道</h2>
              <button type="button" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <label>
              渠道名称
              <input name="name" required placeholder="例如 DeepSeek" />
            </label>
            <label>
              Base URL
              <input
                required
                name="baseUrl"
                type="url"
                defaultValue="https://api.deepseek.com/v1"
              />
            </label>
            <label>
              API Key
              <div className="secret-field">
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="输入 API Key"
                />
                <span>{key.length} 字符</span>
              </div>
              <small className="masked-preview" aria-live="polite">
                预览：{maskApiKey(key)}
              </small>
            </label>
            <div className="inline">
              <label>
                Chat 模型
                <input name="chatModel" required placeholder="deepseek-chat" />
              </label>
              <label>
                Embedding 模型
                <input
                  name="embeddingModel"
                  required
                  defaultValue="local-hash-v1"
                />
              </label>
            </div>
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setKey("");
                }}
              >
                取消
              </button>
              <button className="primary">加密保存</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
function ProfileEditor() {
  const [profile, setProfile] = useState({
      displayName: "",
      headline: "",
      bio: "",
      location: "",
      markdownBio: "",
      skills: "",
      github: "",
      published: true,
    }),
    [message, setMessage] = useState(""),
    [avatarVersion, setAvatarVersion] = useState(0),
    [avatarBusy, setAvatarBusy] = useState(false),
    [resumeBusy, setResumeBusy] = useState(false),
    [uploadMessage, setUploadMessage] = useState(""),
    [uploadProgress, setUploadProgress] = useState<number | null>(null),
    [selectedResumeName, setSelectedResumeName] = useState(""),
    [resumeDocument, setResumeDocument] =
      useState<KnowledgeDocument | null>(null);
  const loadResumeDocument = async (id: string) => {
    const response = await adminFetch("/api/admin/documents");
    if (!response.ok) return;
    const body = (await response.json()) as { items: KnowledgeDocument[] };
    setResumeDocument(body.items.find((item) => item.id === id) ?? null);
  };
  useEffect(() => {
    adminFetch("/api/admin/profile")
      .then((r) => r.json() as Promise<{ profile: any }>)
      .then(({ profile: p }) => {
        if (p) {
          setProfile({
            displayName: p.display_name ?? "",
            headline: p.headline ?? "",
            bio: p.bio ?? "",
            location: p.location ?? "",
            markdownBio: p.markdown_bio ?? "",
            skills: JSON.parse(p.skills_json ?? "[]").join(", "),
            github: JSON.parse(p.social_json ?? "{}").github ?? "",
            published: Boolean(p.published),
          });
          if (p.resume_document_id) void loadResumeDocument(p.resume_document_id);
        }
      });
  }, []);
  useEffect(() => {
    if (
      !resumeDocument ||
      ["indexed", "failed", "needs_ocr"].includes(resumeDocument.status)
    )
      return;
    const timer = window.setInterval(
      () => void loadResumeDocument(resumeDocument.id),
      2500,
    );
    return () => window.clearInterval(timer);
  }, [resumeDocument?.id, resumeDocument?.status]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    const response = await adminFetch("/api/admin/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: profile.displayName,
        headline: profile.headline,
        bio: profile.bio,
        location: profile.location || null,
        markdownBio: profile.markdownBio,
        skills: profile.skills
          .split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean),
        social: { github: profile.github },
        published: profile.published,
      }),
    });
    setMessage(response.ok ? "已保存并同步到公开资料" : "保存失败");
  };
  const field = (key: keyof typeof profile, value: string | boolean) =>
    setProfile((old) => ({ ...old, [key]: value }));
  const uploadAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarBusy(true);
    setUploadMessage("");
    const data = new FormData();
    data.set("file", file);
    const response = await adminFetch("/api/admin/profile/avatar", {
      method: "POST",
      body: data,
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    setAvatarBusy(false);
    if (!response.ok) return setUploadMessage(result.error ?? "头像上传失败");
    setAvatarVersion(Date.now());
    e.target.value = "";
    setUploadMessage("头像已更新，公开站点将在几分钟内刷新缓存");
  };
  const uploadResume = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setResumeBusy(true);
    setUploadMessage("");
    setUploadProgress(0);
    const form = e.currentTarget;
    const result = await new Promise<{
      ok: boolean;
      id?: string;
      error?: string;
    }>((resolve) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/admin/documents");
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable)
          setUploadProgress(Math.round((event.loaded / event.total) * 100));
      });
      request.addEventListener("load", () => {
        let body: { id?: string; error?: string } = {};
        try {
          body = JSON.parse(request.responseText);
        } catch {
          body.error = "服务器返回了无法识别的响应";
        }
        resolve({ ok: request.status >= 200 && request.status < 300, ...body });
      });
      request.addEventListener("error", () =>
        resolve({ ok: false, error: "网络中断，文件未上传" }),
      );
      request.send(new FormData(form));
    });
    setResumeBusy(false);
    if (!result.ok) {
      setUploadProgress(null);
      return setUploadMessage(result.error ?? "简历上传失败");
    }
    setUploadProgress(100);
    form.reset();
    setSelectedResumeName("");
    if (result.id) {
      await loadResumeDocument(result.id);
      window.setTimeout(() => setUploadProgress(null), 1200);
    }
    setUploadMessage("简历已上传，后台正在解析、切片并建立 RAG 索引");
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p>个人资料</p>
          <h1>维护公开资料、Markdown 与简历</h1>
        </div>
      </header>
      <div className="profile-page">
        <form className="profile-layout" onSubmit={save}>
          <section className="panel profile-form">
            <div className="section-heading">
              <div>
                <h2>基本资料</h2>
                <p>这些信息会同步展示在公开站点。</p>
              </div>
            </div>
            <div className="avatar-editor">
              <label className="avatar-button" title="点击替换头像">
                <img
                  src={`/api/admin/profile/avatar?v=${avatarVersion}`}
                  alt="当前头像"
                />
                <span>{avatarBusy ? "上传中" : "更换"}</span>
                <input
                  name="file"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={uploadAvatar}
                  disabled={avatarBusy}
                />
              </label>
              <div className="avatar-upload-control">
                <strong>头像</strong>
                <span>点击头像上传或替换；未上传时自动显示名称首字。</span>
                <small>JPG、PNG、WebP 或 GIF，最大 5MB</small>
              </div>
            </div>
            <label>
              <span>显示名称 <b className="required-mark">*</b></span>
              <input
                value={profile.displayName}
                onChange={(e) => field("displayName", e.target.value)}
                required
              />
            </label>
            <label>
              <span>职业标题</span>
              <input
                value={profile.headline}
                onChange={(e) => field("headline", e.target.value)}
              />
            </label>
            <label>
              <span>简短介绍</span>
              <textarea
                value={profile.bio}
                onChange={(e) => field("bio", e.target.value)}
                rows={4}
              />
            </label>
            <label>
              <span>所在地</span>
              <input
                value={profile.location}
                onChange={(e) => field("location", e.target.value)}
              />
            </label>
            <label>
              <span>技能标签</span>
              <input
                value={profile.skills}
                onChange={(e) => field("skills", e.target.value)}
                placeholder="TypeScript, RAG, Cloudflare"
              />
            </label>
            <label>
              <span>GitHub</span>
              <input
                value={profile.github}
                onChange={(e) => field("github", e.target.value)}
                placeholder="https://github.com/..."
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={profile.published}
                onChange={(e) => field("published", e.target.checked)}
              />
              公开展示个人资料
            </label>
          </section>
          <section className="panel markdown-editor">
            <div className="section-heading">
              <div>
                <h2>Markdown 个人介绍</h2>
                <p>适合维护完整经历、项目和个人介绍。</p>
              </div>
            </div>
            <textarea
              value={profile.markdownBio}
              onChange={(e) => field("markdownBio", e.target.value)}
              rows={22}
              placeholder="# 关于我\n\n在这里编写工作经历、项目与个人介绍…"
            />
            <p>Markdown 原文存储在 D1，可用于公开页面和后续 RAG 索引。</p>
          </section>
          <div className="profile-actions">
            {message && <span>{message}</span>}
            <button className="primary">保存个人资料</button>
          </div>
        </form>
        <section className="panel resume-entry">
          <div className="section-heading">
            <div>
              <h2>个人简历</h2>
              <p>上传 PDF 或 Markdown，文件会进入 RAG 解析与索引流程。</p>
            </div>
          </div>
          <form className="resume-upload" onSubmit={uploadResume}>
            <input type="hidden" name="purpose" value="resume" />
            <label>
              <span>简历标题 <b className="required-mark">*</b></span>
              <input name="title" required placeholder="例如：我的个人简历" />
            </label>
            <label className="upload">
              <input
                name="file"
                required
                type="file"
                accept=".pdf,.md,application/pdf,text/markdown,text/plain"
                onChange={(event) =>
                  setSelectedResumeName(event.target.files?.[0]?.name ?? "")
                }
              />
              <strong>
                选择 PDF / Markdown <b className="required-mark">*</b>
              </strong>
              <span>{selectedResumeName || "单文件最大 20MB"}</span>
            </label>
            <label>
              <span>可见性</span>
              <select name="visibility" defaultValue="rag_only">
                <option value="rag_only">仅供 AI 分身检索</option>
                <option value="public">公开并允许引用</option>
                <option value="private">私有，不参与检索</option>
              </select>
            </label>
            <button className="primary" disabled={resumeBusy}>
              {resumeBusy ? "上传处理中…" : "上传简历"}
            </button>
          </form>
          {uploadProgress !== null && (
            <div className="upload-progress" aria-live="polite">
              <div>
                <span>{uploadProgress < 100 ? "正在上传" : "上传完成"}</span>
                <strong>{uploadProgress}%</strong>
              </div>
              <progress max="100" value={uploadProgress} />
            </div>
          )}
          {uploadMessage && (
            <div className="upload-message">{uploadMessage}</div>
          )}
          <div className="attachment-list">
            <h3>当前简历附件</h3>
            {resumeDocument ? (
              <article className="attachment-item">
                <div className="attachment-icon">
                  {resumeDocument.source_type === "pdf" ? "PDF" : "MD"}
                </div>
                <div className="attachment-info">
                  <strong>{resumeDocument.title}</strong>
                  <span>
                    {resumeDocument.r2_key?.split("/").at(-1) ?? "简历文件"}
                    {" · "}
                    {documentStatusLabel(resumeDocument.status)}
                  </span>
                  {resumeDocument.error_message && (
                    <small>{resumeDocument.error_message}</small>
                  )}
                </div>
                <a
                  className="attachment-download"
                  href={`/api/admin/documents/${resumeDocument.id}/download`}
                >
                  下载原文件
                </a>
              </article>
            ) : (
              <div className="attachment-empty">还没有上传简历附件</div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

type ProviderPreset = {
  id: string;
  name: string;
  chatModel: string;
  embeddingModel: string;
  embeddingMode: string;
};
function Providers() {
  const [items, setItems] = useState<
      Array<{
        id: string;
        name: string;
        key_preview: string;
        chat_model: string;
        embedding_model: string;
        embedding_mode?: string;
        health_status?: string;
        last_error?: string | null;
      }>
    >([]),
    [presets, setPresets] = useState<ProviderPreset[]>([]),
    [open, setOpen] = useState(false),
    [key, setKey] = useState(""),
    [presetId, setPresetId] = useState("openai"),
    [error, setError] = useState(""),
    [testingId, setTestingId] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const load = () =>
    Promise.all([
      adminFetch("/api/admin/providers").then((r) => r.json()),
      adminFetch("/api/admin/provider-presets").then((r) => r.json()),
    ]).then(([a, b]: any[]) => {
      setItems(a.items);
      setPresets(b.items);
    });
  useEffect(() => {
    void load();
  }, []);
  const selected = presets.find((p) => p.id === presetId);
  const retest = async (id: string) => {
    setTestingId(id);
    setError("");
    const response = await adminFetch(`/api/admin/providers/${id}/test`, {
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    setTestingId(null);
    if (!response.ok) setError(result.error ?? "连接测试失败");
    await load();
  };
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    const data = new FormData(e.currentTarget),
      response = await adminFetch("/api/admin/providers/simple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presetId,
          apiKey: key,
          monthlyBudgetMicros: Number(data.get("budget") || 0) * 1_000_000,
          allowExternalEmbedding: data.get("externalEmbedding") === "on",
          baseUrl: data.get("baseUrl") || undefined,
          chatModel: data.get("chatModel") || undefined,
        }),
      });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(result.error ?? "测试失败，请检查配置");
      setSaving(false);
      return;
    }
    setKey("");
    setSaving(false);
    setOpen(false);
    await load();
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p>模型渠道</p>
          <h1>选择厂商，输入一个 API Key</h1>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          ＋ 配置渠道
        </button>
      </header>
      <div className="notice">
        系统自动选择推荐模型。本地向量化不会外传简历；外部向量化必须单独授权。
      </div>
      <section className="provider-grid">
        {items.map((item) => (
          <article className="provider" key={item.id}>
            <div>
              <span className="provider-logo">{item.name[0]}</span>
              <div>
                <h2>{item.name}</h2>
                <p>{maskApiKey(item.key_preview)}</p>
              </div>
              <span
                className={`status ${item.health_status === "healthy" ? "ok" : ""}`}
              >
                {item.health_status === "healthy" ? "已验证" : "待验证"}
              </span>
            </div>
            <dl>
              <div>
                <dt>对话模型</dt>
                <dd>{item.chat_model}</dd>
              </div>
              <div>
                <dt>向量化</dt>
                <dd>
                  {item.embedding_mode === "provider"
                    ? item.embedding_model
                    : "本地隐私模式"}
                </dd>
              </div>
            </dl>
            <button
              className="secondary"
              onClick={() => void retest(item.id)}
              disabled={testingId === item.id}
            >
              {testingId === item.id ? "测试中…" : "重新测试连接"}
            </button>
          </article>
        ))}
      </section>
      {error && !open && <div className="auth-error">{error}</div>}
      {open && (
        <div
          className="channel-drawer-backdrop"
          onMouseDown={() => !saving && setOpen(false)}
        >
          <form
            className="channel-drawer"
            onSubmit={submit}
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="配置模型渠道"
          >
            <div className="channel-drawer-head">
              <div>
                <p>模型渠道</p>
                <h2>测试并启用一个渠道</h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                ×
              </button>
            </div>
            <div className="channel-drawer-body">
              <label>
                模型厂商
                <select
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value)}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                API Key
                <div className="drawer-secret-field">
                  <input
                    type="password"
                    required
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="new-password"
                    aria-label="API Key"
                  />
                  <span className="drawer-secret-mask">
                    {key ? maskApiKey(key) : "粘贴 API Key"}
                  </span>
                  <span className="drawer-secret-count">{key.length} 字符</span>
                </div>
                <small>完整 Key 只在本次提交中使用，保存后不可读取。</small>
              </label>
              {presetId === "custom" && (
                <>
                  <label>
                    Base URL
                    <input name="baseUrl" type="url" required />
                  </label>
                  <label>
                    Chat 模型
                    <input name="chatModel" required />
                  </label>
                </>
              )}
              <label>
                月度预算（USD）
                <input
                  name="budget"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue="10"
                />
              </label>
              {selected?.embeddingMode === "provider" && (
                <label className="checkbox consent">
                  <input name="externalEmbedding" type="checkbox" />
                  允许将知识片段发送给 {selected.name}{" "}
                  生成向量；不勾选则使用本地隐私模式
                </label>
              )}
              {error && <div className="auth-error">{error}</div>}
            </div>
            <div className="channel-drawer-actions">
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button className="primary" disabled={saving}>
                {saving ? "正在测试连接…" : "测试并启用"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

type AgentState = {
  config: {
    enabled: boolean;
    dailyLimit: number;
    minuteLimit: number;
    globalDailyLimit: number;
    welcomeMessage: string;
    systemInstruction: string;
  };
  ready: boolean;
  provider: null | {
    name: string;
    chat_model: string;
    embedding_mode: string;
    health_status: string;
    last_error?: string | null;
  };
  documents: {
    total: number;
    ready: number;
    processing: number;
    failed: number;
  };
  today: { requests: number; tokens: number; cost_micros: number };
};
function AgentSettings() {
  const [state, setState] = useState<AgentState | null>(null);
  const [message, setMessage] = useState("");
  const load = () =>
    adminFetch("/api/admin/agent")
      .then((response) => response.json() as Promise<AgentState>)
      .then(setState);
  useEffect(() => {
    void load();
  }, []);
  if (!state) return <section className="panel">正在读取 Agent 状态…</section>;
  const update = <K extends keyof AgentState["config"]>(
    key: K,
    value: AgentState["config"][K],
  ) => setState({ ...state, config: { ...state.config, [key]: value } });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    const response = await adminFetch("/api/admin/agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.config),
    });
    setMessage(response.ok ? "Agent 设置已保存" : "保存失败");
    if (response.ok) await load();
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p>Agent 设置</p>
          <h1>控制公开问答、额度和事实边界</h1>
        </div>
        <span className={`agent-state ${state.ready ? "ready" : ""}`}>
          {state.ready ? "运行中" : "尚未就绪"}
        </span>
      </header>
      <section className="stats agent-stats">
        <article>
          <span>模型渠道</span>
          <strong>{state.provider?.name ?? "未配置"}</strong>
          <small>{state.provider?.chat_model ?? "请先测试并启用渠道"}</small>
        </article>
        <article>
          <span>知识库</span>
          <strong>
            {state.documents.ready}/{state.documents.total}
          </strong>
          <small>
            {state.documents.processing} 处理中 · {state.documents.failed} 异常
          </small>
        </article>
        <article>
          <span>今日问答</span>
          <strong>{state.today.requests}</strong>
          <small>{state.today.tokens.toLocaleString()} Token</small>
        </article>
        <article>
          <span>向量方案</span>
          <strong>
            {state.provider?.embedding_mode === "provider" ? "外部" : "本地"}
          </strong>
          <small>资料不足时拒绝编造</small>
        </article>
      </section>
      <form className="panel agent-form" onSubmit={save}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={state.config.enabled}
            onChange={(event) => update("enabled", event.target.checked)}
          />
          启用公开 Agent 问答
        </label>
        <div className="agent-limits">
          <label>
            每位访客每日次数
            <input
              type="number"
              min="1"
              max="1000"
              value={state.config.dailyLimit}
              onChange={(event) =>
                update("dailyLimit", Number(event.target.value))
              }
            />
          </label>
          <label>
            每位访客每分钟次数
            <input
              type="number"
              min="1"
              max="100"
              value={state.config.minuteLimit}
              onChange={(event) =>
                update("minuteLimit", Number(event.target.value))
              }
            />
          </label>
          <label>
            全站每日次数
            <input
              type="number"
              min="1"
              max="100000"
              value={state.config.globalDailyLimit}
              onChange={(event) =>
                update("globalDailyLimit", Number(event.target.value))
              }
            />
          </label>
        </div>
        <label>
          欢迎语
          <textarea
            rows={3}
            value={state.config.welcomeMessage}
            onChange={(event) => update("welcomeMessage", event.target.value)}
          />
        </label>
        <label>
          附加系统要求（不能覆盖分身身份）
          <textarea
            rows={5}
            value={state.config.systemInstruction}
            onChange={(event) =>
              update("systemInstruction", event.target.value)
            }
          />
          <small>
            “以本人 AI 分身身份、使用第一人称回答”是系统固定规则，不受这里的附加要求影响。
          </small>
        </label>
        <div className="profile-actions">
          {message && <span>{message}</span>}
          <button className="primary">保存 Agent 设置</button>
        </div>
      </form>
    </>
  );
}

function Placeholder({ view }: { view: View }) {
  const labels = {
    content: "个人资料",
    articles: "文章管理",
    categories: "内容分类",
    usage: "用量明细",
    observability: "生产监控",
    settings: "系统设置",
    dashboard: "",
    knowledge: "",
    providers: "",
    agent: "",
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p>{labels[view]}</p>
          <h1>{labels[view]}</h1>
        </div>
        <button className="primary">保存更改</button>
      </header>
      <section className="panel empty">
        <span>◫</span>
        <h2>{labels[view]}模块已建立</h2>
        <p>后续数据将通过 Admin Worker API 持久化到 D1。</p>
      </section>
    </>
  );
}
function AdminApp() {
  const hashToView = (): View => {
    const value = location.hash.replace(/^#\/?/, "");
    if (value === "profile") return "content";
    if (value === "articles/new" || /^articles\/[^/]+\/edit$/.test(value)) return "articles";
    return nav.some((item) => item.id === value) ? value as View : "dashboard";
  };
  const [view, setView] = useState<View>(hashToView);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [shellProfile, setShellProfile] = useState<{ display_name: string; headline: string; avatar_position_x: number; avatar_position_y: number; updated_at: string } | null>(null);
  const loadShellProfile = async () => {
    try {
      const response = await adminFetch("/api/admin/profile"), body = await response.json() as { profile?: { display_name: string; headline: string; avatar_position_x: number; avatar_position_y: number; updated_at: string } };
      if (response.ok && body.profile) setShellProfile(body.profile);
    } catch { /* Keep the safe fallback identity while the profile endpoint recovers. */ }
  };
  useEffect(() => {
    const expire = () => location.reload();
    addEventListener("bunshin:session-expired", expire);
    return () => removeEventListener("bunshin:session-expired", expire);
  }, []);
  useEffect(() => {
    void loadShellProfile();
    const update = () => void loadShellProfile();
    addEventListener("bunshin:profile-updated", update);
    return () => removeEventListener("bunshin:profile-updated", update);
  }, []);
  useEffect(() => {
    const update = () => {
      setView(hashToView());
      setMobileNavOpen(false);
    };
    addEventListener("hashchange", update);
    if (!location.hash) history.replaceState(null, "", "#/dashboard");
    return () => removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    const closeOnDesktop = () => {
      if (innerWidth > 820) setMobileNavOpen(false);
    };
    addEventListener("keydown", closeOnEscape);
    addEventListener("resize", closeOnDesktop);
    return () => {
      removeEventListener("keydown", closeOnEscape);
      removeEventListener("resize", closeOnDesktop);
    };
  }, []);
  const navigate = (next: View) => {
    if (document.body.dataset.unsaved === "true" && !confirm("当前页面有未保存更改，确定离开吗？")) return;
    setMobileNavOpen(false);
    location.hash = `/${next === "content" ? "profile" : next}`;
  };
  const title = useMemo(() => nav.find((n) => n.id === view)?.label, [view]);
  return (
    <div className={`shell ${mobileNavOpen ? "nav-open" : ""}`}>
      <header className="mobile-admin-bar">
        <button
          type="button"
          aria-label="打开管理菜单"
          aria-controls="admin-navigation"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <div><strong>{title}</strong><small>Bunshin 管理后台</small></div>
        <img className="mobile-admin-avatar" src={`/api/admin/profile/avatar?v=${encodeURIComponent(shellProfile?.updated_at || "default")}`} style={{ objectPosition: `${shellProfile?.avatar_position_x ?? 50}% ${shellProfile?.avatar_position_y ?? 50}%` }} alt="站长头像" />
      </header>
      <button className="mobile-nav-backdrop" type="button" aria-label="关闭管理菜单" onClick={() => setMobileNavOpen(false)} />
      <aside id="admin-navigation" aria-label="管理后台导航">
        <div className="admin-nav-head">
          <a className="brand" href="#/dashboard" onClick={(event) => { event.preventDefault(); navigate("dashboard"); }}>
            <span>B</span>
            <div>
              <strong>Bunshin</strong>
              <small>管理后台</small>
            </div>
          </a>
          <button className="admin-nav-close" type="button" aria-label="关闭管理菜单" onClick={() => setMobileNavOpen(false)}>×</button>
        </div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              title={item.label}
              onClick={() => navigate(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="account">
          <button className="account-profile" type="button" onClick={() => navigate("content")} title="编辑个人资料">
            <img src={`/api/admin/profile/avatar?v=${encodeURIComponent(shellProfile?.updated_at || "default")}`} style={{ objectPosition: `${shellProfile?.avatar_position_x ?? 50}% ${shellProfile?.avatar_position_y ?? 50}%` }} alt="站长头像" />
            <span><strong>{shellProfile?.display_name || "站长"}</strong></span>
          </button>
          <button
            className="account-logout"
            type="button"
            onClick={async () => {
              await adminFetch("/api/admin/auth/logout", { method: "POST" });
              location.reload();
            }}
          >退出登录</button>
        </div>
      </aside>
      <main>
        <Suspense fallback={<section className="panel empty"><span>◌</span><h2>正在加载模块</h2><p>首次打开该模块时会按需下载资源。</p></section>}>
        {view === "dashboard" ? (
          <DashboardOperations />
        ) : view === "content" ? (
          <ProfileManager />
        ) : view === "articles" ? (
          <ArticlesManagerV2 />
        ) : view === "knowledge" ? (
          <KnowledgeManagerV2 />
        ) : view === "categories" ? (
          <CategoriesManager />
        ) : view === "providers" ? (
          <Providers />
        ) : view === "agent" ? (
          <AgentSettings />
        ) : view === "usage" ? (
          <UsageManager />
        ) : view === "observability" ? (
          <ObservabilityManager />
        ) : view === "settings" ? (
          <SystemSettings />
        ) : (
          <Placeholder view={view} />
        )}
        </Suspense>
      </main>
    </div>
  );
}
function AuthGate() {
  const [status, setStatus] = useState<"loading" | "setup" | "login" | "reset-method" | "reset-request" | "reset-confirm" | "recovery-reset" | "recovery-codes" | "ready">(
    "loading",
  );
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [resetEmail, setResetEmail] = useState(""),
    [recoveryCodes, setRecoveryCodes] = useState<string[]>([]),
    [passwordResetAvailable, setPasswordResetAvailable] = useState(false);
  useEffect(() => {
    Promise.all([
      fetch("/api/admin/auth/status").then(
        (r) => r.json() as Promise<{ initialized: boolean; passwordResetAvailable?: boolean }>,
      ),
      fetch("/api/admin/auth/session").then((r) => r.ok),
    ])
      .then(([setup, session]) => {
        setPasswordResetAvailable(Boolean(setup.passwordResetAvailable));
        setStatus(session ? "ready" : setup.initialized ? "login" : "setup");
      })
      .catch(() => setStatus("setup"));
  }, []);
  if (status === "loading")
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p>正在连接本地后台…</p>
        </div>
      </div>
    );
  if (status === "ready")
    return <AdminApp />;
  const downloadRecoveryCodes = () => {
    const blob = new Blob([`Bunshin 离线恢复码\n\n${recoveryCodes.join("\n")}\n\n每个恢复码只能使用一次，请离线妥善保存。\n`], { type: "text/plain;charset=utf-8" }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "bunshin-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    if (status === "recovery-codes") {
      setStatus("ready");
      return;
    }
    if (status === "recovery-reset") {
      const password = String(form.get("password") || ""),
        passwordConfirm = String(form.get("passwordConfirm") || "");
      if (password !== passwordConfirm) {
        setError("两次输入的新密码不一致");
        return;
      }
      const response = await fetch("/api/admin/auth/recovery/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") || ""),
          recoveryCode: String(form.get("recoveryCode") || ""),
          password,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; message?: string };
      if (!response.ok) {
        setError(result.error || "恢复码校验失败");
        return;
      }
      setMessage(result.message || "密码已修改，请重新登录");
      setStatus("login");
      return;
    }
    if (status === "reset-request") {
      const email = String(form.get("email") || "").trim();
      const response = await fetch("/api/admin/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      setResetEmail(email);
      setMessage(result.message || "如果账号存在，验证码将发送到该邮箱。");
      setStatus("reset-confirm");
      return;
    }
    if (status === "reset-confirm") {
      const password = String(form.get("password") || ""),
        passwordConfirm = String(form.get("passwordConfirm") || "");
      if (password !== passwordConfirm) {
        setError("两次输入的新密码不一致");
        return;
      }
      const response = await fetch("/api/admin/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resetEmail, code: String(form.get("code") || ""), password }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; message?: string };
      if (!response.ok) {
        setError(result.error || "验证码校验失败");
        return;
      }
      setMessage(result.message || "密码已修改，请重新登录");
      setStatus("login");
      return;
    }
    const
      body = {
        email: String(form.get("email")),
        password: String(form.get("password")),
        token: String(form.get("token") || ""),
      };
    const path = status === "setup" ? "bootstrap" : "login";
    const response = await fetch(`/api/admin/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    let result: { error?: string; recoveryCodes?: string[] } = {};
    try {
      result = JSON.parse(responseText) as { error?: string; recoveryCodes?: string[] };
    } catch {
      result = {
        error: response.ok
          ? undefined
          : `服务器返回异常（HTTP ${response.status}）`,
      };
    }
    if (!response.ok) {
      setError(result.error || "操作失败");
      return;
    }
    if (status === "setup") {
      const login = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!login.ok) {
        setStatus("login");
        return;
      }
      if (result.recoveryCodes?.length) {
        setRecoveryCodes(result.recoveryCodes);
        setStatus("recovery-codes");
        return;
      }
    }
    setStatus("ready");
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">B</div>
        <p className="eyebrow">AI BUNSHIN</p>
        <h1>{status === "setup" ? "创建本地管理员" : status === "reset-method" ? "选择恢复方式" : status === "reset-request" ? "找回管理密码" : status === "reset-confirm" ? "输入邮箱验证码" : status === "recovery-reset" ? "使用离线恢复码" : status === "recovery-codes" ? "保存离线恢复码" : "登录管理后台"}</h1>
        <p>
          {status === "setup"
            ? "首次运行只需创建一个站长账号。"
            : status === "reset-request"
              ? "验证码只会发送到已经注册的管理员邮箱。"
              : status === "reset-confirm"
                ? `验证码已请求发送至 ${resetEmail}，10 分钟内有效。`
                : status === "reset-method"
                  ? "离线恢复码无需邮件服务；邮箱验证码仅在配置邮件服务后可用。"
                : status === "recovery-reset"
                  ? "恢复码只用于重置密码，不会直接创建登录会话。"
                : status === "recovery-codes"
                  ? "这些恢复码只展示一次。请下载或复制后离线保存。"
            : "管理你的内容、知识库与模型渠道。"}
        </p>
        {status === "recovery-codes" && <div className="recovery-code-list">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div>}
        {!["reset-confirm", "reset-method", "recovery-codes"].includes(status) && <label>
          邮箱
          <input name="email" type="email" required autoComplete="email" />
        </label>}
        {status === "reset-confirm" && <label>
          6 位验证码
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" />
        </label>}
        {status === "recovery-reset" && <label>
          离线恢复码
          <input name="recoveryCode" required autoCapitalize="characters" autoComplete="off" placeholder="BNSH-XXXX-XXXX-XXXX-XXXX" />
        </label>}
        {!['reset-request', 'reset-method', 'recovery-codes'].includes(status) && <label>
          {status === "reset-confirm" ? "新密码" : "密码"}
          <input
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete={
              ["setup", "reset-confirm", "recovery-reset"].includes(status) ? "new-password" : "current-password"
            }
          />
        </label>}
        {["reset-confirm", "recovery-reset"].includes(status) && <label>
          再次输入新密码
          <input name="passwordConfirm" type="password" required minLength={12} autoComplete="new-password" />
        </label>}
        {status === "setup" &&
          location.hostname !== "localhost" &&
          location.hostname !== "127.0.0.1" && (
            <label>
              初始化令牌
              <input name="token" type="password" required />
            </label>
          )}
        {message && <div className="notice">{message}</div>}
        {error && <div className="auth-error">{error}</div>}
        {status === "reset-method" ? <div className="auth-actions"><button className="primary" type="button" onClick={() => setStatus("recovery-reset")}>使用离线恢复码</button>{passwordResetAvailable && <button className="secondary-button" type="button" onClick={() => setStatus("reset-request")}>使用邮箱验证码</button>}</div> : status === "recovery-codes" ? <><button className="secondary-button" type="button" onClick={downloadRecoveryCodes}>下载恢复码</button><button className="primary">我已安全保存，进入后台</button></> : <button className="primary">
          {status === "setup" ? "创建并进入后台" : status === "reset-request" ? "发送验证码" : status === "reset-confirm" ? "验证并修改密码" : status === "recovery-reset" ? "验证恢复码并修改密码" : "登录"}
        </button>}
        {status === "login" && <button className="text-button" type="button" onClick={() => { setError(""); setMessage(""); setStatus("reset-method"); }}>忘记密码？</button>}
        {["reset-method", "reset-request", "reset-confirm", "recovery-reset"].includes(status) && <button className="text-button" type="button" onClick={() => { setError(""); setMessage(""); setStatus("login"); }}>返回登录</button>}
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<AuthGate />);
