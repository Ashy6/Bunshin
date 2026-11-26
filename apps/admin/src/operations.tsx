import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { formatMicros, normalizeSeoKeywords, pageCount } from "./operations-utils";

echarts.use([
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type Summary = {
  requests: number;
  tokens: number;
  cost_micros: number;
  avg_latency_ms: number;
  success_rate: number;
};
type Trend = { day: string; requests: number; tokens: number };
type ProviderShare = {
  name: string;
  requests: number;
  tokens: number;
  cost_micros: number;
};
type RecentDocument = {
  id: string;
  title: string;
  source_type: string;
  status: string;
  chunk_count: number;
  ingestion_progress: number;
  updated_at: string;
  category_name: string | null;
};
type DashboardData = {
  days: number;
  summary: Summary;
  trends: Trend[];
  providerShare: ProviderShare[];
  documents: { total: number; ready: number; processing: number; failed: number };
  recentDocuments: RecentDocument[];
};
type UsageEvent = {
  id: string;
  scenario: string;
  provider_name: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_micros: number;
  currency: string;
  latency_ms: number;
  status: string;
  estimated: number;
  trace_id: string;
  created_at: string;
};
type UsageData = {
  items: UsageEvent[];
  total: number;
  page: number;
  pageSize: number;
  days: number;
  summary: Summary;
  providers: Array<{
    id: string;
    name: string;
    chat_model: string;
    embedding_model: string;
  }>;
  scenarios: Array<{ scenario: string }>;
};
export type SystemConfig = {
  publicOrigin: string;
  defaultSeoDescription: string;
  seoKeywords: string[];
  llmsFullEnabled: boolean;
  cacheTtlSeconds: number;
};

const emptySummary: Summary = {
  requests: 0,
  tokens: 0,
  cost_micros: 0,
  avg_latency_ms: 0,
  success_rate: 0,
};
const statusLabels: Record<string, string> = {
  success: "成功",
  failed: "失败",
  uploaded: "等待处理",
  parsing: "解析中",
  embedding: "向量化中",
  indexed: "已索引",
  needs_ocr: "需要 OCR",
  archived: "已归档",
};
const scenarioLabels: Record<string, string> = {
  chat: "Agent 问答",
  query_embedding: "问题向量化",
  document_embedding: "文档向量化",
};
const number = (value: number | undefined) =>
  new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
const money = formatMicros;
const percent = (value: number | undefined) =>
  `${Number(value ?? 0).toFixed(1)}%`;
const dateTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
const currentDate = () =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

function AnalyticsChart({
  kind,
  trends = [],
  shares = [],
}: {
  kind: "line" | "pie";
  trends?: Trend[];
  shares?: ProviderShare[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current),
      option =
        kind === "line"
          ? {
              animationDuration: 300,
              grid: {
                left: 12,
                right: 18,
                top: 56,
                bottom: 16,
                containLabel: true,
              },
              tooltip: { trigger: "axis" },
              legend: {
                data: ["请求", "Token"],
                top: 8,
                right: 8,
                itemGap: 18,
              },
              xAxis: {
                type: "category",
                data: trends.map((item) => item.day.slice(5)),
                axisLine: { lineStyle: { color: "#dfe3e8" } },
                axisLabel: { margin: 12, hideOverlap: true },
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
                  data: trends.map((item) => item.requests),
                  itemStyle: { color: "#496d8d" },
                  areaStyle: { color: "rgba(73,109,141,.08)" },
                },
                {
                  name: "Token",
                  type: "line",
                  smooth: true,
                  data: trends.map((item) => item.tokens),
                  itemStyle: { color: "#96a9b9" },
                },
              ],
              media: [
                {
                  query: { maxWidth: 520 },
                  option: {
                    legend: { top: 6, left: "center", right: "auto" },
                    grid: { left: 6, right: 6, top: 52, bottom: 10 },
                  },
                },
              ],
            }
          : {
              tooltip: {
                trigger: "item",
                formatter: "{b}<br/>{c} 次 · {d}%",
              },
              legend: {
                bottom: 0,
                left: "center",
                type: "scroll",
              },
              series: [
                {
                  type: "pie",
                  radius: ["43%", "67%"],
                  center: ["50%", "43%"],
                  avoidLabelOverlap: true,
                  data: shares.map((item) => ({
                    name: item.name,
                    value: item.requests,
                  })),
                  label: { show: shares.length <= 5, formatter: "{b}" },
                  itemStyle: {
                    borderRadius: 5,
                    borderColor: "#fff",
                    borderWidth: 3,
                  },
                  color: ["#496d8d", "#8aa4ba", "#c0ced9", "#718798"],
                },
              ],
            };
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [kind, shares, trends]);
  return <div ref={ref} className="chart" />;
}

export function DashboardOperations() {
  const [days, setDays] = useState(7),
    [data, setData] = useState<DashboardData | null>(null),
    [publicOrigin, setPublicOrigin] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setError("");
    Promise.all([
      fetch(`/api/admin/analytics/dashboard?days=${days}`).then((response) => {
        if (!response.ok) throw new Error("读取概览失败");
        return response.json() as Promise<DashboardData>;
      }),
      fetch("/api/admin/settings")
        .then(
          (response) =>
            response.json() as Promise<{ config?: SystemConfig }>,
        )
        .then((body) => body.config?.publicOrigin || ""),
    ])
      .then(([next, origin]) => {
        setData(next);
        setPublicOrigin(origin);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "读取概览失败"),
      );
  }, [days]);
  const summary = data?.summary ?? emptySummary,
    stats = [
      { label: `最近 ${days} 天请求`, value: number(summary.requests), delta: `${percent(summary.success_rate)} 成功` },
      { label: "Token 消耗", value: number(summary.tokens), delta: "输入 + 输出 + 缓存" },
      { label: "预估费用", value: money(summary.cost_micros), delta: `${number(summary.avg_latency_ms)} ms 平均延迟` },
      { label: "RAG 文档", value: number(data?.documents.ready), delta: `共 ${number(data?.documents.total)} 份资料` },
    ];
  return (
    <>
      <header className="page-head">
        <div>
          <p>{currentDate()}</p>
          <h1>你的分身运行概况</h1>
        </div>
        <button
          className="primary"
          disabled={!publicOrigin}
          onClick={() => publicOrigin && window.open(publicOrigin, "_blank", "noopener,noreferrer")}
        >
          {publicOrigin ? "查看公开站点 ↗" : "请先配置公开站地址"}
        </button>
      </header>
      {error && <div className="notice error-text">{error}</div>}
      <section className="stats">
        {stats.map((item) => (
          <article key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.delta}</small>
          </article>
        ))}
      </section>
      <section className="grid operations-grid">
        <article className="panel wide">
          <div className="panel-title">
            <div><h2>调用趋势</h2><p>真实请求与 Token 变化</p></div>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </div>
          {data?.trends.length ? <AnalyticsChart kind="line" trends={data.trends} /> : <div className="chart-empty">暂无调用数据</div>}
        </article>
        <article className="panel">
          <div className="panel-title"><div><h2>渠道占比</h2><p>按真实请求次数统计</p></div></div>
          {data?.providerShare.length ? <AnalyticsChart kind="pie" shares={data.providerShare} /> : <div className="chart-empty">暂无渠道数据</div>}
        </article>
        <article className="panel wide">
          <div className="panel-title">
            <div><h2>最近任务</h2><p>文档解析与向量化状态</p></div>
            <button className="link" onClick={() => { location.hash = "/knowledge"; }}>全部任务</button>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>文档</th><th>分类</th><th>状态</th><th>进度</th><th>切片</th><th>更新时间</th></tr></thead>
              <tbody>
                {data?.recentDocuments.length ? data.recentDocuments.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.title}</strong><small>{item.source_type.toUpperCase()}</small></td>
                    <td>{item.category_name || "未分类"}</td>
                    <td><span className={`status ${item.status === "indexed" ? "ok" : ["uploaded", "parsing", "embedding"].includes(item.status) ? "running" : ""}`}>{statusLabels[item.status] || item.status}</span></td>
                    <td>{item.ingestion_progress}%</td>
                    <td>{item.chunk_count}</td>
                    <td>{dateTime(item.updated_at)}</td>
                  </tr>
                )) : <tr><td colSpan={6}>还没有文档任务。</td></tr>}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </>
  );
}

