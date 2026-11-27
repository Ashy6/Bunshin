# 模型执行路由、状态机与故障恢复

> 实现状态：已落地
> 适用范围：后台渠道测试、门户 RAG 问答、Query Embedding、文档 Embedding

## 1. 为什么不能只用一个“已验证”状态

模型 API Key 是否有效，与一次生产请求是否成功，是两个不同问题。旧实现把它们都写入 `health_status`：后台测试成功后显示“已验证”，但访客请求可能从另一个 Cloudflare 边缘出口发出；当厂商返回区域限制、Gateway 鉴权错误或瞬时 5xx 时，代码又把所有 `401/403` 都写成 Key 失效。结果是一次运行链路故障会永久阻断后续问答，并要求用户重复验证本来有效的 Key。

现在拆成两条正交状态：

- `credential_status`：`unverified | valid | invalid`，只描述模型厂商凭据。
- `runtime_status`：`unknown | healthy | degraded | circuit_open | unavailable`，只描述生产执行链路。

`health_status` 暂时保留，供滚动部署期间的旧 Worker 兼容；业务判断均使用新字段。

## 2. 统一执行路由

每个渠道保存 `route_mode`：

- `direct`：Worker 直接请求兼容模型厂商。
- `gateway`：OpenAI 原生地址由服务端改写为 Cloudflare AI Gateway URL。
- `runtime`：通过 HMAC 请求固定区域 AI Runtime。

有效路由按以下顺序确定：

1. Web/Admin 配置私有 `AI_RUNTIME` Service Binding、共享 HMAC Secret 且启用 Runtime 时，统一使用固定区域 Runtime。
2. 未启用 Runtime 时，渠道为 `gateway` 且存在 Worker AI binding 或 Gateway Base URL，才使用 AI Gateway。
3. 其余兼容渠道使用直连；原生 OpenAI 在受区域限制的 Cloudflare 出口上不应依赖该回退。

后台“重新测试”、门户 Chat、Query Embedding 与文档 Embedding调用完全相同的路由选择逻辑。系统不再用后台某个边缘节点的直连结果，替代访客生产路径的健康状态。

Runtime 通过 HTTP Service Binding 调用，不暴露 `workers.dev` 公网入口。Web/Admin 从 D1 解密站长保存的 API Key，只在当前内部请求中把它作为 HMAC 完整覆盖的 JSON 字段交给 Runtime；Runtime 不持久化、不记录也不返回该字段。这样后台仍然保持“选择厂商并录入自己的 Key”的产品体验，同时模型请求从 Runtime 的受控区域发出。

AI Gateway 仍保留为兼容路线。`env.AI.gateway("default").run(...)` 可以解决 Gateway 自身鉴权，但不会承诺改变模型厂商看到的出口区域；因此它不能替代固定区域 Runtime。普通 Worker 的 Targeted Placement 同样只是执行位置提示，不等于固定出口 IP，生产验收必须以真实模型请求为准。

## 3. 错误协议

所有上游错误先被归一为稳定业务码：

| 代码 | 含义 | Key 失效 | 可重试 | 运行状态 |
| --- | --- | --- | --- | --- |
| `PROVIDER_AUTH_INVALID` | Key 无效、撤销或缺少模型权限 | 是 | 否 | unavailable |
| `GATEWAY_AUTH_MISCONFIGURED` | Gateway Token/鉴权配置错误 | 否 | 否 | unavailable |
| `ROUTE_REGION_UNSUPPORTED` | 当前执行出口不受厂商支持 | 否 | 否 | unavailable |
| `RATE_LIMITED` | 厂商限流或临时配额压力 | 否 | 是 | degraded/circuit |
| `UPSTREAM_5XX` | 厂商服务异常 | 否 | 是 | degraded/circuit |
| `TIMEOUT` | 网络或模型响应超时 | 否 | 是 | degraded/circuit |
| `RUNTIME_NOT_CONFIGURED` | Runtime Binding 或共享 Secret 缺失 | 否 | 否 | unavailable |
| `RUNTIME_AUTH_MISCONFIGURED` | Runtime 三端内部鉴权不一致 | 否 | 否 | unavailable |
| `CUSTOM_BASE_URL_DENIED` | 自定义厂商地址未加入 Runtime 白名单 | 否 | 否 | unavailable |
| `PROVIDER_KEY_MISSING` | 渠道没有可用的真实 API Key | 是 | 否 | unavailable |
| `RUNTIME_REQUEST_INVALID` | Runtime 请求中的厂商或模型配置错误 | 否 | 否 | unavailable |
| `UNKNOWN` | 未分类的传输异常 | 否 | 是 | degraded/circuit |

Cloudflare AI Gateway 的 `AiGatewayError`/代码 `2009` 优先分类为 Gateway 配置错误，即使 HTTP 状态同为 401，也不会把 OpenAI Key 标成无效。

## 4. 熔断和自动恢复

瞬时错误在五分钟窗口内累计。连续三次可重试错误后：

