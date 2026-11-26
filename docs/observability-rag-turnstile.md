# 生产监控、混合 RAG 与访客验证

本文描述公开 Agent 上线后的三条生产链路：可观测性、混合检索和 Cloudflare Turnstile。它们都由现有 Web/Admin Worker 承担，不新增第三个 API 服务。

## 1. 生产监控

### 数据模型

- `observability_events`：Web/Admin API 请求、Turnstile、RAG 和 Queue 的结构化事件。只保存路由、耗时、状态、Trace ID 和非敏感摘要，不保存 Cookie、API Key、完整问题或知识正文。
- `operational_alerts`：按稳定 `fingerprint` 去重的活动告警，支持 `open`、`acknowledged`、`resolved` 生命周期。
- `queue_job_runs`：每次知识入库任务的开始、心跳、重试、完成和死信风险。
- `rag_query_events`：检索模式、候选数、最高得分、检索耗时和是否命中。
- `usage_events`：模型调用的 Token、费用、延迟和成功状态，继续作为计量与预算真源。

所有 API 响应返回 `X-Trace-Id`；后台“生产监控”每 30 秒刷新，并可按 1 小时、24 小时、7 天查看。Admin Cron 每 5 分钟重新评估告警。

### 默认告警

| 信号 | 默认条件 | 处理建议 |
| --- | --- | --- |
| 模型错误率 | 15 分钟至少 5 次调用且失败率 ≥ 20% | 检查渠道权限、额度、模型名和上游状态 |
| 文档卡死 | `parsing/embedding` 超过 15 分钟 | 在知识库重试并检查 Queue / R2 |
| Queue 风险 | 重试、三次失败或心跳超时 | 查看 Trace ID 与错误，确认 DLQ |
| 人机验证异常 | 15 分钟至少 10 次且失败率 ≥ 50% | 检查站点域名、Secret 和攻击流量 |
| 月度预算 | 渠道支出达到预算 80% | 调整预算、限流或停用渠道 |

Queues 设置 `max_retries=3`，超过后进入 `ai-bunshin-ingestion-dlq`。监控只发站内告警，不会擅自向外部邮箱或聊天工具发送通知；未来可在 `syncOperationalAlert` 后增加显式配置的 Webhook。

## 2. 混合 RAG

检索阶段采用不依赖单一厂商的混合策略：

1. 从 D1 读取允许检索的候选切片。
2. 中文二元词组与英文单词分词，执行 BM25 关键词召回。
3. 外部 Embedding 模式使用 Vectorize；隐私模式使用本地向量余弦召回。
4. 用 Reciprocal Rank Fusion 合并两路排名，避免不同分值尺度互相污染。
5. 用问题词覆盖率和基础排名进行轻量重排，取前 5 段构建带引用上下文。
6. 无可靠候选时拒绝编造；每次检索把候选数、得分、耗时和命中状态写入 `rag_query_events`。

该实现兼顾简历中的精确公司名、技术名和语义问题。外部 Embedding 不可用时仍可使用本地向量与 BM25，原始 PDF 不需要为了检索而公开。

## 3. Turnstile 与 25 次限额

Turnstile 是一次请求级人机验证，不能用 `cf_clearance` 代替业务侧校验。前端只持有公开 Site Key，聊天请求携带一次性 Token；Web Worker 必须调用 Siteverify 验证 Token、`action=chat` 和客户端 IP。Token 验证后立即重置，过期或重复使用会失败。

Turnstile 与次数限制是两层独立保护：

- Turnstile 判断当前请求是否通过人机验证。
- D1 `rate_limit_buckets` 仍在服务端执行每分钟、每访客每日（默认 25 次）和全站每日限制。
- 只有完成回答的成功请求扣减每日额度；客户端显示值不作为计费依据。

### 配置

在 Cloudflare Dashboard 创建 Turnstile Widget，把正式门户域名和需要测试的 `workers.dev` 域名加入 Hostname。然后配置：

```bash
wrangler secret put TURNSTILE_SECRET_KEY --config apps/web/wrangler.jsonc
wrangler secret put TURNSTILE_SITE_KEY --config apps/web/wrangler.jsonc
pnpm --filter @ai-bunshin/web deploy
```

Site Key 本身不是秘密，但本项目仍通过 Worker 变量注入，避免把不同部署者的值写入开源仓库。只有 Site Key 与 Secret Key 同时存在时，`/api/agent/status` 才宣布 Turnstile 已启用；缺少任一项时现有问答不受影响。

`cf_clearance` 属于 Cloudflare Challenge/WAF 的可选预清除机制，适合在绑定 Cloudflare Zone 和 WAF 规则后继续加固，但不是本项目统计访客或扣减 25 次额度的身份凭据。

## 4. 上线检查

1. 应用 `0009_observability_rag_security.sql`。
2. 确认 Admin Cron 和 Queue Consumer 已发布，DLQ 存在。
3. 后台打开“生产监控”，确认无活动告警并能看到 API 事件。
4. 上传一份资料，确认 Queue 状态最终为 `completed`，知识库状态为 `indexed`。
5. 分别测试精确关键词和自然语言问题，确认回答带来源。
6. 配置 Turnstile 两个 Key，使用正式域名完成人机验证并发起聊天。
7. 连续刷新或模拟错误，确认 Token 不可复用、25 次额度由服务端控制。

## 5. 数据保留建议

当前版本保留完整运行事件，适合个人站点的低流量。系统不会在未得到站长明确授权时自动删除审计、用量或监控历史。长期运行时建议先导出或聚合，再由站长显式启用保留策略：清理 30 天前的 `observability_events`、90 天前已完成的 `queue_job_runs` 和已解决告警，同时保留聚合后的 `usage_events`。如流量明显增长，应把高频日志迁移至 Workers Analytics Engine 或 Logpush，而不是无限扩张 D1。

后台登录复用 `rate_limit_buckets` 保存临时失败计数，键为来源 IP 与规范化邮箱组合后的 SHA-256。15 分钟内连续失败 8 次后拒绝继续尝试并返回 `Retry-After`；成功登录会移除该临时计数。登录失败与拦截事件只记录脱敏事件类型，不记录密码、原始邮箱或原始 IP。
