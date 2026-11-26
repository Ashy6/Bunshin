import React, { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type Trend = { day: string; requests: number; tokens: number };
type ProviderShare = { name: string; requests: number; tokens: number; cost_micros: number };

export default function AnalyticsChart({ kind, trends = [], shares = [] }: {
  kind: "line" | "pie";
  trends?: Trend[];
  shares?: ProviderShare[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current),
      option = kind === "line" ? {
        animationDuration: 300,
        grid: { left: 12, right: 18, top: 56, bottom: 16, containLabel: true },
        tooltip: { trigger: "axis" },
        legend: { data: ["请求", "Token"], top: 8, right: 8, itemGap: 18 },
        xAxis: {
          type: "category",
          data: trends.map((item) => item.day.slice(5)),
          axisLine: { lineStyle: { color: "#dfe3e8" } },
          axisLabel: { margin: 12, hideOverlap: true },
        },
        yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f2" } } },
        series: [
          { name: "请求", type: "line", smooth: true, data: trends.map((item) => item.requests), itemStyle: { color: "#496d8d" }, areaStyle: { color: "rgba(73,109,141,.08)" } },
          { name: "Token", type: "line", smooth: true, data: trends.map((item) => item.tokens), itemStyle: { color: "#96a9b9" } },
        ],
        media: [{ query: { maxWidth: 520 }, option: { legend: { top: 6, left: "center", right: "auto" }, grid: { left: 6, right: 6, top: 52, bottom: 10 } } }],
      } : {
        tooltip: { trigger: "item", formatter: "{b}<br/>{c} 次 · {d}%" },
        legend: { bottom: 0, left: "center", type: "scroll" },
        series: [{
          type: "pie",
          radius: ["43%", "67%"],
          center: ["50%", "43%"],
          avoidLabelOverlap: true,
          data: shares.map((item) => ({ name: item.name, value: item.requests })),
          label: { show: shares.length <= 5, formatter: "{b}" },
          itemStyle: { borderRadius: 5, borderColor: "#fff", borderWidth: 3 },
          color: ["#496d8d", "#8aa4ba", "#c0ced9", "#718798"],
        }],
      };
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [kind, shares, trends]);
  return <div ref={ref} className="chart" />;
}