export function UsageManager() {
  const [days, setDays] = useState(30),
    [providerId, setProviderId] = useState(""),
    [scenario, setScenario] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<UsageData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const query = new URLSearchParams({ days: String(days), page: String(page), pageSize: "20" });
    if (providerId) query.set("providerId", providerId);
    if (scenario) query.set("scenario", scenario);
    if (status) query.set("status", status);
    setError("");
    fetch(`/api/admin/usage?${query}`)
      .then((response) => {
        if (!response.ok) throw new Error("读取用量明细失败");
        return response.json() as Promise<UsageData>;
      })
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败"));
  }, [days, page, providerId, scenario, status]);
  const summary = data?.summary ?? emptySummary,
    pages = pageCount(data?.total ?? 0, data?.pageSize ?? 20);
  const resetPage = (action: () => void) => {
    setPage(1);
    action();
  };
  const exportCsv = () => {
    if (!data?.items.length) return;
    const rows = [
      ["时间", "场景", "渠道", "模型", "输入 Token", "输出 Token", "缓存 Token", "费用(USD)", "延迟(ms)", "状态", "Trace ID"],
      ...data.items.map((item) => [
        item.created_at,
        scenarioLabels[item.scenario] || item.scenario,
        item.provider_name || "-",
        item.model,
        item.input_tokens,
        item.output_tokens,
        item.cached_tokens,
        (item.cost_micros / 1_000_000).toFixed(6),
        item.latency_ms,
        item.status,
        item.trace_id,
      ]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n"),
      url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" })),
      link = document.createElement("a");
    link.href = url;
    link.download = `bunshin-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <header className="page-head">
        <div><p>用量明细</p><h1>查看模型调用、Token 与费用</h1></div>
        <button className="secondary-button" onClick={exportCsv} disabled={!data?.items.length}>导出当前页 CSV</button>
      </header>
      {error && <div className="notice error-text">{error}</div>}
      <section className="stats usage-stats">
        <article><span>请求</span><strong>{number(summary.requests)}</strong><small>{percent(summary.success_rate)} 成功</small></article>
        <article><span>Token</span><strong>{number(summary.tokens)}</strong><small>输入、输出与缓存合计</small></article>
        <article><span>费用</span><strong>{money(summary.cost_micros)}</strong><small>按渠道单价估算</small></article>
        <article><span>平均延迟</span><strong>{number(summary.avg_latency_ms)} ms</strong><small>所有筛选结果</small></article>
      </section>
      <div className="usage-filters">
        <label>时间<select value={days} onChange={(event) => resetPage(() => setDays(Number(event.target.value)))}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option><option value={365}>最近一年</option></select></label>
        <label>渠道<select value={providerId} onChange={(event) => resetPage(() => setProviderId(event.target.value))}><option value="">全部渠道</option>{data?.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>场景<select value={scenario} onChange={(event) => resetPage(() => setScenario(event.target.value))}><option value="">全部场景</option>{data?.scenarios.map((item) => <option key={item.scenario} value={item.scenario}>{scenarioLabels[item.scenario] || item.scenario}</option>)}</select></label>
        <label>状态<select value={status} onChange={(event) => resetPage(() => setStatus(event.target.value))}><option value="">全部状态</option><option value="success">成功</option><option value="failed">失败</option></select></label>
      </div>
      <section className="panel usage-table">
        <div className="table-scroll">
          <table>
            <thead><tr><th>时间</th><th>场景 / 渠道</th><th>模型</th><th>Token</th><th>费用</th><th>延迟</th><th>状态</th><th>Trace ID</th></tr></thead>
            <tbody>
              {data?.items.length ? data.items.map((item) => (
                <tr key={item.id}>
                  <td>{dateTime(item.created_at)}</td>
                  <td><strong>{scenarioLabels[item.scenario] || item.scenario}</strong><small>{item.provider_name || "未关联渠道"}</small></td>
                  <td>{item.model}{item.estimated ? <small>Token 为估算值</small> : null}</td>
                  <td>{number(item.input_tokens + item.output_tokens + item.cached_tokens)}<small>入 {number(item.input_tokens)} / 出 {number(item.output_tokens)}</small></td>
                  <td>{money(item.cost_micros)}</td>
                  <td>{number(item.latency_ms)} ms</td>
                  <td><span className={`status ${item.status === "success" ? "ok" : ""}`}>{statusLabels[item.status] || item.status}</span></td>
                  <td><code title={item.trace_id}>{item.trace_id.slice(0, 8)}…</code></td>
                </tr>
              )) : <tr><td colSpan={8}>当前筛选条件下没有调用记录。</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pagination"><span>共 {number(data?.total)} 条 · 第 {page}/{pages} 页</span><div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></div></div>
      </section>
    </>
  );
}

type ObservabilityData = {
  hours:number;
  requests:{total:number;errors:number;avg_duration_ms:number;slow:number};
  usage:{total:number;errors:number;avg_latency_ms:number;cost_micros:number};
  rag:{queries:number;avg_retrieval_ms:number;no_match:number;avg_top_score:number};
  queue:{total:number;processing:number;retrying:number;completed:number};
  alerts:Array<{id:string;severity:string;title:string;message:string;status:string;last_seen_at:string}>;
  events:Array<{id:string;service:string;event_type:string;severity:string;route:string|null;duration_ms:number;status_code:number;trace_id:string;created_at:string}>;
  budgets:Array<{id:string;name:string;monthly_budget_micros:number;spent_micros:number}>;
  stuck:Array<{id:string;title:string;status:string;ingestion_progress:number;updated_at:string}>;
};

export function ObservabilityManager(){
  const [hours,setHours]=useState(24),[data,setData]=useState<ObservabilityData|null>(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;const load=()=>fetch(`/api/admin/observability?hours=${hours}`).then((response)=>{if(!response.ok)throw new Error("读取生产监控失败");return response.json() as Promise<ObservabilityData>}).then((body)=>{if(active){setData(body);setError("")}}).catch((reason)=>active&&setError(reason instanceof Error?reason.message:"读取失败"));void load();const timer=setInterval(load,30000);return()=>{active=false;clearInterval(timer)}},[hours,refresh]);
  const requestErrorRate=data?.requests.total?data.requests.errors/data.requests.total*100:0,modelErrorRate=data?.usage.total?data.usage.errors/data.usage.total*100:0,noMatchRate=data?.rag.queries?data.rag.no_match/data.rag.queries*100:0;
  const acknowledge=async(id:string)=>{await fetch(`/api/admin/observability/alerts/${id}/ack`,{method:"POST"});setRefresh((value)=>value+1)};
  return <>
    <header className="page-head"><div><p>生产监控</p><h1>告警、错误率与卡死信号</h1></div><div className="monitor-actions"><select value={hours} onChange={(event)=>setHours(Number(event.target.value))}><option value={1}>最近 1 小时</option><option value={24}>最近 24 小时</option><option value={168}>最近 7 天</option></select><button className="secondary-button" onClick={()=>setRefresh((value)=>value+1)}>立即刷新</button></div></header>
    {error&&<div className="notice error-text">{error}</div>}
    <section className="stats"><article><span>HTTP 错误率</span><strong>{requestErrorRate.toFixed(1)}%</strong><small>{number(data?.requests.total)} 次请求 · {number(data?.requests.slow)} 次慢请求</small></article><article><span>模型错误率</span><strong>{modelErrorRate.toFixed(1)}%</strong><small>{number(data?.usage.avg_latency_ms)} ms 平均延迟</small></article><article><span>RAG 未命中</span><strong>{noMatchRate.toFixed(1)}%</strong><small>{number(data?.rag.avg_retrieval_ms)} ms 平均检索</small></article><article><span>队列风险</span><strong>{number(data?.queue.retrying)}</strong><small>{number(data?.queue.processing)} 处理中 · {number(data?.stuck.length)} 卡死</small></article></section>
    <section className="monitor-grid">
      <article className="panel monitor-alerts"><div className="panel-title"><div><h2>当前告警</h2><p>每分钟自动评估，支持人工确认</p></div><span className={`status ${data?.alerts.length?"running":"ok"}`}>{data?.alerts.length||0} 条</span></div>{data?.alerts.length?data.alerts.map((alert)=><div className={`monitor-alert ${alert.severity}`} key={alert.id}><div><strong>{alert.title}</strong><p>{alert.message}</p><small>{dateTime(alert.last_seen_at)} · {alert.status==="acknowledged"?"已确认":"待处理"}</small></div>{alert.status==="open"&&<button onClick={()=>void acknowledge(alert.id)}>确认</button>}</div>):<div className="empty-inline">当前没有活动告警。</div>}</article>
      <article className="panel"><div className="panel-title"><div><h2>月度预算</h2><p>达到 80% 自动预警</p></div></div><div className="budget-list">{data?.budgets.length?data.budgets.map((budget)=>{const ratio=budget.monthly_budget_micros>0?Math.min(100,budget.spent_micros/budget.monthly_budget_micros*100):0;return <div key={budget.id}><span><strong>{budget.name}</strong><small>{budget.monthly_budget_micros?`${money(budget.spent_micros)} / ${money(budget.monthly_budget_micros)}`:"未设置预算"}</small></span><progress max="100" value={ratio}/></div>}):<p className="muted-copy">还没有模型渠道。</p>}</div></article>
      <article className="panel monitor-events"><div className="panel-title"><div><h2>最近事件</h2><p>Trace ID 可关联请求、模型和 Queue</p></div></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>服务 / 事件</th><th>路由</th><th>耗时</th><th>状态</th><th>Trace</th></tr></thead><tbody>{data?.events.length?data.events.map((event)=><tr key={event.id}><td>{dateTime(event.created_at)}</td><td><strong>{event.service}</strong><small>{event.event_type}</small></td><td>{event.route||"-"}</td><td>{number(event.duration_ms)} ms</td><td><span className={`status ${event.severity==="info"?"ok":event.severity==="warning"?"running":""}`}>{event.status_code||event.severity}</span></td><td><code title={event.trace_id}>{event.trace_id.slice(0,8)}…</code></td></tr>):<tr><td colSpan={6}>暂无事件。</td></tr>}</tbody></table></div></article>
    </section>
  </>;
}

export function SystemSettings() {
  const [config, setConfig] = useState<SystemConfig | null>(null),
    [keywords, setKeywords] = useState(""),
    [saving, setSaving] = useState(false),
    [repairing, setRepairing] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    fetch("/api/admin/settings")
      .then((response) => response.json() as Promise<{ config: SystemConfig }>)
      .then((body) => {
        setConfig(body.config);
        setKeywords(body.config.seoKeywords.join(", "));
      })
      .catch(() => setMessage("读取系统设置失败"));
  }, []);
  const changedKeywords = useMemo(
    () => normalizeSeoKeywords(keywords),
    [keywords],
  );
  if (!config) return <div className="panel empty"><p>{message || "正在读取系统设置…"}</p></div>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, seoKeywords: changedKeywords }),
    });
    const body = await response.json() as { config?: SystemConfig; error?: unknown };
    setSaving(false);
    if (!response.ok || !body.config) {
      setMessage("保存失败，请检查 URL 和字段长度");
      return;
    }
    setConfig(body.config);
    setMessage("系统设置已保存，公开站 SEO 配置已同步");
  };
  const repair = async () => {
    setRepairing(true);
    setMessage("");
    const response = await fetch("/api/admin/maintenance/repair-document-metadata", { method: "POST" }),
      body = await response.json() as { scanned?: number; repaired?: number; missing?: number };
    setRepairing(false);
    setMessage(response.ok ? `扫描 ${body.scanned || 0} 份资料，修复 ${body.repaired || 0} 份，缺失 ${body.missing || 0} 份` : "附件元数据修复失败");
  };
  return (
    <>
      <header className="page-head"><div><p>系统设置</p><h1>配置公开地址、SEO 与缓存</h1></div></header>
      {message && <div className="notice">{message}</div>}
      <form className="settings-layout" onSubmit={submit}>
        <section className="panel form-stack">
          <div className="section-heading"><div><h2>站点与 SEO</h2><p>这些配置会直接用于公开站的 canonical、站点地图和 GEO 文件。</p></div></div>
          <label>公开站正式地址 <b className="required-mark">*</b><input type="url" required value={config.publicOrigin} onChange={(event) => setConfig({ ...config, publicOrigin: event.target.value })} placeholder="https://example.com"/><small>请填写访客最终访问的 HTTPS 域名，不要带末尾斜杠。</small></label>
          <label>默认 SEO 描述 <b className="required-mark">*</b><textarea required rows={4} maxLength={300} value={config.defaultSeoDescription} onChange={(event) => setConfig({ ...config, defaultSeoDescription: event.target.value })}/><small>{config.defaultSeoDescription.length}/300</small></label>
          <label>SEO / GEO 关键词<input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="AI 分身, RAG, 个人简历"/><small>用逗号分隔，最多 30 个。</small></label>
          <label className="checkbox"><input type="checkbox" checked={config.llmsFullEnabled} onChange={(event) => setConfig({ ...config, llmsFullEnabled: event.target.checked })}/><span><strong>开放 llms-full.txt</strong><small>开启后搜索引擎和 AI 爬虫可读取完整公开资料与文章正文。</small></span></label>
          <label>公开页面缓存时间<select value={config.cacheTtlSeconds} onChange={(event) => setConfig({ ...config, cacheTtlSeconds: Number(event.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option><option value={3600}>1 小时</option><option value={86400}>1 天</option></select></label>
          <div className="profile-actions"><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存系统设置"}</button></div>
        </section>
        <aside className="settings-side">
          <section className="panel"><h2>SEO 入口</h2><div className="settings-links">{config.publicOrigin ? <><a href={`${config.publicOrigin}/sitemap.xml`} target="_blank" rel="noreferrer">Sitemap ↗</a><a href={`${config.publicOrigin}/robots.txt`} target="_blank" rel="noreferrer">Robots ↗</a><a href={`${config.publicOrigin}/llms.txt`} target="_blank" rel="noreferrer">llms.txt ↗</a></> : <p>保存公开站地址后显示。</p>}</div></section>
          <section className="panel"><h2>数据维护</h2><p className="muted-copy">重新读取 R2 附件大小、文件名和索引进度，修复旧版本遗留元数据。</p><button type="button" className="secondary-button" disabled={repairing} onClick={() => void repair()}>{repairing ? "修复中…" : "修复附件元数据"}</button></section>
        </aside>
      </form>
    </>
  );
}
