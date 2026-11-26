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
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  success_count?: number;
  error_count?: number;
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
  providerBreakdown: Array<{ name: string; requests: number; tokens: number; cost_micros: number; success_rate: number }>;
  scenarioBreakdown: Array<{ scenario: string; requests: number; tokens: number; cost_micros: number }>;
};
export type SystemConfig = {
  publicOrigin: string;
  defaultSeoDescription: string;
  seoKeywords: string[];
  llmsFullEnabled: boolean;
  cacheTtlSeconds: number;
};
type ObservabilityConfig = {
  errorRateThreshold: number;
  minimumRequests: number;
  stuckMinutes: number;
  budgetWarningPercent: number;
  slowRequestMs: number;
};
type SystemSettingsData = {
  config: SystemConfig;
  observability: ObservabilityConfig;
  status: {
    publicOriginConfigured: boolean;
    profileName: string;
    profilePublished: boolean;
    providerName: string;
    providerHealth: string;
    documents: { total: number; ready: number; failed: number };
    articles: { total: number; published: number };
  };
  recentAudits: Array<{ action: string; target_type: string; target_id: string | null; created_at: string }>;
  updatedAt: string | null;
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
  provider_test: "渠道测试",
  retrieval: "RAG 检索",
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
const navigateAdmin = (event: React.MouseEvent<HTMLAnchorElement>, path: string) => {
  event.preventDefault();
  if (document.body.dataset.unsaved === "true" && !confirm("当前页面有未保存更改，确定离开吗？")) return;
  location.hash = `/${path}`;
};

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
      { label: `最近 ${days} 天请求`, value: number(summary.requests), delta: `${percent(summary.success_rate)} 成功`, href: "#/usage" },
      { label: "Token 消耗", value: number(summary.tokens), delta: "输入 + 输出 + 缓存", href: "#/usage" },
      { label: "预估费用", value: money(summary.cost_micros), delta: `${number(summary.avg_latency_ms)} ms 平均延迟`, href: "#/usage" },
      { label: "RAG 文档", value: number(data?.documents.ready), delta: `共 ${number(data?.documents.total)} 份资料`, href: "#/knowledge" },
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
          onClick={() => publicOrigin ? window.open(publicOrigin, "_blank", "noopener,noreferrer") : location.assign("#/settings")}
        >
          {publicOrigin ? "查看公开站点 ↗" : "请先配置公开站地址"}
        </button>
      </header>
      {error && <div className="notice error-text">{error}</div>}
      <section className="stats">
        {stats.map((item) => (
          <a className="stat-link" href={item.href} key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.delta}</small>
          </a>
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
            <a className="link" href="#/knowledge">全部任务 →</a>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>文档</th><th>分类</th><th>状态</th><th>进度</th><th>切片</th><th>更新时间</th></tr></thead>
              <tbody>
                {data?.recentDocuments.length ? data.recentDocuments.map((item) => (
                  <tr key={item.id}>
                    <td><a className="task-link" href="#/knowledge"><strong>{item.title}</strong><small>{item.source_type.toUpperCase()}</small></a></td>
                    <td>{item.category_name || "未分类"}</td>
                    <td><span className={`status ${item.status === "indexed" ? "ok" : ["uploaded", "parsing", "embedding"].includes(item.status) ? "running" : ""}`}>{statusLabels[item.status] || item.status}</span></td>
                    <td>{item.ingestion_progress}%</td>
                    <td>{item.chunk_count}</td>
                    <td>{dateTime(item.updated_at)}</td>
                  </tr>
                )) : <tr><td colSpan={6}><div className="table-empty"><strong>还没有文档任务</strong><span>上传 PDF 或 Markdown 后，解析与向量化进度会显示在这里。</span><a href="#/knowledge">前往知识库上传 →</a></div></td></tr>}
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
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [copied, setCopied] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const query = new URLSearchParams({ days: String(days), page: String(page), pageSize: "20" });
    if (providerId) query.set("providerId", providerId);
    if (scenario) query.set("scenario", scenario);
    if (status) query.set("status", status);
    setError(""); setLoading(true);
    fetch(`/api/admin/usage?${query}`)
      .then((response) => {
        if (!response.ok) throw new Error("读取用量明细失败");
        return response.json() as Promise<UsageData>;
      })
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败"))
      .finally(() => setLoading(false));
  }, [days, page, providerId, refresh, scenario, status]);
  const summary = data?.summary ?? emptySummary,
    pages = pageCount(data?.total ?? 0, data?.pageSize ?? 20);
  const resetPage = (action: () => void) => {
    setPage(1);
    action();
  };
  const resetFilters = () => { setDays(30); setProviderId(""); setScenario(""); setStatus(""); setPage(1); };
  const copyTrace = async (traceId: string) => {
    await navigator.clipboard.writeText(traceId);
    setCopied(traceId);
    window.setTimeout(() => setCopied((value) => value === traceId ? "" : value), 1600);
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
        <div className="head-actions"><button className="secondary-button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>{loading ? "刷新中…" : "刷新数据"}</button><button className="secondary-button" onClick={exportCsv} disabled={!data?.items.length}>导出当前页 CSV</button></div>
      </header>
      {error && <div className="notice error-text">{error}</div>}
      <section className="stats usage-stats">
        <article><span>请求</span><strong>{number(summary.requests)}</strong><small>{number(summary.success_count)} 成功 · {number(summary.error_count)} 失败</small></article>
        <article><span>Token</span><strong>{number(summary.tokens)}</strong><small>入 {number(summary.input_tokens)} · 出 {number(summary.output_tokens)} · 缓存 {number(summary.cached_tokens)}</small></article>
        <article><span>费用</span><strong>{money(summary.cost_micros)}</strong><small>按渠道单价估算</small></article>
        <article><span>平均延迟</span><strong>{number(summary.avg_latency_ms)} ms</strong><small>所有筛选结果</small></article>
      </section>
      <div className="usage-filters">
        <label>时间<select value={days} onChange={(event) => resetPage(() => setDays(Number(event.target.value)))}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option><option value={365}>最近一年</option></select></label>
        <label>渠道<select value={providerId} onChange={(event) => resetPage(() => setProviderId(event.target.value))}><option value="">全部渠道</option>{data?.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>场景<select value={scenario} onChange={(event) => resetPage(() => setScenario(event.target.value))}><option value="">全部场景</option>{data?.scenarios.map((item) => <option key={item.scenario} value={item.scenario}>{scenarioLabels[item.scenario] || item.scenario}</option>)}</select></label>
        <label>状态<select value={status} onChange={(event) => resetPage(() => setStatus(event.target.value))}><option value="">全部状态</option><option value="success">成功</option><option value="failed">失败</option></select></label>
        <button className="filter-reset" type="button" onClick={resetFilters}>重置筛选</button>
      </div>
      <section className="usage-breakdown">
        <article className="panel"><div className="panel-title"><div><h2>渠道消耗</h2><p>按当前筛选范围汇总</p></div></div>{data?.providerBreakdown.length ? <div className="breakdown-list">{data.providerBreakdown.map((item) => <div key={item.name}><span><strong>{item.name}</strong><small>{number(item.requests)} 次 · {percent(item.success_rate)} 成功</small></span><span><strong>{money(item.cost_micros)}</strong><small>{number(item.tokens)} Token</small></span></div>)}</div> : <div className="empty-inline">暂无渠道调用</div>}</article>
        <article className="panel"><div className="panel-title"><div><h2>调用场景</h2><p>区分问答、检索与向量化</p></div></div>{data?.scenarioBreakdown.length ? <div className="breakdown-list">{data.scenarioBreakdown.map((item) => <div key={item.scenario}><span><strong>{scenarioLabels[item.scenario] || item.scenario}</strong><small>{number(item.requests)} 次请求</small></span><span><strong>{number(item.tokens)}</strong><small>{money(item.cost_micros)}</small></span></div>)}</div> : <div className="empty-inline">暂无场景数据</div>}</article>
      </section>
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
                  <td><button className="trace-button" type="button" title="复制完整 Trace ID" onClick={() => void copyTrace(item.trace_id)}>{copied === item.trace_id ? "已复制" : `${item.trace_id.slice(0, 8)}…`}</button></td>
                </tr>
              )) : <tr><td colSpan={8}><div className="table-empty"><strong>{loading ? "正在读取调用记录…" : "当前筛选条件下没有调用记录"}</strong>{!loading && <><span>模型测试、文档向量化和访客问答产生的数据都会记录在这里。</span><div><a href="#/providers">配置模型渠道</a><a href="#/knowledge">上传知识资料</a><a href="#/agent">检查 Agent 设置</a></div></>}</div></td></tr>}
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
  config:ObservabilityConfig;
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
      <article className="panel monitor-alerts"><div className="panel-title"><div><h2>当前告警</h2><p>每 5 分钟自动评估，打开页面时也会立即检查</p></div><span className={`status ${data?.alerts.length?"running":"ok"}`}>{data?.alerts.length||0} 条</span></div>{data?.alerts.length?data.alerts.map((alert)=><div className={`monitor-alert ${alert.severity}`} key={alert.id}><div><strong>{alert.title}</strong><p>{alert.message}</p><small>{dateTime(alert.last_seen_at)} · {alert.status==="acknowledged"?"已确认":"待处理"}</small></div>{alert.status==="open"&&<button onClick={()=>void acknowledge(alert.id)}>确认</button>}</div>):<div className="empty-inline">当前没有活动告警。</div>}</article>
      <article className="panel"><div className="panel-title"><div><h2>月度预算</h2><p>达到 {data?.config.budgetWarningPercent ?? 80}% 自动预警</p></div></div><div className="budget-list">{data?.budgets.length?data.budgets.map((budget)=>{const ratio=budget.monthly_budget_micros>0?Math.min(100,budget.spent_micros/budget.monthly_budget_micros*100):0;return <div key={budget.id}><span><strong>{budget.name}</strong><small>{budget.monthly_budget_micros?`${money(budget.spent_micros)} / ${money(budget.monthly_budget_micros)}`:"未设置预算"}</small></span><progress max="100" value={ratio}/></div>}):<p className="muted-copy">还没有模型渠道。</p>}</div></article>
      <article className="panel monitor-events"><div className="panel-title"><div><h2>最近事件</h2><p>Trace ID 可关联请求、模型和 Queue</p></div></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>服务 / 事件</th><th>路由</th><th>耗时</th><th>状态</th><th>Trace</th></tr></thead><tbody>{data?.events.length?data.events.map((event)=><tr key={event.id}><td>{dateTime(event.created_at)}</td><td><strong>{event.service}</strong><small>{event.event_type}</small></td><td>{event.route||"-"}</td><td>{number(event.duration_ms)} ms</td><td><span className={`status ${event.severity==="info"?"ok":event.severity==="warning"?"running":""}`}>{event.status_code||event.severity}</span></td><td><code title={event.trace_id}>{event.trace_id.slice(0,8)}…</code></td></tr>):<tr><td colSpan={6}>暂无事件。</td></tr>}</tbody></table></div></article>
    </section>
  </>;
}

