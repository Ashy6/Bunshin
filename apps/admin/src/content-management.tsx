import React, { useEffect, useMemo, useRef, useState } from "react";
import { adminFetch, watchAdminUpload } from "./api";

type Category = {
  id: string; name: string; slug: string; scope: "article" | "knowledge" | "shared";
  description: string; sort_order: number; show_in_portal: number;
  article_count: number; document_count: number;
};
type Article = {
  id: string; title: string; slug: string; excerpt: string; body: string;
  category_id: string | null; category_name?: string; status: string; include_in_rag: number;
  seo_description?: string | null; seo_title?: string | null; tags_json?: string;
  cover_r2_key?: string | null; source_r2_key?: string | null; source_name?: string | null;
  source_type?: string | null; scheduled_at?: string | null; import_status?: string;
  import_error?: string | null; version_count?: number; updated_at: string;
};
type Document = {
  id: string; title: string; source_type: string; category_id?: string | null;
  category_name?: string | null; visibility: string; status: string; chunk_count: number;
  error_message?: string | null; purpose?: string; original_name?: string | null;
  file_size?: number; source_url?: string | null; tags_json?: string;
  ingestion_progress?: number; ocr_status?: string; current_version?: number;
  created_at?: string; updated_at?: string;
};

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, init), raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `请求失败（HTTP ${response.status}）`);
  return body as T;
}
function upload<T>(url: string, form: FormData, onProgress?: (value: number) => void, method = "POST") {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open(method, url);
    request.upload.onprogress = (event) => event.lengthComputable && onProgress?.(Math.round(event.loaded / event.total * 100));
    request.onload = () => {
      watchAdminUpload(request);
      let body: any = {}; try { body = request.responseText ? JSON.parse(request.responseText) : {}; } catch { body = {}; }
      request.status >= 200 && request.status < 300 ? resolve(body as T) : reject(new Error(typeof body.error === "string" ? body.error : `上传失败（HTTP ${request.status}）`));
    };
    request.onerror = () => reject(new Error("网络连接失败")); request.send(form);
  });
}
const parse = <T,>(value: string | undefined | null, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const formatBytes = (value = 0) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const publicUrl = (path: string) => `${location.origin.includes(":8788") ? location.origin.replace(":8788", ":8787") : location.origin.replace("-admin.", "-web.")}${path}`;
const statusText: Record<string, string> = { uploaded: "等待处理", parsing: "解析中", embedding: "向量化中", indexed: "已索引", needs_ocr: "需要 OCR", failed: "处理失败", archived: "已归档" };

function MarkdownPreview({ value }: { value: string }) {
  const normalized = value.replaceAll("\\n", "\n");
  if (!normalized.trim()) return <div className="markdown-empty">还没有内容</div>;
  return <div className="markdown-preview">{normalized.split(/\n{2,}/).map((block, index) => {
    if (/^###\s/.test(block)) return <h3 key={index}>{block.replace(/^###\s/, "")}</h3>;
    if (/^##\s/.test(block)) return <h2 key={index}>{block.replace(/^##\s/, "")}</h2>;
    if (/^#\s/.test(block)) return <h1 key={index}>{block.replace(/^#\s/, "")}</h1>;
    if (/^[-*]\s/m.test(block)) return <ul key={index}>{block.split("\n").map((line, lineIndex) => <li key={lineIndex}>{line.replace(/^[-*]\s+/, "")}</li>)}</ul>;
    return <p key={index}>{block}</p>;
  })}</div>;
}

const emptyEditor = { id: "", title: "", slug: "", excerpt: "", body: "", categoryId: "", status: "draft", includeInRag: true, seoDescription: "", seoTitle: "", tags: "", scheduledAt: "" };

export function ArticlesManagerV2() {
  const [items, setItems] = useState<Article[]>([]), [categories, setCategories] = useState<Category[]>([]);
  const [editor, setEditor] = useState<any | null>(null), [preview, setPreview] = useState(false), [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState(""), [status, setStatus] = useState(""), [category, setCategory] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [message, setMessage] = useState(""), [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false), [importMode, setImportMode] = useState<"file" | "url">("file"), [uploadProgress, setUploadProgress] = useState(0);
  const [versions, setVersions] = useState<any[]>([]), [versionOpen, setVersionOpen] = useState(false), autoSaveRef = useRef(0);
  const load = async () => {
    const [a, c] = await Promise.all([api<{ items: Article[] }>("/api/admin/articles"), api<{ items: Category[] }>("/api/admin/categories")]);
    setItems(a.items); setCategories(c.items);
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!items.length || editor) return;
    const match = /^#\/articles\/([^/]+)\/edit$/.exec(location.hash);
    if (match) { const item = items.find((entry) => entry.id === match[1]); if (item) openEditor(item); }
    else if (location.hash === "#/articles/new") openEditor();
  }, [items]);
  const articleCategories = categories.filter((item) => item.scope !== "knowledge");
  const filtered = useMemo(() => items.filter((item) => (!query || `${item.title} ${item.slug}`.toLowerCase().includes(query.toLowerCase())) && (!status || item.status === status) && (!category || item.category_id === category)), [items, query, status, category]);
  const openEditor = (item?: Article) => {
    setEditor(item ? { id: item.id, title: item.title, slug: item.slug, excerpt: item.excerpt, body: item.body.replaceAll("\\n", "\n"), categoryId: item.category_id || "", status: item.status, includeInRag: Boolean(item.include_in_rag), seoDescription: item.seo_description || "", seoTitle: item.seo_title || "", tags: parse<string[]>(item.tags_json, []).join(", "), scheduledAt: item.scheduled_at ? new Date(item.scheduled_at).toISOString().slice(0, 16) : "", cover: Boolean(item.cover_r2_key), source: item.source_name } : { ...emptyEditor });
    setDirty(false); setPreview(false); location.hash = item ? `/articles/${item.id}/edit` : "/articles/new";
  };
  const closeEditor = () => { if (dirty && !confirm("还有未保存更改，确定离开吗？")) return; setEditor(null); setDirty(false); location.hash = "/articles"; };
  const payload = () => ({ ...editor, categoryId: editor.categoryId || null, seoDescription: editor.seoDescription || null, seoTitle: editor.seoTitle || null, tags: editor.tags.split(",").map((value: string) => value.trim()).filter(Boolean), scheduledAt: editor.status === "scheduled" && editor.scheduledAt ? new Date(editor.scheduledAt).toISOString() : null });
  const saveEditor = async (auto = false) => {
    if (!editor || !editor.title.trim() || !editor.slug.trim() || !editor.body.trim()) return;
    const snapshot = autoSaveRef.current; if (!auto) setSaving(true);
    try {
      const result = await api<{ id: string }>(editor.id ? `/api/admin/articles/${editor.id}` : "/api/admin/articles", { method: editor.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
      if (!editor.id) { setEditor({ ...editor, id: result.id }); location.hash = `/articles/${result.id}/edit`; }
      if (snapshot === autoSaveRef.current) setDirty(false);
      setMessage(auto ? "已自动保存" : "文章已保存"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { setSaving(false); }
  };
  useEffect(() => {
    if (!editor?.id || !dirty) return;
    const timer = setTimeout(() => void saveEditor(true), 1800); return () => clearTimeout(timer);
  }, [editor, dirty]);
  const change = (patch: any) => { autoSaveRef.current += 1; setEditor({ ...editor, ...patch }); setDirty(true); };
  const importContent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage("");
    try {
      const form = new FormData(event.currentTarget);
      if (importMode === "file") {
        const result = await upload<{ items: Array<{ id: string }> }>("/api/admin/articles/import", form, setUploadProgress);
        setImportOpen(false); await load(); if (result.items[0]) location.hash = `/articles/${result.items[0].id}/edit`;
      } else {
        const result = await api<{ id: string }>("/api/admin/articles/import-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: form.get("url"), categoryId: form.get("categoryId") || null }) });
        setImportOpen(false); await load(); location.hash = `/articles/${result.id}/edit`;
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "导入失败"); } finally { setSaving(false); setUploadProgress(0); }
  };
  const batch = async (action: string, categoryId?: string | null) => { await api("/api/admin/articles/batch-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selected, action, categoryId }) }); setSelected([]); await load(); };
  const remove = async (id: string) => { if (!confirm("删除文章、源文件和对应索引？")) return; await api(`/api/admin/articles/${id}`, { method: "DELETE" }); await load(); };
  const showVersions = async () => { if (!editor?.id) return; const data = await api<{ items: any[] }>(`/api/admin/articles/${editor.id}/versions`); setVersions(data.items); setVersionOpen(true); };
  const uploadCover = async (file?: File) => { if (!file || !editor?.id) return; const form = new FormData(); form.set("file", file); await upload(`/api/admin/articles/${editor.id}/cover`, form, undefined, "PUT"); change({ cover: true }); setMessage("封面已更新"); };
  if (editor) return <section className="article-editor-screen">
    <header className="editor-header"><button className="secondary-button" onClick={closeEditor}>← 返回文章</button><div><strong>{editor.id ? editor.title || "未命名文章" : "新建文章"}</strong><small>{dirty ? "等待自动保存" : message || "已保存"}</small></div><button className="secondary-button" onClick={() => setPreview((value) => !value)}>{preview ? "继续编辑" : "预览"}</button><button className="primary" disabled={saving} onClick={() => void saveEditor()}>{saving ? "保存中…" : editor.status === "published" ? "保存发布内容" : "保存"}</button></header>
    <div className="article-editor-layout">
      <main className="article-compose">
        <input className="article-title-input" placeholder="文章标题" value={editor.title} onChange={(event) => change({ title: event.target.value })}/>
        {preview ? <MarkdownPreview value={editor.body}/> : <textarea className="article-full-editor" placeholder="使用 Markdown 开始写作…" value={editor.body} onChange={(event) => change({ body: event.target.value })}/>} 
      </main>
      <aside className="article-settings">
        <h3>发布设置</h3>
        <label>Slug <b className="required-mark">*</b><input value={editor.slug} pattern="[a-z0-9-]+" onChange={(event) => change({ slug: event.target.value })}/></label>
        <label>摘要<textarea rows={3} value={editor.excerpt} onChange={(event) => change({ excerpt: event.target.value })}/></label>
        <label>分类<select value={editor.categoryId} onChange={(event) => change({ categoryId: event.target.value })}><option value="">未分类</option>{articleCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>标签<input value={editor.tags} placeholder="RAG, TypeScript, 随笔" onChange={(event) => change({ tags: event.target.value })}/></label>
        <label>状态<select value={editor.status} onChange={(event) => change({ status: event.target.value })}><option value="draft">草稿</option><option value="scheduled">定时发布</option><option value="published">立即发布</option><option value="archived">归档</option></select></label>
        {editor.status === "scheduled" && <label>发布时间<input type="datetime-local" value={editor.scheduledAt} onChange={(event) => change({ scheduledAt: event.target.value })}/></label>}
        <label className="checkbox"><input type="checkbox" checked={editor.includeInRag} onChange={(event) => change({ includeInRag: event.target.checked })}/><span>允许 Agent 检索</span></label>
        <details open><summary>SEO（选填）</summary><label>SEO 标题<input value={editor.seoTitle} placeholder={editor.title || "默认使用文章标题"} onChange={(event) => change({ seoTitle: event.target.value })}/></label><label>SEO 描述<textarea rows={3} value={editor.seoDescription} placeholder={editor.excerpt || "默认使用摘要"} onChange={(event) => change({ seoDescription: event.target.value })}/></label></details>
        {editor.id && <><label className="cover-upload">封面图片<input type="file" accept="image/*" onChange={(event) => void uploadCover(event.target.files?.[0])}/><span>{editor.cover ? "替换封面" : "上传封面"}</span></label><div className="editor-side-actions"><button onClick={() => void showVersions()}>历史版本</button>{editor.source && <a href={`/api/admin/articles/${editor.id}/source`}>下载导入源</a>}<a href={publicUrl(`/articles/${editor.slug}`)} target="_blank" rel="noreferrer">预览公开页</a></div></>}
      </aside>
    </div>
    {versionOpen && <div className="modal-backdrop" onMouseDown={() => setVersionOpen(false)}><section className="modal version-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><h2>文章历史版本</h2><button onClick={() => setVersionOpen(false)}>×</button></div><div className="version-list">{versions.map((version) => <article key={version.id}><div><strong>{new Date(version.created_at).toLocaleString("zh-CN")}</strong><small>保存前快照</small></div><button onClick={async () => { if (!confirm("恢复后文章会变成草稿，继续吗？")) return; await api(`/api/admin/articles/${editor.id}/versions/${version.id}/restore`, { method: "POST" }); setVersionOpen(false); setEditor(null); await load(); location.hash = "/articles"; }}>恢复</button></article>)}</div></section></div>}
  </section>;
  return <>
    <header className="page-head"><div><p>文章管理</p><h1>写作、导入、发布与门户内容管理</h1></div><div className="head-actions"><button className="secondary-button" onClick={() => setImportOpen(true)}>导入 PDF / Markdown</button><button className="primary" onClick={() => openEditor()}>＋ 新建文章</button></div></header>
    {message && <div className="notice">{message}</div>}
    <div className="content-stats"><article><span>全部文章</span><strong>{items.length}</strong></article><article><span>已发布</span><strong>{items.filter((item) => item.status === "published").length}</strong></article><article><span>草稿</span><strong>{items.filter((item) => item.status === "draft").length}</strong></article><article><span>定时发布</span><strong>{items.filter((item) => item.status === "scheduled").length}</strong></article></div>
    <div className="library-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或 Slug…"/><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部分类</option>{articleCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="draft">草稿</option><option value="scheduled">定时发布</option><option value="published">已发布</option><option value="archived">已归档</option></select>{selected.length > 0 && <div className="batch-actions"><span>已选 {selected.length}</span><button onClick={() => void batch("published")}>发布</button><button onClick={() => void batch("archived")}>归档</button></div>}</div>
    <section className="panel library-table article-library"><table><thead><tr><th><input type="checkbox" checked={filtered.length > 0 && selected.length === filtered.length} onChange={(event) => setSelected(event.target.checked ? filtered.map((item) => item.id) : [])}/></th><th>文章</th><th>分类</th><th>状态</th><th>Agent / SEO</th><th>更新时间</th><th></th></tr></thead><tbody>{filtered.length ? filtered.map((item) => <tr key={item.id}><td><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}/></td><td><button className="table-title" onClick={() => openEditor(item)}><strong>{item.title}</strong><small>/{item.slug}{item.source_name ? ` · 来源：${item.source_name}` : ""}</small></button>{item.import_error && <small className="error-text">{item.import_error}</small>}</td><td>{item.category_name || "未分类"}</td><td><span className={`status ${item.status === "published" ? "ok" : item.status === "scheduled" ? "running" : ""}`}>{item.status === "published" ? "已发布" : item.status === "scheduled" ? "待发布" : item.status === "archived" ? "已归档" : "草稿"}</span></td><td><small>{item.include_in_rag ? "Agent 已收录" : "Agent 未收录"}</small><small>{item.seo_description || item.excerpt ? "SEO 已配置" : "SEO 待完善"}</small></td><td>{new Date(item.updated_at).toLocaleString("zh-CN")}</td><td><div className="row-actions"><button onClick={() => openEditor(item)}>编辑</button>{item.status === "published" && <a href={publicUrl(`/articles/${item.slug}`)} target="_blank" rel="noreferrer">查看</a>}<button className="danger-link" onClick={() => void remove(item.id)}>删除</button></div></td></tr>) : <tr><td colSpan={7}>还没有符合条件的文章。</td></tr>}</tbody></table></section>
    {importOpen && <div className="modal-backdrop" onMouseDown={() => !saving && setImportOpen(false)}><form className="modal import-modal" onSubmit={importContent} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><small>导入后生成草稿</small><h2>导入文章</h2></div><button type="button" onClick={() => setImportOpen(false)}>×</button></div><div className="editor-mode"><button type="button" className={importMode === "file" ? "active" : ""} onClick={() => setImportMode("file")}>上传文件</button><button type="button" className={importMode === "url" ? "active" : ""} onClick={() => setImportMode("url")}>网页 URL</button></div>{importMode === "file" ? <label className="upload"><input name="files" type="file" multiple required accept=".pdf,.md,.markdown,.txt,application/pdf,text/plain,text/markdown"/><strong>选择 PDF / Markdown / TXT</strong><span>一次最多 10 个，单个最大 20MB</span></label> : <label>网页地址 <b className="required-mark">*</b><input name="url" type="url" required placeholder="https://…"/></label>}<label>导入到分类<select name="categoryId"><option value="">未分类</option>{articleCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{uploadProgress > 0 && <div className="upload-progress"><span style={{ width: `${uploadProgress}%` }}/><small>上传 {uploadProgress}%</small></div>}<div className="modal-actions"><button type="button" onClick={() => setImportOpen(false)}>取消</button><button className="primary" disabled={saving}>{saving ? "导入中…" : "导入并生成草稿"}</button></div></form></div>}
  </>;
}

export function KnowledgeManagerV2() {
  const [items, setItems] = useState<Document[]>([]), [categories, setCategories] = useState<Category[]>([]), [detail, setDetail] = useState<any | null>(null);
  const [open, setOpen] = useState(false), [mode, setMode] = useState<"file" | "text" | "url">("file"), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [category, setCategory] = useState(""), [status, setStatus] = useState(""), [visibility, setVisibility] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [message, setMessage] = useState(""), [progress, setProgress] = useState(0), [detailTab, setDetailTab] = useState<string | undefined>("info");
  const [testQuery, setTestQuery] = useState(""), [testResults, setTestResults] = useState<any[]>([]);
  const load = async () => { const [d, c] = await Promise.all([api<{ items: Document[] }>("/api/admin/documents"), api<{ items: Category[] }>("/api/admin/categories")]); setItems(d.items.filter((item) => item.purpose === "knowledge" || (!item.purpose && !item.id.startsWith("article-")))); setCategories(c.items); };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, []);
  const knowledgeCategories = categories.filter((item) => item.scope !== "article");
  const filtered = useMemo(() => items.filter((item) => (!query || `${item.title} ${item.original_name || ""}`.toLowerCase().includes(query.toLowerCase())) && (!category || item.category_id === category) && (!status || item.status === status) && (!visibility || item.visibility === visibility)), [items, query, category, status, visibility]);
  const openDetail = async (id: string) => { const data = await api<any>(`/api/admin/documents/${id}/detail`); setDetail(data); setDetailTab("info"); setTestResults([]); };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage(""); const form = new FormData(event.currentTarget);
    try {
      if (mode === "url") await api("/api/admin/documents/import-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: form.get("url"), title: form.get("title"), categoryId: form.get("categoryId") || null, visibility: form.get("visibility") }) });
      else if (mode === "file") {
        const files = form.getAll("files").filter((value): value is File => value instanceof File);
        for (let index = 0; index < files.length; index += 1) {
          const item = new FormData(); item.set("file", files[index]!); item.set("title", files[index]!.name.replace(/\.[^.]+$/, "")); item.set("categoryId", String(form.get("categoryId") || "")); item.set("visibility", String(form.get("visibility") || "rag_only"));
          await upload("/api/admin/documents", item, (value) => setProgress(Math.round((index + value / 100) / files.length * 100)));
        }
      } else await upload("/api/admin/documents", form, setProgress);
      setOpen(false); setMessage("资料已加入处理队列"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "添加失败"); } finally { setBusy(false); setProgress(0); }
  };
  const remove = async (id: string) => { if (!confirm("删除原文件、所有版本、解析内容和索引？")) return; await api(`/api/admin/documents/${id}`, { method: "DELETE" }); setDetail(null); await load(); };
  const batch = async (action: string, extra: any = {}) => { if (action === "delete") { if (!confirm(`删除选中的 ${selected.length} 份资料？`)) return; for (const id of selected) await api(`/api/admin/documents/${id}`, { method: "DELETE" }); } else await api("/api/admin/documents/batch-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selected, action, ...extra }) }); setSelected([]); await load(); };
  const testSearch = async () => { const data = await api<{ items: any[] }>(`/api/admin/documents/${detail.item.id}/search-test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: testQuery }) }); setTestResults(data.items); };
  const replace = async (file?: File) => { if (!file) return; const form = new FormData(); form.set("file", file); await upload(`/api/admin/documents/${detail.item.id}/replace`, form, setProgress); await openDetail(detail.item.id); await load(); };
  const provideOcr = async (form: HTMLFormElement) => { const data = new FormData(form); await upload(`/api/admin/documents/${detail.item.id}/ocr-result`, data, setProgress); setMessage("OCR 结果已提交，正在重新索引"); setDetail(null); await load(); };
  const ready = items.filter((item) => item.status === "indexed").length, processing = items.filter((item) => ["uploaded", "parsing", "embedding"].includes(item.status)).length, failed = items.filter((item) => ["failed", "needs_ocr"].includes(item.status)).length;
  return <>
    <header className="page-head"><div><p>知识库</p><h1>资料馆与 Agent 检索证据管理</h1></div><button className="primary" onClick={() => setOpen(true)}>＋ 添加数据源</button></header>
    {message && <div className="notice">{message}</div>}
    <div className="content-stats"><article><span>全部资料</span><strong>{items.length}</strong></article><article><span>已完成索引</span><strong>{ready}</strong></article><article><span>正在处理</span><strong>{processing}</strong></article><article><span>异常资料</span><strong>{failed}</strong></article></div>
    <div className="library-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或文件名…"/><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部集合</option>{knowledgeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="indexed">已就绪</option><option value="parsing">解析中</option><option value="embedding">向量化中</option><option value="failed">失败</option><option value="needs_ocr">需要 OCR</option></select><select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="">全部范围</option><option value="rag_only">仅供 Agent</option><option value="public">公开引用</option><option value="private">完全私有</option></select>{selected.length > 0 && <div className="batch-actions"><span>已选 {selected.length}</span><button onClick={() => void batch("retry")}>重建索引</button><button className="danger-link" onClick={() => void batch("delete")}>删除</button></div>}</div>
    <section className="panel library-table knowledge-library"><table><thead><tr><th><input type="checkbox" checked={filtered.length > 0 && selected.length === filtered.length} onChange={(event) => setSelected(event.target.checked ? filtered.map((item) => item.id) : [])}/></th><th>资料</th><th>集合</th><th>范围</th><th>处理状态</th><th>切片</th><th></th></tr></thead><tbody>{filtered.length ? filtered.map((item) => <tr key={item.id}><td><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}/></td><td><button className="table-title" onClick={() => void openDetail(item.id)}><span className="file-badge">{item.source_type.toUpperCase()}</span><span><strong>{item.title}</strong><small>{item.original_name || "内部文字"} · {formatBytes(item.file_size)} · v{item.current_version || 1}</small></span></button>{item.error_message && <small className="error-text">{item.error_message}</small>}</td><td>{item.category_name || "未归集"}</td><td>{item.visibility === "public" ? "公开引用" : item.visibility === "private" ? "完全私有" : "仅供 Agent"}</td><td><span className={`status ${item.status === "indexed" ? "ok" : ["uploaded", "parsing", "embedding"].includes(item.status) ? "running" : ""}`}>{statusText[item.status] || item.status}</span>{["uploaded", "parsing", "embedding"].includes(item.status) && <div className="mini-progress"><span style={{ width: `${item.ingestion_progress || 10}%` }}/></div>}</td><td>{item.chunk_count}</td><td><div className="row-actions"><button onClick={() => void openDetail(item.id)}>详情</button><a href={`/api/admin/documents/${item.id}/download`}>下载</a><button className="danger-link" onClick={() => void remove(item.id)}>删除</button></div></td></tr>) : <tr><td colSpan={7}>没有符合条件的资料。</td></tr>}</tbody></table></section>
    {open && <div className="modal-backdrop" onMouseDown={() => !busy && setOpen(false)}><form className="modal import-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><small>资料馆</small><h2>添加数据源</h2></div><button type="button" onClick={() => setOpen(false)}>×</button></div><div className="editor-mode"><button type="button" className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>上传文件</button><button type="button" className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>直接输入</button><button type="button" className={mode === "url" ? "active" : ""} onClick={() => setMode("url")}>网页 URL</button></div>{mode === "file" ? <label className="upload"><input name="files" required multiple type="file" accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown"/><strong>选择 PDF / Markdown / TXT</strong><span>支持多选；单个最大 20MB</span></label> : mode === "text" ? <><label>标题 <b className="required-mark">*</b><input name="title" required/></label><label>文字内容 <b className="required-mark">*</b><textarea name="text" required rows={10}/></label></> : <><label>网页地址 <b className="required-mark">*</b><input name="url" type="url" required placeholder="https://…"/></label><label>标题<input name="title" placeholder="留空时自动提取"/></label></>}<label>集合<select name="categoryId"><option value="">未归集</option>{knowledgeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>使用范围<select name="visibility" defaultValue="rag_only"><option value="rag_only">仅供 Agent</option><option value="public">公开并允许引用</option><option value="private">完全私有</option></select></label>{progress > 0 && <div className="upload-progress"><span style={{ width: `${progress}%` }}/><small>上传 {progress}%</small></div>}<div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy}>{busy ? "处理中…" : "添加并建立索引"}</button></div></form></div>}
    {detail && <div className="channel-drawer-backdrop" onMouseDown={() => setDetail(null)}><section className="channel-drawer library-detail" onMouseDown={(event) => event.stopPropagation()}><div className="channel-drawer-head"><div><p>{detail.item.source_type.toUpperCase()} · v{detail.item.current_version}</p><h2>{detail.item.title}</h2></div><button onClick={() => setDetail(null)}>×</button></div><div className="detail-tabs">{[["info", "基本信息"], ["content", "解析内容"], ["chunks", `RAG 切片 ${detail.chunks.length}`], ["test", "检索测试"], ["history", "版本记录"]].map(([id, label]) => <button key={id} className={detailTab === id ? "active" : ""} onClick={() => setDetailTab(id)}>{label}</button>)}</div><div className="channel-drawer-body detail-body">{detailTab === "info" && <div className="detail-info"><dl><div><dt>原文件</dt><dd>{detail.item.original_name}</dd></div><div><dt>文件大小</dt><dd>{formatBytes(detail.item.file_size)}</dd></div><div><dt>索引状态</dt><dd>{statusText[detail.item.status] || detail.item.status}</dd></div><div><dt>使用范围</dt><dd>{detail.item.visibility}</dd></div><div><dt>来源</dt><dd>{detail.item.source_url || "本地上传"}</dd></div></dl><label className="replace-file">替换为新版本<input type="file" accept=".pdf,.md,.txt" onChange={(event) => void replace(event.target.files?.[0])}/></label>{detail.item.status === "needs_ocr" && <form className="ocr-panel" onSubmit={(event) => { event.preventDefault(); void provideOcr(event.currentTarget); }}><strong>提供 OCR 结果</strong><p>当前不会把私有 PDF 自动发送给第三方。请上传本地 OCR 后的 Markdown/TXT，或直接粘贴文字。</p><input name="file" type="file" accept=".md,.txt,text/plain,text/markdown"/><textarea name="text" rows={6} placeholder="粘贴 OCR 文字…"/><button className="primary">提交并重新索引</button></form>}</div>}{detailTab === "content" && <MarkdownPreview value={detail.item.parsed_text || ""}/>} {detailTab === "chunks" && <div className="chunk-list">{detail.chunks.map((chunk: any) => <article key={chunk.id}><header><strong>切片 #{chunk.chunk_index + 1}</strong><small>{parse<string[]>(chunk.heading_path, []).join(" / ")}</small></header><p>{chunk.content}</p></article>)}</div>}{detailTab === "test" && <div className="search-test"><div className="inline"><input value={testQuery} onChange={(event) => setTestQuery(event.target.value)} placeholder="输入问题，测试该资料的召回结果"/><button className="primary" onClick={() => void testSearch()}>测试</button></div>{testResults.map((item) => <article key={item.id}><strong>相似度 {(item.score * 100).toFixed(1)}% · 切片 #{item.chunkIndex + 1}</strong><p>{item.content}</p></article>)}</div>}{detailTab === "history" && <div className="version-list">{detail.versions.map((version: any) => <article key={version.id}><div><strong>版本 {version.version_number} · {version.original_name}</strong><small>{formatBytes(version.file_size)} · {new Date(version.created_at).toLocaleString("zh-CN")}</small></div></article>)}</div>}</div><div className="channel-drawer-actions"><a className="secondary-button" href={`/api/admin/documents/${detail.item.id}/download`}>下载当前版本</a><button className="danger-link" onClick={() => void remove(detail.item.id)}>删除资料</button></div></section></div>}
  </>;
}

const emptyCategory = { id: "", name: "", slug: "", scope: "article", description: "", sortOrder: 0, showInPortal: true };
export function CategoriesManager() {
  const [items, setItems] = useState<Category[]>([]), [editing, setEditing] = useState<any | null>(null), [message, setMessage] = useState("");
  const load = async () => setItems((await api<{ items: Category[] }>("/api/admin/categories")).items);
  useEffect(() => { void load(); }, []);
  const save = async (event: React.FormEvent) => { event.preventDefault(); const method = editing.id ? "PUT" : "POST", url = editing.id ? `/api/admin/categories/${editing.id}` : "/api/admin/categories"; await api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(editing) }); setEditing(null); setMessage("分类已保存"); await load(); };
  const remove = async (item: Category) => { const replacement = prompt(`该分类包含 ${item.article_count || 0} 篇文章和 ${item.document_count || 0} 份资料。输入目标分类 ID 可合并，留空则移动到未分类。`); if (replacement === null) return; await api(`/api/admin/categories/${item.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(replacement ? { replacementCategoryId: replacement } : { uncategorize: true }) }); await load(); };
  return <><header className="page-head"><div><p>内容分类</p><h1>管理门户分类与知识库集合</h1></div><button className="primary" onClick={() => setEditing({ ...emptyCategory })}>＋ 新建分类</button></header>{message && <div className="notice">{message}</div>}<section className="category-admin-grid">{items.map((item) => <article key={item.id}><div><span className={`scope-badge ${item.scope}`}>{item.scope === "article" ? "文章分类" : item.scope === "knowledge" ? "知识集合" : "共享分类"}</span><h2>{item.name}</h2><p>{item.description || "暂无描述"}</p></div><dl><div><dt>Slug</dt><dd>{item.slug}</dd></div><div><dt>内容</dt><dd>{item.article_count || 0} 篇文章 · {item.document_count || 0} 份资料</dd></div><div><dt>门户</dt><dd>{item.show_in_portal ? "展示" : "隐藏"}</dd></div></dl><div className="row-actions"><button onClick={() => setEditing({ id: item.id, name: item.name, slug: item.slug, scope: item.scope, description: item.description || "", sortOrder: item.sort_order || 0, showInPortal: Boolean(item.show_in_portal) })}>编辑</button><button className="danger-link" onClick={() => void remove(item)}>删除/合并</button></div></article>)}</section>{editing && <div className="modal-backdrop" onMouseDown={() => setEditing(null)}><form className="modal" onSubmit={save} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><h2>{editing.id ? "编辑分类" : "新建分类"}</h2><button type="button" onClick={() => setEditing(null)}>×</button></div><label>名称 <b className="required-mark">*</b><input required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })}/></label><label>Slug <b className="required-mark">*</b><input required pattern="[a-z0-9-]+" value={editing.slug} onChange={(event) => setEditing({ ...editing, slug: event.target.value })}/></label><label>类型<select value={editing.scope} onChange={(event) => setEditing({ ...editing, scope: event.target.value })}><option value="article">文章分类</option><option value="knowledge">知识集合</option><option value="shared">共享分类</option></select></label><label>描述<textarea rows={3} value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })}/></label><label>排序<input type="number" min="0" value={editing.sortOrder} onChange={(event) => setEditing({ ...editing, sortOrder: Number(event.target.value) })}/></label><label className="checkbox"><input type="checkbox" checked={editing.showInPortal} onChange={(event) => setEditing({ ...editing, showInPortal: event.target.checked })}/><span>在门户分类页展示</span></label><div className="modal-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button className="primary">保存分类</button></div></form></div>}</>;
}