- `runtime_status` 进入 `circuit_open`；
- 熔断 60 秒，期间不再向上游放大请求；
- 门户返回明确的暂时不可用状态，失败请求释放已预留额度；
- 熔断时间到期后允许下一次探测请求。

任意 Chat 或后台渠道测试成功，都会原子更新为：

- `credential_status=valid`
- `runtime_status=healthy`
- 连续失败归零
- 清除 `failure_code` 与熔断时间
- 写入 `last_success_at`

因此瞬时故障不要求站长手动反复点击“重新测试”。只有确认的凭据错误或生产路由配置错误才需要人工处理。

每次真实 Chat 或后台测试开始时，D1 会原子递增渠道的 `state_epoch`。成功和失败结果只有在 epoch 仍等于本次请求取得的值时才能落库；较旧请求即使更晚返回，也不能覆盖较新的状态。后台测试响应读取 CAS 后的真实持久化状态，不再出现界面显示“已验证”而门户仍读取旧失败状态的分叉。

访客中途取消流式回答时，不会把渠道误记为失败，也不会消耗访客当日的成功回答次数；但本次尝试仍保留在分钟级和全站预算桶中，防止通过反复发起后取消来绕过限流、消耗上游模型资源或持续抢占新的状态 epoch。取消事件会写入生产遥测，便于识别异常客户端。

## 5. RAG 与额度语义

RAG 检索与模型生成是两个阶段。BM25、本地向量、RRF 和相关性门控成功，不代表模型生成成功。

- 没有相关证据：不调用模型，不扣成功问答次数。
- 模型不可用：不直接向访客拼接原始 Chunk，释放已预留额度。
- 外部 Query Embedding 失败：记录 `query_embedding_fallback` 遥测并回退本地向量检索，但不改写 Chat 的全局运行状态。Embedding 模型、权限或向量服务异常不应阻断仍然可用的聊天模型。
- 文档外部 Embedding 失败：保留已生成的本地向量，文档仍可进入索引；记录 `document_embedding_fallback`，避免模型链路故障让整个资料库反复进入 Queue 失败。Queue 中的辅助 Embedding 成败同样不会改写 Chat 的全局运行状态；只有与门户相同路由的渠道测试和真实 Chat 才能改变渠道状态。
- Chat 接口一旦进入 SSE 阶段，业务错误也使用结构化 SSE `error` 事件并以 `done` 结束，避免前端把 502 SSE 当 JSON 解析而只显示笼统错误。

失败请求不会消耗成功额度。引用仍只展示模型回答中实际使用的 `[n]` 来源。

## 6. 后台展示与排障

渠道卡片分别展示：

- 凭据状态；
- 生产运行状态；
- 实际执行路由；
- 标准错误码；
- 连续失败次数；
- 最近成功/失败时间；
- 熔断恢复时间；
- 可操作的修复建议。

排障顺序：

1. `PROVIDER_AUTH_INVALID`：更新 Key 或授予 `model.request` 权限。
2. `GATEWAY_AUTH_MISCONFIGURED`：检查 Gateway 鉴权，不要先更换 OpenAI Key。
3. `ROUTE_REGION_UNSUPPORTED`：切换 Gateway、固定区域 Runtime 或当地合规模型厂商。
4. 限流、超时或 5xx：观察自动恢复与生产监控；持续异常再检查厂商状态和预算。
5. `CUSTOM_BASE_URL_DENIED`：把规范化后的完整 HTTPS Base URL（含 `/v1` 等路径）加入 Runtime 的 `AI_RUNTIME_CUSTOM_BASE_URLS` 精确白名单，重新部署 Runtime，并在后台重新验证渠道以恢复 `unavailable` 状态。

## 7. 数据迁移

迁移 `0012_provider_runtime_state.sql` 遵循保守原则：

- 历史 `healthy` → `valid + healthy`。
- 历史 `error` 的原因不明确 → `unverified + degraded`，允许新生产路由做一次真实探测，不误判 Key 无效。
- 原生 OpenAI 渠道默认迁移到 `gateway`，保证 Admin 与 Web 共用同一路由。
- `0013_provider_runtime_hardening.sql` 会按已知官方域名回填旧渠道的 `preset_id`；旧版保存为 `Runtime Secret` 的占位凭据无法恢复，会被明确标记为 `PROVIDER_KEY_MISSING`，要求站长重新录入一次真实 Key。
- `0014_provider_state_cas.sql` 增加数据库排序的 `state_epoch`，用于成功、失败和失败之间的并发 CAS，避免网络完成顺序覆盖请求开始顺序。

## 8. 安全边界

- 浏览器只发送问题，不携带模型 Key 或 Gateway Token；Worker AI binding 也不会向浏览器暴露账户身份。
- 后台录入的 Key 使用主密钥信封加密保存在 D1，只返回掩码。
- 完整上游错误只用于服务端脱敏分类；门户只收到稳定错误码、公开文案、是否可重试与操作类型。
- 遥测不记录 Authorization、完整 Prompt、知识片段或完整回答。
- Gateway 与固定区域 Runtime 用于建立可控、合规的执行路径，不用于绕过模型厂商政策。