export function SystemSettings() {
  const [data, setData] = useState<SystemSettingsData | null>(null),
    [config, setConfig] = useState<SystemConfig | null>(null),
    [observability, setObservability] = useState<ObservabilityConfig | null>(null),
    [keywords, setKeywords] = useState(""),
    [initial, setInitial] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [repairing, setRepairing] = useState(false),
    [message, setMessage] = useState("");
  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/settings");
      if (!response.ok) throw new Error("读取系统设置失败");
      const body = await response.json() as SystemSettingsData;
      setData(body); setConfig(body.config); setObservability(body.observability);
      setKeywords(body.config.seoKeywords.join(", "));
      setInitial(JSON.stringify({ ...body.config, seoKeywords: body.config.seoKeywords, observability: body.observability }));
      setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "读取系统设置失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const changedKeywords = useMemo(
    () => normalizeSeoKeywords(keywords),
    [keywords],
  );
  const current = config && observability ? JSON.stringify({ ...config, seoKeywords: changedKeywords, observability }) : "",
    dirty = Boolean(initial && current !== initial);
  useEffect(() => {
    if (!config) return;
    document.body.dataset.unsaved = dirty ? "true" : "false";
    const before = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    addEventListener("beforeunload", before);
    return () => { delete document.body.dataset.unsaved; removeEventListener("beforeunload", before); };
  }, [config, dirty]);
  if (!config || !observability || !data) return <div className="panel empty"><p>{message || (loading ? "正在读取系统设置…" : "系统设置暂不可用")}</p><button className="secondary-button" onClick={() => void load()}>重新读取</button></div>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, seoKeywords: changedKeywords, observability }),
    });
    const body = await response.json().catch(() => ({})) as { config?: SystemConfig; observability?: ObservabilityConfig; updatedAt?: string; error?: unknown };
    setSaving(false);
    if (!response.ok || !body.config) {
      setMessage("保存失败，请检查 URL 和字段长度");
      return;
    }
    const nextObservability = body.observability ?? observability;
    setConfig(body.config); setObservability(nextObservability);
    setInitial(JSON.stringify({ ...body.config, seoKeywords: body.config.seoKeywords, observability: nextObservability }));
    setData((old) => old ? { ...old, config: body.config!, observability: nextObservability, updatedAt: body.updatedAt ?? old.updatedAt } : old);
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
      <header className="page-head"><div><p>系统设置</p><h1>站点发布、SEO 与运行策略</h1></div><div className="head-actions"><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? "检查中…" : "重新检查"}</button><button className="primary" type="submit" form="system-settings" disabled={saving || !dirty}>{saving ? "保存中…" : dirty ? "保存更改" : "已保存"}</button></div></header>
      {message && <div className="notice">{message}</div>}
      <div className="system-overview">
        <a href="#/profile" onClick={(event) => navigateAdmin(event, "profile")}><span className={`setup-indicator ${data.status.profilePublished ? "ready" : ""}`}/><div><strong>个人资料</strong><small>{data.status.profileName || "尚未设置名称"} · {data.status.profilePublished ? "已公开" : "未公开"}</small></div><b>管理 →</b></a>
        <a href="#/providers" onClick={(event) => navigateAdmin(event, "providers")}><span className={`setup-indicator ${data.status.providerHealth === "healthy" ? "ready" : ""}`}/><div><strong>模型渠道</strong><small>{data.status.providerName || "尚未配置"} · {data.status.providerHealth === "healthy" ? "连接正常" : data.status.providerName ? "需要检查" : "未接入"}</small></div><b>管理 →</b></a>
        <a href="#/knowledge" onClick={(event) => navigateAdmin(event, "knowledge")}><span className={`setup-indicator ${Number(data.status.documents.ready) > 0 ? "ready" : ""}`}/><div><strong>知识索引</strong><small>{number(data.status.documents.ready)} / {number(data.status.documents.total)} 已就绪 · {number(data.status.documents.failed)} 异常</small></div><b>查看 →</b></a>
        <a href="#/articles" onClick={(event) => navigateAdmin(event, "articles")}><span className={`setup-indicator ${Number(data.status.articles.published) > 0 ? "ready" : ""}`}/><div><strong>内容发布</strong><small>{number(data.status.articles.published)} / {number(data.status.articles.total)} 篇已发布</small></div><b>查看 →</b></a>
      </div>
      <form id="system-settings" className="settings-layout" onSubmit={submit}>
        <div className="settings-main">
        <section className="panel form-stack">
          <div className="section-heading"><div><h2>站点与 SEO</h2><p>这些配置会直接用于公开站的 canonical、站点地图和 GEO 文件。</p></div></div>
          <label>公开站正式地址 <b className="required-mark">*</b><input type="url" required value={config.publicOrigin} onChange={(event) => setConfig({ ...config, publicOrigin: event.target.value })} placeholder="https://example.com"/><small>请填写访客最终访问的 HTTPS 域名，不要带末尾斜杠。</small></label>
          <label>默认 SEO 描述 <b className="required-mark">*</b><textarea required rows={4} maxLength={300} value={config.defaultSeoDescription} onChange={(event) => setConfig({ ...config, defaultSeoDescription: event.target.value })}/><small>{config.defaultSeoDescription.length}/300</small></label>
          <label>SEO / GEO 关键词<input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="AI 分身, RAG, 个人简历"/><small>用逗号分隔，最多 30 个。</small></label>
          <label className="checkbox"><input type="checkbox" checked={config.llmsFullEnabled} onChange={(event) => setConfig({ ...config, llmsFullEnabled: event.target.checked })}/><span><strong>开放 llms-full.txt</strong><small>开启后搜索引擎和 AI 爬虫可读取完整公开资料与文章正文。</small></span></label>
          <label>公开页面缓存时间<select value={config.cacheTtlSeconds} onChange={(event) => setConfig({ ...config, cacheTtlSeconds: Number(event.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option><option value={3600}>1 小时</option><option value={86400}>1 天</option></select></label>
        </section>
        <section className="panel form-stack"><div className="section-heading"><div><h2>监控与告警阈值</h2><p>生产监控按照这些阈值识别错误、慢请求、卡死任务和预算风险。</p></div></div><div className="settings-field-grid"><label>模型错误率阈值（%）<input type="number" min="1" max="100" value={observability.errorRateThreshold} onChange={(event) => setObservability({ ...observability, errorRateThreshold: Number(event.target.value) })}/><small>达到阈值后创建告警。</small></label><label>最少采样请求数<input type="number" min="1" max="10000" value={observability.minimumRequests} onChange={(event) => setObservability({ ...observability, minimumRequests: Number(event.target.value) })}/><small>低于此请求量时不判断错误率。</small></label><label>任务卡死判定（分钟）<input type="number" min="1" max="1440" value={observability.stuckMinutes} onChange={(event) => setObservability({ ...observability, stuckMinutes: Number(event.target.value) })}/><small>文档或队列超过该时长未更新。</small></label><label>预算预警比例（%）<input type="number" min="1" max="100" value={observability.budgetWarningPercent} onChange={(event) => setObservability({ ...observability, budgetWarningPercent: Number(event.target.value) })}/><small>相对渠道月度预算计算。</small></label><label>慢请求阈值（毫秒）<input type="number" min="100" max="300000" step="100" value={observability.slowRequestMs} onChange={(event) => setObservability({ ...observability, slowRequestMs: Number(event.target.value) })}/><small>用于生产监控中的慢请求统计。</small></label></div></section>
        </div>
        <aside className="settings-side">
          <section className="panel"><h2>SEO 入口</h2><div className="settings-links">{config.publicOrigin ? <><a href={`${config.publicOrigin}/sitemap.xml`} target="_blank" rel="noreferrer">Sitemap ↗</a><a href={`${config.publicOrigin}/robots.txt`} target="_blank" rel="noreferrer">Robots ↗</a><a href={`${config.publicOrigin}/llms.txt`} target="_blank" rel="noreferrer">llms.txt ↗</a></> : <p>保存公开站地址后显示。</p>}</div></section>
          <section className="panel"><h2>数据维护</h2><p className="muted-copy">重新读取 R2 附件大小、文件名和索引进度，修复旧版本遗留元数据。</p><button type="button" className="secondary-button" disabled={repairing} onClick={() => void repair()}>{repairing ? "修复中…" : "修复附件元数据"}</button></section>
          <section className="panel"><h2>最近变更</h2><div className="audit-list">{data.recentAudits.length ? data.recentAudits.map((item, index) => <div key={`${item.created_at}-${index}`}><strong>{({"settings.update":"更新系统设置","profile.update":"更新个人资料","documents.repair_metadata":"修复附件元数据"} as Record<string,string>)[item.action] || item.action}</strong><small>{dateTime(item.created_at)} · {item.target_type}</small></div>) : <p className="muted-copy">还没有管理操作记录。</p>}</div>{data.updatedAt && <p className="settings-updated">系统设置更新于 {dateTime(data.updatedAt)}</p>}</section>
        </aside>
      </form>
      {dirty && <div className="sticky-save"><span>系统设置有未保存更改</span><button className="primary" type="submit" form="system-settings" disabled={saving}>{saving ? "保存中…" : "保存全部更改"}</button></div>}
    </>
  );
}
