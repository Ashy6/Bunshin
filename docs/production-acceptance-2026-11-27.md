# 生产环境端到端验收记录（2026-11-27）

## 结论

生产环境的 R2、D1、Cron、Queue、文本解析、切片、本地向量、混合检索、模型问答、SSE、引用、额度、Usage 和 Observability 链路已完成一次真实闭环验收并通过。

当前 Cloudflare Turnstile 尚未配置生产 Site Key 与 Secret Key，因此本次只验证了 Turnstile 未启用时的服务端放行分支；实际人机挑战不在本次通过范围内。

## 验收资料

- 文档标题：`Bunshin 生产验收资料`
- 文档 ID：`e238cf83-fb05-4759-a1eb-d1639ac6bc1a`
- 验收标识：`BUNSHIN-E2E-20261127`
- 问题：`银杏轨道计划的验收结论关键词是什么？请只依据知识库回答。`
- 期望答案：`青玉回声`
- 可见性：`rag_only`

该资料只包含虚构验收内容，不包含个人敏感信息。验收完成后保留在知识库中，便于后续回归测试；如不再需要，可由站长在后台知识库中删除。

## 验收证据

### 存储和异步处理

- 原始 Markdown 成功写入生产 R2。
- D1 文档与版本记录成功建立。
- Cron 在首次 Queue 投递缺失时记录 `ingestion_recovered` 并重新投递。
- Queue 第 1 次消费成功，状态为 `completed`，没有错误。
- 文档最终状态为 `indexed`，进度 100%。
- 生成 1 个切片和 1 个本地向量。

### 检索和回答

- Agent 状态：`enabled=true`、`ready=true`。
- 每日额度：25 次；本次完成后剩余 24 次。
- 检索模式：`local_hybrid`。
- 词法召回 3 条，向量召回 3 条，融合后 3 条。
- 检索耗时 32 ms，最高分约 0.22459。
- 第一引用为 `Bunshin 生产验收资料`。
- SSE 顺序完整：`sources → delta → done`。
- 实际回答为：`银杏轨道计划的验收结论关键词是“青玉回声”。[1]`

### 模型和监控

- 模型：`gpt-5.4-mini`。
- 输入 Token：2237。
- 输出 Token：24。
- Token 为厂商返回值，`estimated=0`。
- 本地核算费用：1786 micros。
- 模型流耗时：1534 ms。
- `/api/chat` HTTP 200，总耗时 1801 ms。
- `rag_query_events`、`usage_events` 和 `observability_events` 均产生真实记录。

## 验收期间发现并修复

生产 Cron 现会扫描超过 1 分钟仍停留在 `uploaded` 的文档，并以原子状态更新后重新投递 Queue。投递失败会恢复为 `uploaded` 并记录错误，后续 Cron 可以继续重试；成功恢复会写入 `ingestion_recovered` 监控事件。该机制避免上传完成但首次 Queue 投递遇到瞬时故障时永久卡住。

## 网络说明

验收设备通过美国 VPN 访问 `workers.dev` 时出现 TCP 连接超时。为排除本地网络因素，最终问答由 Admin Cron 在 Cloudflare 边缘内部调用正式 Web Worker 完成。验收结束后，专用验收函数与 D1 临时请求/结果标记均已移除；线上只保留通用 Queue 自愈能力及正常业务埋点。
