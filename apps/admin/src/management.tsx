import React, { useEffect, useMemo, useRef, useState } from "react";

type DocumentRow = {
  id: string; title: string; source_type: string; category_id?: string | null;
  visibility: string; status: string; chunk_count: number; error_message?: string | null;
  category_name?: string | null; original_name?: string | null; file_size?: number;
  purpose?: string; archived_at?: string | null; created_at?: string; updated_at?: string;
};
type Category = { id: string; name: string; slug: string; scope?: string; description?: string };
type Experience = { title: string; organization: string; period: string; summary: string };
type Project = { name: string; role: string; url: string; summary: string };
type Education = { school: string; degree: string; period: string; summary: string };
type ProfileForm = {
  displayName: string; headline: string; bio: string; location: string; markdownBio: string;
  skills: string; github: string; linkedin: string; x: string; zhihu: string;
  websiteUrl: string; publicEmail: string; published: boolean; ragEnabled: boolean;
  experiences: Experience[]; projects: Project[]; education: Education[];
  avatarPositionX: number; avatarPositionY: number;
};
const emptyProfile: ProfileForm = {
  displayName: "", headline: "", bio: "", location: "", markdownBio: "", skills: "",
  github: "", linkedin: "", x: "", zhihu: "", websiteUrl: "", publicEmail: "",
  published: true, ragEnabled: true, experiences: [], projects: [], education: [],
  avatarPositionX: 50, avatarPositionY: 50,
};
const statusLabel: Record<string, string> = {
  uploaded: "等待处理", parsing: "解析中", embedding: "向量化中", indexed: "已索引",
  needs_ocr: "需要 OCR", failed: "处理失败", archived: "已归档",
};
const visibilityLabel: Record<string, string> = { public: "公开引用", rag_only: "仅供 Agent", private: "完全私有" };
function json<T>(value: string | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init), text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `请求失败（HTTP ${response.status}）`);
  return body as T;
}
function formatBytes(value = 0) {
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function publicUrl(path: string) {
  const origin = location.origin.includes(":8788")
    ? location.origin.replace(":8788", ":8787")
    : location.origin.replace("-admin.", "-web.");
  return `${origin}${path}`;
}
function MarkdownPreview({ value, empty = "还没有内容" }: { value: string; empty?: string }) {
  if (!value.trim()) return <div className="markdown-empty">{empty}</div>;
  const lines = value.replaceAll("\\n", "\n").replace(/\r/g, "").split("\n"), nodes: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || "";
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const code: string[] = []; index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) code.push(lines[index++]!);
      index += 1; nodes.push(<pre key={index}><code>{code.join("\n")}</code></pre>); continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length, content = heading[2]!;
      nodes.push(level === 1 ? <h1 key={index}>{content}</h1> : level === 2 ? <h2 key={index}>{content}</h2> : <h3 key={index}>{content}</h3>); index += 1; continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!)) items.push(lines[index++]!.replace(/^[-*]\s+/, ""));
      nodes.push(<ul key={index}>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>); continue;
    }
    if (/^>\s?/.test(line)) { nodes.push(<blockquote key={index}>{line.replace(/^>\s?/, "")}</blockquote>); index += 1; continue; }
    const parts = [line]; index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,4})\s|^[-*]\s+|^>|^```/.test(lines[index]!)) parts.push(lines[index++]!);
    nodes.push(<p key={index}>{parts.map((part, i) => <React.Fragment key={i}>{i > 0 && <br />}{part}</React.Fragment>)}</p>);
  }
  return <div className="markdown-preview">{nodes}</div>;
}

export function ProfileManager() {
  const [profile, setProfile] = useState<ProfileForm>(emptyProfile), [initial, setInitial] = useState(""),
    [active, setActive] = useState("basic"), [message, setMessage] = useState(""), [saving, setSaving] = useState(false),
    [avatarVersion, setAvatarVersion] = useState(0), [avatarMessage, setAvatarMessage] = useState(""),
    [documents, setDocuments] = useState<DocumentRow[]>([]), [versions, setVersions] = useState<Array<{ id: string; snapshot_json: string; created_at: string }>>([]),
    [resumeBusy, setResumeBusy] = useState(false), [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const dirty = initial !== "" && JSON.stringify(profile) !== initial;
  const load = async () => {
    const [p, d, v] = await Promise.all([
      api<{ profile: any }>("/api/admin/profile"), api<{ items: DocumentRow[] }>("/api/admin/documents"),
      api<{ items: Array<{ id: string; snapshot_json: string; created_at: string }> }>("/api/admin/profile/versions"),
    ]);
    const raw = p.profile, social = json<Record<string, string>>(raw?.social_json, {});
    const next: ProfileForm = raw ? {
      displayName: raw.display_name || "", headline: raw.headline || "", bio: raw.bio || "", location: raw.location || "",
      markdownBio: raw.markdown_bio || "", skills: json<string[]>(raw.skills_json, []).join(", "),
      github: social.github || "", linkedin: social.linkedin || "", x: social.x || "", zhihu: social.zhihu || "",
      websiteUrl: raw.website_url || "", publicEmail: raw.public_email || "", published: Boolean(raw.published),
      ragEnabled: raw.rag_enabled === undefined ? true : Boolean(raw.rag_enabled),
      experiences: json<Experience[]>(raw.experience_json, []), projects: json<Project[]>(raw.project_json, []),
      education: json<Education[]>(raw.education_json, []), avatarPositionX: raw.avatar_position_x ?? 50, avatarPositionY: raw.avatar_position_y ?? 50,
    } : emptyProfile;
    setProfile(next); setInitial(JSON.stringify(next)); setDocuments(d.items); setVersions(v.items);
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    document.body.dataset.unsaved = dirty ? "true" : "false";
    const before = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", before);
    return () => { delete document.body.dataset.unsaved; window.removeEventListener("beforeunload", before); };
  }, [dirty]);
  const field = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => setProfile((old) => ({ ...old, [key]: value }));
  const save = async () => {
    setSaving(true); setMessage("");
    try {
      await api("/api/admin/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        ...profile, location: profile.location || null, websiteUrl: profile.websiteUrl || null, publicEmail: profile.publicEmail || null,
        skills: [...new Set(profile.skills.split(/[,，]/).map((item) => item.trim()).filter(Boolean))],
        social: { github: profile.github, linkedin: profile.linkedin, x: profile.x, zhihu: profile.zhihu },
      }) });
      setInitial(JSON.stringify(profile)); setMessage("已保存，公开页面与 Agent 索引正在同步"); await load(); window.dispatchEvent(new CustomEvent("bunshin:profile-updated"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const uploadAvatar = async (file?: File) => {
    if (!file) return; setAvatarMessage("正在上传头像…");
    try { const data = new FormData(); data.set("file", file); await api("/api/admin/profile/avatar", { method: "POST", body: data }); setAvatarVersion(Date.now()); setAvatarMessage("头像已更新"); window.dispatchEvent(new CustomEvent("bunshin:profile-updated")); }
    catch (error) { setAvatarMessage(error instanceof Error ? error.message : "头像上传失败"); }
  };
  const deleteAvatar = async () => { if (!confirm("恢复为名称首字头像？")) return; await api("/api/admin/profile/avatar", { method: "DELETE" }); setAvatarVersion(Date.now()); setAvatarMessage("已恢复默认头像"); window.dispatchEvent(new CustomEvent("bunshin:profile-updated")); };
  const uploadResume = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setResumeBusy(true); setUploadProgress(0); const form = event.currentTarget;
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const request = new XMLHttpRequest(); request.open("POST", "/api/admin/documents");
      request.upload.onprogress = (e) => e.lengthComputable && setUploadProgress(Math.round(e.loaded / e.total * 100));
      request.onload = () => { let body: any = {}; try { body = JSON.parse(request.responseText); } catch {} resolve({ ok: request.status >= 200 && request.status < 300, error: body.error }); };
      request.onerror = () => resolve({ ok: false, error: "网络中断" }); request.send(new FormData(form));
    });
    setResumeBusy(false); if (!result.ok) { setMessage(result.error || "上传失败"); setUploadProgress(null); return; }
    setUploadProgress(100); form.reset(); setMessage("新简历已上传，旧版本已归档并退出检索"); await load(); window.setTimeout(() => setUploadProgress(null), 1200);
  };
  const retry = async (id: string) => { await api(`/api/admin/documents/${id}/retry`, { method: "POST" }); await load(); };
  const remove = async (id: string) => { if (!confirm("删除这份简历附件及其索引？")) return; await api(`/api/admin/documents/${id}`, { method: "DELETE" }); await load(); };
  const restoreVersion = (snapshot: string) => {
    const raw = json<any>(snapshot, null); if (!raw) return; const social = json<Record<string, string>>(raw.social_json, {});
    setProfile({ displayName: raw.display_name || "", headline: raw.headline || "", bio: raw.bio || "", location: raw.location || "", markdownBio: raw.markdown_bio || "", skills: json<string[]>(raw.skills_json, []).join(", "), github: social.github || "", linkedin: social.linkedin || "", x: social.x || "", zhihu: social.zhihu || "", websiteUrl: raw.website_url || "", publicEmail: raw.public_email || "", published: Boolean(raw.published), ragEnabled: raw.rag_enabled === undefined ? true : Boolean(raw.rag_enabled), experiences: json<Experience[]>(raw.experience_json, []), projects: json<Project[]>(raw.project_json, []), education: json<Education[]>(raw.education_json, []), avatarPositionX: raw.avatar_position_x ?? 50, avatarPositionY: raw.avatar_position_y ?? 50 });
    setMessage("历史版本已载入，检查后点击保存才会生效"); setActive("basic");
  };
  const currentResume = documents.find((item) => item.purpose === "resume" && !item.archived_at), history = documents.filter((item) => item.purpose === "resume" && item.id !== currentResume?.id);
  const addList = (type: "experiences" | "projects" | "education") => field(type, [...profile[type], type === "experiences" ? { title: "", organization: "", period: "", summary: "" } : type === "projects" ? { name: "", role: "", url: "", summary: "" } : { school: "", degree: "", period: "", summary: "" }] as any);
  const updateList = (type: "experiences" | "projects" | "education", index: number, key: string, value: string) => field(type, profile[type].map((item, i) => i === index ? { ...item, [key]: value } : item) as any);
  const removeList = (type: "experiences" | "projects" | "education", index: number) => field(type, profile[type].filter((_, i) => i !== index) as any);
  return <>
    <header className="page-head"><div><p>个人资料</p><h1>维护身份、公开页面与 Agent 资料</h1></div><div className="head-actions"><a className="secondary-button" href={publicUrl("/about")} target="_blank" rel="noreferrer">预览公开页 ↗</a><button className="primary" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "保存中…" : dirty ? "保存更改" : "已保存"}</button></div></header>
    <div className="publish-strip"><span className={profile.published ? "status ok" : "status"}>{profile.published ? "公开资料已发布" : "公开资料未发布"}</span><span className={profile.ragEnabled ? "status ok" : "status"}>{profile.ragEnabled ? "Agent 可使用个人资料" : "个人资料未进入 Agent"}</span>{dirty && <span className="unsaved-badge">有未保存更改</span>}</div>
    <nav className="subnav" aria-label="个人资料分区">{[["basic","基本信息"],["about","关于我"],["structured","经历与项目"],["resume","简历附件"],["history","版本记录"]].map(([id,label]) => <button className={active === id ? "active" : ""} onClick={() => setActive(id!)} key={id}>{label}</button>)}</nav>
    {active === "basic" && <div className="profile-two-column"><section className="panel form-stack"><div className="section-heading"><div><h2>身份信息</h2><p>名称是唯一必填项，其余内容为空时前台自动隐藏。</p></div></div><div className="avatar-editor"><label className="avatar-button"><img src={`/api/admin/profile/avatar?v=${avatarVersion}`} style={{ objectPosition: `${profile.avatarPositionX}% ${profile.avatarPositionY}%` }} alt="当前头像"/><span>替换</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => void uploadAvatar(e.target.files?.[0])}/></label><div className="avatar-upload-control"><strong>头像</strong><span>点击上传；没有头像时显示名称首字。</span><button className="text-button" type="button" onClick={() => void deleteAvatar()}>恢复默认</button>{avatarMessage && <small>{avatarMessage}</small>}</div></div><div className="crop-controls"><label>水平位置 <input type="range" min="0" max="100" value={profile.avatarPositionX} onChange={(e) => field("avatarPositionX", Number(e.target.value))}/></label><label>垂直位置 <input type="range" min="0" max="100" value={profile.avatarPositionY} onChange={(e) => field("avatarPositionY", Number(e.target.value))}/></label></div><label><span>显示名称 <b className="required-mark">*</b></span><input required value={profile.displayName} onChange={(e) => field("displayName", e.target.value)}/></label><label>职业标题<input value={profile.headline} onChange={(e) => field("headline", e.target.value)}/></label><label>一句话介绍<textarea rows={3} value={profile.bio} onChange={(e) => field("bio", e.target.value)}/></label><label>所在地<input value={profile.location} onChange={(e) => field("location", e.target.value)}/></label><label>技能标签<input value={profile.skills} onChange={(e) => field("skills", e.target.value)} placeholder="TypeScript, RAG, Cloudflare"/><small>使用逗号分隔，保存时自动去重。</small></label></section><section className="panel form-stack"><div className="section-heading"><div><h2>公开链接</h2><p>只展示填写过的项目，邮箱默认不填写。</p></div></div><label>个人网站<input type="url" value={profile.websiteUrl} onChange={(e) => field("websiteUrl", e.target.value)}/></label><label>公开邮箱<input type="email" value={profile.publicEmail} onChange={(e) => field("publicEmail", e.target.value)}/></label><label>GitHub<input type="url" value={profile.github} onChange={(e) => field("github", e.target.value)}/></label><label>LinkedIn<input type="url" value={profile.linkedin} onChange={(e) => field("linkedin", e.target.value)}/></label><label>X / Twitter<input type="url" value={profile.x} onChange={(e) => field("x", e.target.value)}/></label><label>知乎<input type="url" value={profile.zhihu} onChange={(e) => field("zhihu", e.target.value)}/></label><div className="switch-card"><label className="checkbox"><input type="checkbox" checked={profile.published} onChange={(e) => field("published", e.target.checked)}/><span><strong>公开展示个人资料</strong><small>控制前台侧栏和“关于”页面，不影响 Agent。</small></span></label><label className="checkbox"><input type="checkbox" checked={profile.ragEnabled} onChange={(e) => field("ragEnabled", e.target.checked)}/><span><strong>允许 Agent 使用个人资料</strong><small>单独控制个人资料是否向量化，不影响前台展示。</small></span></label></div></section></div>}
    {active === "about" && <section className="panel editor-workspace"><div className="editor-pane"><div className="section-heading"><div><h2>Markdown 个人介绍</h2><p>支持标题、列表、引用和代码块。</p></div><span>{profile.markdownBio.length.toLocaleString()} 字符</span></div><textarea value={profile.markdownBio} onChange={(e) => field("markdownBio", e.target.value)} placeholder="# 关于我\n\n介绍你的经历、观点和关注方向…"/></div><div className="preview-pane"><div className="section-heading"><div><h2>实时预览</h2><p>接近公开页面的排版效果。</p></div></div><MarkdownPreview value={profile.markdownBio}/></div></section>}
    {active === "structured" && <div className="structured-sections">{(["experiences","projects","education"] as const).map((type) => <section className="panel repeat-section" key={type}><div className="section-heading"><div><h2>{type === "experiences" ? "工作与实践经历" : type === "projects" ? "代表项目" : "教育经历"}</h2><p>结构化内容更适合前台展示和 Agent 精确检索。</p></div><button className="secondary-button" onClick={() => addList(type)}>＋ 添加</button></div>{profile[type].length ? profile[type].map((item: any, index) => <article className="repeat-card" key={index}><div className="repeat-grid">{Object.keys(item).map((key) => <label key={key}>{({ title:"职位 / 角色",organization:"组织 / 公司",period:"时间",summary:"说明",name:"项目名称",role:"项目角色",url:"项目链接",school:"学校",degree:"专业 / 学位" } as Record<string,string>)[key] || key}{key === "summary" ? <textarea rows={3} value={item[key]} onChange={(e) => updateList(type,index,key,e.target.value)}/> : <input type={key === "url" ? "url" : "text"} value={item[key]} onChange={(e) => updateList(type,index,key,e.target.value)}/>}</label>)}</div><button className="danger-link" onClick={() => removeList(type,index)}>删除这一项</button></article>) : <div className="attachment-empty">还没有内容，点击“添加”开始维护。</div>}</section>)}</div>}
    {active === "resume" && <section className="panel resume-manager"><div className="section-heading"><div><h2>当前简历</h2><p>上传新简历会自动归档旧版本，并从旧索引中移除。</p></div></div>{currentResume ? <DocumentCard item={currentResume} onRetry={retry} onDelete={remove}/> : <div className="attachment-empty">还没有当前简历</div>}<form className="resume-upload" onSubmit={uploadResume}><input type="hidden" name="purpose" value="resume"/><label>简历标题 <b className="required-mark">*</b><input name="title" required placeholder="例如：2026 个人简历"/></label><label className="upload"><input name="file" required type="file" accept=".pdf,.md,application/pdf,text/markdown,text/plain"/><strong>选择 PDF / Markdown</strong><span>最大 20MB</span></label><label>可见性<select name="visibility" defaultValue="rag_only"><option value="rag_only">仅供 Agent</option><option value="public">公开并允许引用</option><option value="private">完全私有</option></select></label><button className="primary" disabled={resumeBusy}>{resumeBusy ? "上传中…" : currentResume ? "上传并替换" : "上传简历"}</button></form>{uploadProgress !== null && <div className="upload-progress"><div><span>上传进度</span><strong>{uploadProgress}%</strong></div><progress max="100" value={uploadProgress}/></div>}{history.length > 0 && <div className="history-list"><h3>历史简历</h3>{history.map((item) => <DocumentCard key={item.id} item={item} onRetry={retry} onDelete={remove}/>)}</div>}</section>}
    {active === "history" && <section className="panel"><div className="section-heading"><div><h2>个人资料版本</h2><p>每次保存前自动保留上一版本。</p></div></div><div className="version-list">{versions.length ? versions.map((version) => { const snapshot = json<any>(version.snapshot_json, {}); return <article key={version.id}><div><strong>{snapshot.display_name || "未命名资料"}</strong><span>{new Date(version.created_at).toLocaleString("zh-CN")}</span></div><button className="secondary-button" onClick={() => restoreVersion(version.snapshot_json)}>载入此版本</button></article>; }) : <div className="attachment-empty">保存第二个版本后，这里会出现历史记录。</div>}</div></section>}
    {message && <div className="sticky-save"><span>{message}</span><button className="primary" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "保存中…" : "保存全部更改"}</button></div>}
  </>;
}

function DocumentCard({ item, onRetry, onDelete }: { item: DocumentRow; onRetry: (id: string) => void; onDelete: (id: string) => void }) {
  return <article className="document-card"><span className="document-type">{item.source_type.toUpperCase()}</span><div><strong>{item.title}</strong><small>{item.original_name || "内部生成"} · {formatBytes(item.file_size)} · {statusLabel[item.status] || item.status}</small>{item.error_message && <em>{item.error_message}</em>}</div><div className="row-actions">{item.status !== "indexed" && item.status !== "archived" && <button onClick={() => void onRetry(item.id)}>重试</button>}<a href={`/api/admin/documents/${item.id}/download`}>下载</a><button className="danger-link" onClick={() => void onDelete(item.id)}>删除</button></div></article>;
}

type ArticleRow = { id: string; title: string; slug: string; excerpt: string; body: string; category_id: string | null; status: string; include_in_rag: number; seo_description?: string | null; updated_at: string; category_name?: string };
const emptyArticle = { id: "", title: "", slug: "", excerpt: "", body: "", categoryId: "", status: "draft", includeInRag: true, seoDescription: "" };
export function ArticlesManager() {
  const [items, setItems] = useState<ArticleRow[]>([]), [categories, setCategories] = useState<Category[]>([]), [editor, setEditor] = useState<any | null>(null), [preview, setPreview] = useState(false), [message, setMessage] = useState(""), [saving, setSaving] = useState(false);
  const load = async () => { const [a,c] = await Promise.all([api<{ items: ArticleRow[] }>("/api/admin/articles"),api<{ items: Category[] }>("/api/admin/categories")]); setItems(a.items); setCategories(c.items); };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    requestAnimationFrame(() => document.querySelectorAll<HTMLAnchorElement>('a[href^="/articles/"]').forEach((link) => {
      link.href = publicUrl(new URL(link.href).pathname);
    }));
  }, [items]);
  const open = (item?: ArticleRow) => setEditor(item ? { id:item.id,title:item.title,slug:item.slug,excerpt:item.excerpt,body:item.body,categoryId:item.category_id || "",status:item.status,includeInRag:Boolean(item.include_in_rag),seoDescription:item.seo_description || "" } : { ...emptyArticle });
  const save = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setMessage(""); try { await api(editor.id ? `/api/admin/articles/${editor.id}` : "/api/admin/articles", { method: editor.id ? "PUT" : "POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ ...editor, categoryId:editor.categoryId || null, seoDescription:editor.seoDescription || null }) }); setEditor(null); setMessage("文章已保存，公开页面和 RAG 正在同步"); await load(); } catch(error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { setSaving(false); } };
  const remove = async (id: string) => { if (!confirm("删除文章以及对应的 RAG 索引？")) return; await api(`/api/admin/articles/${id}`,{method:"DELETE"}); await load(); };
  const createCategory = async () => { const name = prompt("分类名称"); if (!name) return; const suggested = name.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"") || `category-${Date.now()}`; const slug = prompt("分类 URL 标识（小写字母、数字、连字符）", suggested); if (!slug) return; await api("/api/admin/categories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,slug,scope:"article"})}); await load(); };
  return <><header className="page-head"><div><p>文章管理</p><h1>发布文章并同步到公开站点与 RAG</h1></div><button className="primary" onClick={() => open()}>＋ 新建文章</button></header>{message && <div className="notice">{message}</div>}<div className="toolbar"><input placeholder="搜索文章…" onChange={(e) => { const term=e.target.value.toLowerCase(); document.querySelectorAll<HTMLElement>("[data-article-row]").forEach((row)=>row.hidden=!row.dataset.articleRow?.includes(term)); }}/><button className="secondary-button" onClick={() => void createCategory()}>＋ 新建分类</button></div><section className="panel"><table><thead><tr><th>文章</th><th>分类</th><th>状态</th><th>Agent</th><th>更新时间</th><th></th></tr></thead><tbody>{items.length ? items.map((item)=><tr key={item.id} data-article-row={`${item.title} ${item.slug}`.toLowerCase()}><td><strong>{item.title}</strong><small>/{item.slug}</small></td><td>{item.category_name || "未分类"}</td><td><span className={`status ${item.status === "published" ? "ok" : ""}`}>{item.status === "published" ? "已发布" : item.status === "archived" ? "已归档" : "草稿"}</span></td><td>{item.include_in_rag ? "已启用" : "未启用"}</td><td>{new Date(item.updated_at).toLocaleString("zh-CN")}</td><td><div className="row-actions"><button onClick={()=>open(item)}>编辑</button>{item.status === "published" && <a href={`/articles/${item.slug}`} target="_blank" rel="noreferrer">查看</a>}<button className="danger-link" onClick={()=>void remove(item.id)}>删除</button></div></td></tr>):<tr><td colSpan={6}>还没有文章。</td></tr>}</tbody></table></section>{editor && <div className="channel-drawer-backdrop" onMouseDown={()=>!saving&&setEditor(null)}><form className="channel-drawer article-drawer" onSubmit={save} onMouseDown={(e)=>e.stopPropagation()}><div className="channel-drawer-head"><div><p>文章</p><h2>{editor.id ? "编辑文章" : "新建文章"}</h2></div><button type="button" onClick={()=>setEditor(null)}>×</button></div><div className="channel-drawer-body"><div className="editor-mode"><button type="button" className={!preview?"active":""} onClick={()=>setPreview(false)}>编辑</button><button type="button" className={preview?"active":""} onClick={()=>setPreview(true)}>预览</button></div>{preview?<MarkdownPreview value={editor.body}/>:<><label>标题 <b className="required-mark">*</b><input required value={editor.title} onChange={(e)=>setEditor({...editor,title:e.target.value})}/></label><label>Slug <b className="required-mark">*</b><input required pattern="[a-z0-9-]+" value={editor.slug} onChange={(e)=>setEditor({...editor,slug:e.target.value})}/></label><label>摘要<textarea rows={3} value={editor.excerpt} onChange={(e)=>setEditor({...editor,excerpt:e.target.value})}/></label><label>Markdown 正文 <b className="required-mark">*</b><textarea className="article-body" required value={editor.body} onChange={(e)=>setEditor({...editor,body:e.target.value})}/></label><label>分类<select value={editor.categoryId} onChange={(e)=>setEditor({...editor,categoryId:e.target.value})}><option value="">未分类</option>{categories.filter((c)=>c.scope!=="knowledge").map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>SEO 描述<textarea rows={2} value={editor.seoDescription} onChange={(e)=>setEditor({...editor,seoDescription:e.target.value})}/></label><label>状态<select value={editor.status} onChange={(e)=>setEditor({...editor,status:e.target.value})}><option value="draft">草稿</option><option value="published">发布</option><option value="archived">归档</option></select></label><label className="checkbox"><input type="checkbox" checked={editor.includeInRag} onChange={(e)=>setEditor({...editor,includeInRag:e.target.checked})}/><span>允许 Agent 检索这篇文章</span></label></>}</div><div className="channel-drawer-actions"><button type="button" onClick={()=>setEditor(null)}>取消</button><button className="primary" disabled={saving}>{saving?"保存中…":"保存文章"}</button></div></form></div>}</>;
}

export function KnowledgeManager() {
  const [items,setItems]=useState<DocumentRow[]>([]),[categories,setCategories]=useState<Category[]>([]),[open,setOpen]=useState(false),[mode,setMode]=useState<"file"|"text">("file"),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[query,setQuery]=useState(""),[categoryFilter,setCategoryFilter]=useState(""),[statusFilter,setStatusFilter]=useState("");
  const load=async()=>{const[d,c]=await Promise.all([api<{items:DocumentRow[]}>("/api/admin/documents"),api<{items:Category[]}>("/api/admin/categories")]);setItems(d.items);setCategories(c.items);};
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),5000);return()=>clearInterval(timer);},[]);
  const filtered=useMemo(()=>items.filter((item)=>item.purpose!=="profile"&&item.purpose!=="article"&&(!query||`${item.title} ${item.original_name}`.toLowerCase().includes(query.toLowerCase()))&&(!categoryFilter||item.category_id===categoryFilter)&&(!statusFilter||item.status===statusFilter)),[items,query,categoryFilter,statusFilter]);
  const submit=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();setBusy(true);setMessage("");try{await api("/api/admin/documents",{method:"POST",body:new FormData(event.currentTarget)});setOpen(false);setMessage("资料已上传，正在解析和建立索引");await load();}catch(error){setMessage(error instanceof Error?error.message:"上传失败");}finally{setBusy(false);}};
  const update=async(item:DocumentRow,key:"visibility"|"categoryId",value:string)=>{await api(`/api/admin/documents/${item.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({[key]:value||null})});await load();};
  const retry=async(id:string)=>{await api(`/api/admin/documents/${id}/retry`,{method:"POST"});await load();};
  const remove=async(id:string)=>{if(!confirm("删除原文件、解析内容和向量索引？"))return;await api(`/api/admin/documents/${id}`,{method:"DELETE"});await load();};
  const createCategory=async()=>{const name=prompt("新分类名称");if(!name)return;const slug=prompt("分类 URL 标识",`knowledge-${Date.now()}`);if(!slug)return;await api("/api/admin/categories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,slug,scope:"knowledge"})});await load();};
  return <><header className="page-head"><div><p>知识库</p><h1>管理 Agent 可以检索的资料</h1></div><button className="primary" onClick={()=>setOpen(true)}>＋ 添加数据源</button></header>{message&&<div className="notice">{message}</div>}<div className="toolbar"><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="搜索文档…"/><select value={categoryFilter} onChange={(e)=>setCategoryFilter(e.target.value)}><option value="">全部分类</option>{categories.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)}><option value="">全部状态</option><option value="indexed">已索引</option><option value="failed">失败</option><option value="needs_ocr">需要 OCR</option><option value="archived">已归档</option></select></div><section className="panel"><table><thead><tr><th>资料</th><th>分类</th><th>可见性</th><th>状态</th><th>切片</th><th></th></tr></thead><tbody>{filtered.length?filtered.map((item)=><tr key={item.id}><td><strong>{item.title}</strong><small>{item.original_name||item.source_type.toUpperCase()} · {formatBytes(item.file_size)}</small>{item.error_message&&<small className="error-text">{item.error_message}</small>}</td><td><select value={item.category_id||""} onChange={(e)=>void update(item,"categoryId",e.target.value)}><option value="">未分类</option>{categories.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></td><td><select value={item.visibility} onChange={(e)=>void update(item,"visibility",e.target.value)}><option value="public">公开引用</option><option value="rag_only">仅供 Agent</option><option value="private">完全私有</option></select></td><td><span className={`status ${item.status==="indexed"?"ok":item.status==="parsing"||item.status==="embedding"?"running":""}`}>{statusLabel[item.status]||item.status}</span></td><td>{item.chunk_count}</td><td><div className="row-actions">{item.status!=="indexed"&&item.status!=="archived"&&<button onClick={()=>void retry(item.id)}>重试</button>}{item.original_name&&<a href={`/api/admin/documents/${item.id}/download`}>下载</a>}<button className="danger-link" onClick={()=>void remove(item.id)}>删除</button></div></td></tr>):<tr><td colSpan={6}>没有符合条件的资料。</td></tr>}</tbody></table></section>{open&&<div className="modal-backdrop" onMouseDown={()=>!busy&&setOpen(false)}><form className="modal" onSubmit={submit} onMouseDown={(e)=>e.stopPropagation()}><div className="modal-head"><h2>添加知识资料</h2><button type="button" onClick={()=>setOpen(false)}>×</button></div><div className="editor-mode"><button type="button" className={mode==="file"?"active":""} onClick={()=>setMode("file")}>上传文件</button><button type="button" className={mode==="text"?"active":""} onClick={()=>setMode("text")}>直接输入文字</button></div><label>标题 <b className="required-mark">*</b><input name="title" required/></label>{mode==="file"?<label className="upload"><input name="file" required type="file" accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown"/><strong>选择 PDF / Markdown / TXT</strong><span>单文件最大 20MB</span></label>:<label>文字内容 <b className="required-mark">*</b><textarea name="text" required rows={10} placeholder="粘贴知识内容…"/></label>}<label>分类<div className="inline"><select name="categoryId"><option value="">未分类</option>{categories.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select><button type="button" onClick={()=>void createCategory()}>新建分类</button></div></label><label>可见性<select name="visibility" defaultValue="rag_only"><option value="rag_only">仅供 Agent</option><option value="public">公开并允许引用</option><option value="private">完全私有</option></select></label><div className="modal-actions"><button type="button" onClick={()=>setOpen(false)}>取消</button><button className="primary" disabled={busy}>{busy?"处理中…":"上传并建立索引"}</button></div></form></div>}</>;
}
