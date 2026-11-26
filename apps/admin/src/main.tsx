import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import "./styles.css";
echarts.use([
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);
type View =
  | "dashboard"
  | "content"
  | "articles"
  | "knowledge"
  | "providers"
  | "usage"
  | "settings";
const nav: Array<{ id: View; label: string; icon: string }> = [
  { id: "dashboard", label: "概览", icon: "⌂" },
  { id: "content", label: "个人资料", icon: "◎" },
  { id: "articles", label: "文章管理", icon: "▤" },
  { id: "knowledge", label: "知识库", icon: "◇" },
  { id: "providers", label: "模型渠道", icon: "⌘" },
  { id: "usage", label: "用量明细", icon: "⌁" },
  { id: "settings", label: "系统设置", icon: "⚙" },
];
const stats = [
  { label: "本月请求", value: "1,284", delta: "+18.6%" },
  { label: "Token 消耗", value: "2.46M", delta: "+9.2%" },
  { label: "预估费用", value: "$4.82", delta: "预算剩余 $15.18" },
  { label: "RAG 命中率", value: "91.7%", delta: "+2.4%" },
];
function maskApiKey(value: string) {
  if (!value) return "尚未输入";
  if (value.length <= 4) return "•".repeat(value.length);
  const head = value.slice(0, Math.min(4, value.length - 2));
  const tail = value.slice(-2);
  return `${head}${"*".repeat(Math.max(4, value.length - head.length - tail.length))}${tail}`;
}
function Chart({ type }: { type: "line" | "pie" }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const option =
      type === "line"
        ? {
            grid: { left: 42, right: 18, top: 22, bottom: 30 },
            tooltip: { trigger: "axis" },
            legend: { data: ["请求", "Token"], bottom: 0 },
            xAxis: {
              type: "category",
              data: [
                "11/20",
                "11/21",
                "11/22",
                "11/23",
                "11/24",
                "11/25",
                "11/26",
              ],
              axisLine: { lineStyle: { color: "#dfe3e8" } },
            },
            yAxis: {
              type: "value",
              splitLine: { lineStyle: { color: "#eef0f2" } },
            },
            series: [
              {
                name: "请求",
                type: "line",
                smooth: true,
                data: [116, 142, 128, 194, 176, 221, 207],
                itemStyle: { color: "#496d8d" },
                areaStyle: { color: "rgba(73,109,141,.08)" },
              },
              {
                name: "Token",
                type: "line",
                smooth: true,
                data: [90, 128, 112, 166, 150, 198, 183],
                itemStyle: { color: "#96a9b9" },
              },
            ],
          }
        : {
            tooltip: { trigger: "item" },
            legend: { bottom: 0 },
            series: [
              {
                type: "pie",
                radius: ["48%", "72%"],
                center: ["50%", "45%"],
                data: [
                  { name: "DeepSeek", value: 48 },
                  { name: "OpenAI", value: 30 },
                  { name: "Embedding", value: 22 },
                ],
                itemStyle: {
                  borderRadius: 5,
                  borderColor: "#fff",
                  borderWidth: 3,
                },
                color: ["#496d8d", "#8aa4ba", "#c0ced9"],
              },
            ],
          };
    chart.setOption(option);
    if (type === "line")
      fetch("/api/admin/analytics/trends")
        .then(
          (r) =>
            r.json() as Promise<{
              items: Array<{ day: string; requests: number; tokens: number }>;
            }>,
        )
        .then(({ items }) =>
          chart.setOption({
            xAxis: { data: items.map((i) => i.day.slice(5)) },
            series: [
              { name: "请求", data: items.map((i) => i.requests) },
              { name: "Token", data: items.map((i) => i.tokens) },
            ],
          }),
        );
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [type]);
  return <div ref={ref} className="chart" />;
}
function Dashboard() {
  const [overview, setOverview] = useState({ requests: 0, tokens: 0, cost: 0 });
  useEffect(() => {
    fetch("/api/admin/analytics/overview")
      .then((r) => r.json() as Promise<typeof overview>)
      .then(setOverview);
  }, []);
  const liveStats = [
    {
      label: "本月请求",
      value: overview.requests.toLocaleString(),
      delta: "真实调用记录",
    },
    {
      label: "Token 消耗",
      value: overview.tokens.toLocaleString(),
      delta: "Chat + Embedding",
    },
    {
      label: "预估费用",
      value: `$${(overview.cost / 1_000_000).toFixed(4)}`,
      delta: "按渠道价格估算",
    },
    { label: "RAG 文档", value: "—", delta: "在知识库查看" },
  ];
  return (
    <>
      <header className="page-head">
        <div>
          <p>2026 年 11 月 26 日</p>
          <h1>下午好，这是你的分身运行概况</h1>
        </div>
        <button className="primary">查看公开站点 ↗</button>
      </header>
      <section className="stats">
        {liveStats.map((s) => (
          <article key={s.label}>
            <span>{s.label}</span>
            <strong>{s.value}</strong>
            <small>{s.delta}</small>
          </article>
        ))}
      </section>
      <section className="grid">
        <article className="panel wide">
          <div className="panel-title">
            <div>
              <h2>调用趋势</h2>
              <p>最近 7 天的请求与 Token 变化</p>
            </div>
            <select>
              <option>最近 7 天</option>
              <option>最近 30 天</option>
            </select>
          </div>
          <Chart type="line" />
        </article>
        <article className="panel">
          <div className="panel-title">
            <div>
              <h2>渠道占比</h2>
              <p>按费用统计</p>
            </div>
          </div>
          <Chart type="pie" />
        </article>
        <article className="panel wide">
          <div className="panel-title">
            <div>
              <h2>最近任务</h2>
              <p>文档解析与向量化状态</p>
            </div>
            <button className="link">全部任务</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>文档</th>
                <th>分类</th>
                <th>状态</th>
                <th>切片</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>个人简历.pdf</td>
                <td>个人经历</td>
                <td>
                  <span className="status ok">已索引</span>
                </td>
                <td>36</td>
                <td>5 分钟前</td>
              </tr>
              <tr>
                <td>RAG 设计笔记.md</td>
                <td>AI 与 Agent</td>
                <td>
                  <span className="status running">向量化中</span>
                </td>
                <td>18</td>
                <td>刚刚</td>
              </tr>
              <tr>
                <td>年度复盘.txt</td>
                <td>知识积累</td>
                <td>
                  <span className="status">待处理</span>
                </td>
                <td>—</td>
                <td>12 分钟前</td>
              </tr>
            </tbody>
          </table>
        </article>
      </section>
    </>
  );
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
};
type KnowledgeCategory = { id: string; name: string };
function Knowledge() {
  const [open, setOpen] = useState(false),
    [documents, setDocuments] = useState<KnowledgeDocument[]>([]),
    [categories, setCategories] = useState<KnowledgeCategory[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    const [docs, cats] = await Promise.all([
      fetch("/api/admin/documents"),
      fetch("/api/admin/categories"),
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
    const response = await fetch("/api/admin/documents", {
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
  const statusLabel = (status: string) =>
    ({
      uploaded: "等待处理",
      parsing: "解析中",
      indexed: "已索引",
      needs_ocr: "需要 OCR",
      failed: "失败",
    })[status] ?? status;
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
                      {statusLabel(item.status)}
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
    fetch("/api/admin/providers")
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
                <p>{item.key_preview}</p>
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
              const response = await fetch("/api/admin/providers", {
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
    [uploadMessage, setUploadMessage] = useState("");
  useEffect(() => {
    fetch("/api/admin/profile")
      .then((r) => r.json() as Promise<{ profile: any }>)
      .then(({ profile: p }) => {
        if (p)
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
      });
  }, []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    const response = await fetch("/api/admin/profile", {
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
    const response = await fetch("/api/admin/profile/avatar", {
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
    const response = await fetch("/api/admin/documents", {
      method: "POST",
      body: new FormData(e.currentTarget),
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    setResumeBusy(false);
    if (!response.ok) return setUploadMessage(result.error ?? "简历上传失败");
    e.currentTarget.reset();
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
      <form className="profile-layout" onSubmit={save}>
        <section className="panel profile-form">
          <h2>基本资料</h2>
          <div className="avatar-editor">
            <img
              src={`/api/admin/profile/avatar?v=${avatarVersion}`}
              alt="当前头像"
            />
            <div className="avatar-upload-control">
              <label className="upload compact-upload">
                <input
                  name="file"
                  required
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={uploadAvatar}
                  disabled={avatarBusy}
                />
                <strong>{avatarBusy ? "上传中…" : "选择并上传头像"}</strong>
                <span>JPG、PNG、WebP 或 GIF，最大 5MB</span>
              </label>
            </div>
          </div>
          <label>
            显示名称
            <input
              value={profile.displayName}
              onChange={(e) => field("displayName", e.target.value)}
              required
            />
          </label>
          <label>
            职业标题
            <input
              value={profile.headline}
              onChange={(e) => field("headline", e.target.value)}
            />
          </label>
          <label>
            简短介绍
            <textarea
              value={profile.bio}
              onChange={(e) => field("bio", e.target.value)}
              rows={4}
            />
          </label>
          <label>
            所在地
            <input
              value={profile.location}
              onChange={(e) => field("location", e.target.value)}
            />
          </label>
          <label>
            技能标签
            <input
              value={profile.skills}
              onChange={(e) => field("skills", e.target.value)}
              placeholder="TypeScript, RAG, Cloudflare"
            />
          </label>
          <label>
            GitHub
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
          <h2>Markdown 个人介绍</h2>
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
        <h2>个人简历</h2>
        <p>在这里直接上传 PDF 或 Markdown，文件会进入现有 RAG 处理流程。</p>
        <form className="resume-upload" onSubmit={uploadResume}>
          <input type="hidden" name="purpose" value="resume" />
          <label>
            简历标题
            <input name="title" required placeholder="例如：我的个人简历" />
          </label>
          <label className="upload">
            <input
              name="file"
              required
              type="file"
              accept=".pdf,.md,application/pdf,text/markdown,text/plain"
            />
            <strong>选择 PDF / Markdown</strong>
            <span>上传后自动解析、切片并建立索引</span>
          </label>
          <label>
            可见性
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
        {uploadMessage && <div className="upload-message">{uploadMessage}</div>}
      </section>
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
      }>
    >([]),
    [presets, setPresets] = useState<ProviderPreset[]>([]),
    [open, setOpen] = useState(false),
    [key, setKey] = useState(""),
    [presetId, setPresetId] = useState("openai"),
    [error, setError] = useState("");
  const load = () =>
    Promise.all([
      fetch("/api/admin/providers").then((r) => r.json()),
      fetch("/api/admin/provider-presets").then((r) => r.json()),
    ]).then(([a, b]: any[]) => {
      setItems(a.items);
      setPresets(b.items);
    });
  useEffect(() => {
    void load();
  }, []);
  const selected = presets.find((p) => p.id === presetId);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const data = new FormData(e.currentTarget),
      response = await fetch("/api/admin/providers/simple", {
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
      setError("保存失败，请检查配置");
      return;
    }
    setKey("");
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
                <p>{item.key_preview}</p>
              </div>
              <span className="status ok">正常</span>
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
          </article>
        ))}
      </section>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <form
            className="modal"
            onSubmit={submit}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>配置模型渠道</h2>
              <button type="button" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
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
              <div className="secret-field">
                <input
                  type="password"
                  required
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="new-password"
                />
                <span>{key.length} 字符</span>
              </div>
              <small className="masked-preview">预览：{maskApiKey(key)}</small>
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
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
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

function Placeholder({ view }: { view: View }) {
  const labels = {
    content: "个人资料",
    articles: "文章管理",
    usage: "用量明细",
    settings: "系统设置",
    dashboard: "",
    knowledge: "",
    providers: "",
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
function AdminApp({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<View>("dashboard");
  const title = useMemo(() => nav.find((n) => n.id === view)?.label, [view]);
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#">
          <span>B</span>
          <div>
            <strong>Bunshin</strong>
            <small>管理后台</small>
          </div>
        </a>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="account">
          <span>A</span>
          <div>
            <strong>站长</strong>
            <small>安全会话</small>
          </div>
          <button
            onClick={async () => {
              await fetch("/api/admin/auth/logout", { method: "POST" });
              onLogout();
            }}
            title="退出登录"
          >
            退出
          </button>
        </div>
      </aside>
      <main>
        <div className="mobile-title">{title}</div>
        {view === "dashboard" ? (
          <Dashboard />
        ) : view === "content" ? (
          <ProfileEditor />
        ) : view === "knowledge" ? (
          <Knowledge />
        ) : view === "providers" ? (
          <Providers />
        ) : (
          <Placeholder view={view} />
        )}
      </main>
    </div>
  );
}
function AuthGate() {
  const [status, setStatus] = useState<"loading" | "setup" | "login" | "ready">(
    "loading",
  );
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      fetch("/api/admin/auth/status").then(
        (r) => r.json() as Promise<{ initialized: boolean }>,
      ),
      fetch("/api/admin/auth/session").then((r) => r.ok),
    ])
      .then(([setup, session]) =>
        setStatus(session ? "ready" : setup.initialized ? "login" : "setup"),
      )
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
    return <AdminApp onLogout={() => setStatus("login")} />;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget),
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
    let result: { error?: string } = {};
    try {
      result = JSON.parse(responseText) as { error?: string };
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
    }
    setStatus("ready");
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">B</div>
        <p className="eyebrow">AI BUNSHIN</p>
        <h1>{status === "setup" ? "创建本地管理员" : "登录管理后台"}</h1>
        <p>
          {status === "setup"
            ? "首次运行只需创建一个站长账号。"
            : "管理你的内容、知识库与模型渠道。"}
        </p>
        <label>
          邮箱
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete={
              status === "setup" ? "new-password" : "current-password"
            }
          />
        </label>
        {status === "setup" &&
          location.hostname !== "localhost" &&
          location.hostname !== "127.0.0.1" && (
            <label>
              初始化令牌
              <input name="token" type="password" required />
            </label>
          )}
        {error && <div className="auth-error">{error}</div>}
        <button className="primary">
          {status === "setup" ? "创建并进入后台" : "登录"}
        </button>
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<AuthGate />);
