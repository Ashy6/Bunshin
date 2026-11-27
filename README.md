# ai-bunshin

开源、单人自托管的 AI 个人分身项目

可以基于你的简历、文章与博客创建。

访客可以浏览公开简历、项目、文章、分类、标签与归档，并通过 RAG 与站长的“个人分身 Agent”对话。站长通过独立后台维护内容、上传 PDF/Markdown/TXT、执行解析与向量化、配置任意模型厂商，并通过 ECharts 查看调用量、Token、费用、延迟和 RAG 指标。

> 维护规则：任何产品范围、项目结构、Cloudflare 资源、部署流程、环境变量、公开路由或安全方案的变更，都必须在同一个变更中同步更新本 README。

## 产品边界

- 单站长，不做组织、多租户、访客账号、充值或支付。
- 访客端没有用户概念，公开内容无需登录。
- 后台只有一个管理员，当前使用密码与安全会话登录；TOTP MFA 已列入安全增强计划，尚未作为已完成能力发布。
- 未配置模型时，简历和博客仍可完整运行，Agent 入口自动隐藏。
- UI 参考 [Ajie’s 思源地](https://shijayhuo.github.io/) 的信息架构，以 clean-room 方式独立实现，不复制个人内容和受保护素材。

## 总体架构

项目只有两个部署应用，API 内聚在各自 Worker 中，不创建第三个 `apps/api`：

```mermaid
flowchart LR
    V[访客浏览器] -->|SSR 页面 / 搜索| W[Web Worker\n公开站点 + Public API]
    V -->|POST /api/chat · SSE| W
    A[站长浏览器] -->|后台页面 / 管理请求| M[Admin Worker\n后台 + Admin API + Queue Consumer]

    W --> D[(D1)]
    W --> X[(Vectorize)]
    W --> L[模型厂商 / AI Gateway]
    W --> K[(KV / Cache)]

    M --> D
    M --> R[(R2)]
    M --> Q[[Queue]]
    Q --> C[解析 → 切片 → Embedding]
    C --> R
    C --> D
    C --> X
    C --> L

    W -.复用.-> P[packages/*\nDB / AI / RAG / Crypto]
    M -.复用.-> P
```

### API 位置

`apps/web` 提供：

- `GET /`、`/articles/:slug`、`/categories/*`、`/tags/*`、`/archives`
- `GET /api/search`
- `GET /api/public-config`
- `POST /api/chat`，SSE 流式回答
- `/sitemap.xml`、`/robots.txt`、`/feed.xml`、`/llms.txt`
- 文章、分类、归档、关于页均直接读取 D1；不使用前端演示数据

`apps/admin` 提供：

- `/api/admin/auth/*`
- `/api/admin/profile/*`
- `/api/admin/articles/*`：编辑、批量导入、封面、版本、定时发布
- `/api/admin/categories/*`：分类 CRUD、门户可见性与删除前迁移
- `/api/admin/documents/*`：上传、URL 导入、版本替换、解析进度、召回测试
- `/api/admin/providers/*`
- `/api/admin/analytics/*`：真实请求、Token、费用、渠道占比和文档处理概览
- `/api/admin/usage`：按时间、渠道、场景和状态筛选调用明细，支持分页与 CSV 导出
- `/api/admin/observability`：HTTP/模型错误率、RAG 未命中、Queue 心跳与重试、预算和安全告警
- `/api/admin/settings`：公开地址、默认 SEO、`llms-full.txt` 和公开缓存配置
- `/api/admin/maintenance/*`：历史附件元数据校准等可重复执行的维护任务
- Queue 消费者：解析、切片、Embedding、重建索引

后台使用可刷新、支持浏览器前进/后退的 Hash 路由：`#/profile`、`#/articles`、`#/categories`、`#/knowledge`、`#/agent`、`#/providers`。文章新建与编辑使用全屏工作台路由；切换模块时若有尚未保存的资料会先提示确认。

共享包不是服务，不监听端口，也不发生内部 HTTP 调用。

## Monorepo 结构

```text
ai-bunshin/
├── apps/
│   ├── web/                 # 公开 SSR 站点与 Public Worker API
│   └── admin/               # 后台、Admin Worker API、Queue Consumer
├── packages/
│   ├── ai/                  # 模型渠道适配、Usage 归一化
│   ├── crypto/              # API Key 信封加密
│   ├── db/                  # D1 schema、查询与迁移
│   ├── domain/              # 共享领域类型
│   ├── rag/                 # 解析、切片、检索与引用
│   └── validation/          # API 与配置校验
├── infra/cloudflare/        # Cloudflare 初始化与迁移脚本
├── docs/                    # PRD 与详细技术设计
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

详细设计见 [docs/README.md](./docs/README.md)。

## 核心技术

- TypeScript、pnpm Workspace、Turborepo
- Hono Worker SSR（访客端）
- React + Vite（后台）
- Tailwind 风格的项目内设计令牌与 CSS
- ECharts
- Cloudflare Workers Static Assets
- D1、R2、Vectorize、Queues、KV
- Zod、Drizzle ORM
- Vitest、Playwright

## 数据流

### 访客问答

```text
问题 → Turnstile（配置后）/服务端限流 → BM25 + 向量双路召回
→ RRF 融合与轻量重排 → D1 回查正文与可见性 → 组装引用 → Chat 模型 → SSE
→ 写入匿名用量事件
```

Agent 只有在“渠道测试成功 + 至少一份非私有资料完成索引 + 后台开关开启”时进入运行状态。匿名访客默认每天最多成功问答 25 次、每分钟 5 次，全站默认每天 500 次；三项都可在“Agent 设置”修改。计数以服务端 D1 为准，失败、无检索结果或模型中断不会消耗每日额度。浏览器仅保存随机访客 ID，D1 只保存该 ID 与 IP 组合后的加盐哈希，不保存原始 IP。

### 文档导入

```text
上传 PDF/Markdown/TXT → R2 → Queue → 解析 → 人工可修正文本
→ 语义切片 → Embedding → Vectorize → D1 更新状态
```

文本型 PDF 会直接解析。扫描 PDF 会标记为“需要 OCR”，不会生成空索引；站长可在知识详情中上传本地 OCR 文本后继续索引。系统不会在未获得明确数据外传授权时，把私有 PDF 自动发送给第三方 OCR 或模型厂商。

### 内容发布与索引生命周期

- “公开展示个人资料”与“允许 Agent 使用个人资料”是两个独立开关：前者控制公开页面，后者控制生成资料是否进入 RAG。
- 个人资料每次保存前自动写入 `profile_versions`，后台可以载入历史快照后再次保存。
- 文章以 D1 为正文真源；支持 Markdown/TXT/PDF 批量导入、URL 导入、封面、标签、SEO 标题/描述、草稿/定时/发布/归档、批量状态操作和历史版本恢复。发布且开启 Agent 检索时生成 R2 Markdown 文档并进入 Queue，修改会重建索引，归档或删除会同步移除旧向量。
- 上传新简历时，上一份简历保留为历史附件，但立即标记为私有归档并清理旧向量，避免新旧经历同时召回。
- 知识库支持 PDF、Markdown、TXT、直接文字和 HTTPS URL 导入；详情抽屉可查看原文、切片、处理进度、版本历史并进行检索测试，还可替换文件、重试、批量删除或上传 OCR 结果。`private` 文档不参与检索，`rag_only` 仅供 Agent，`public` 可作为公开引用来源。
- 分类为独立资源：可设置文章/知识库/共享范围、说明、排序和门户可见性。删除有关联内容的分类时必须明确迁移到另一分类或改为未分类；公开站只展示允许出现在门户且至少有一篇已发布文章的分类。
- 文件原名、文件大小、用途、来源 URL 和归档时间记录在 D1；原文件仍保存在私有 R2。

### 运营与系统配置

- 概览页全部读取 D1 真实数据，可切换最近 7、30、90 天，展示请求、Token、费用、成功率、渠道占比和最近文档任务；统计卡片、空状态和“全部任务”均会进入对应的真实管理模块，不生成演示记录或无效按钮。
- 用量明细按时间范围、模型渠道、调用场景和成功/失败状态查询，展示输入/输出/缓存 Token、成功与失败数、渠道和场景汇总、费用、延迟及可复制 Trace ID；费用以 `usage_events.cost_micros` 为准，CSV 明确导出当前分页结果。
- 系统设置保存在 D1 的 `system_config` 与 `observability_config` 中，包含公开站 Origin、默认 SEO 描述、关键词、`llms-full.txt` 开关、公开页面缓存时间，以及错误率、最少采样数、慢请求、卡死任务和预算告警阈值。页面同时汇总个人资料、模型渠道、知识索引和文章发布状态，并展示真实 SEO 入口与最近审计记录。自定义域名绑定后应立即更新公开站 Origin，保证 canonical、Sitemap、RSS 和结构化数据使用正式域名。
- Admin Cron 除定时发布文章外，也会校准历史文档在 D1 中的文件名、大小和处理进度；后台“系统设置”可以手动触发同一维护任务。超过 1 分钟仍停在 `uploaded` 的资料会由 Cron 重新投递 Queue，避免首次投递遇到瞬时故障后永久卡住。
- “生产监控”记录脱敏的 API、RAG 与 Queue 事件，通过同一 Trace ID 关联请求；内置模型错误率、慢请求、文档卡死、Queue 重试/死信、人机验证失败率和渠道预算告警。慢请求、卡死时长、错误率和预算阈值均读取 D1 中的当前系统设置，Admin Cron 每 5 分钟评估，打开监控页时也会立即评估。监控页自身的轮询不会计入请求量，避免污染错误率。Queue 最多重试 3 次后进入 DLQ。
- 后台按路由加载个人资料、内容管理和运营模块，ECharts 仅在概览存在图表数据时下载；会话失效时所有管理请求统一返回登录页，避免页面停留在“读取失败”的伪登录状态。

## 安全

- 所有流量仅使用 HTTPS。
- D1/R2 采用 Cloudflare 静态加密；Provider API Key 再使用 AES-256-GCM 应用层加密。
- `MASTER_ENCRYPTION_KEY` 只放 Worker Secret。
- 管理员密码使用强密码哈希，Session Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Strict`。
- 后台登录按“来源 IP + 规范化邮箱”的不可逆哈希计数；15 分钟内连续失败 8 次后返回 `429`，成功登录后清除该临时计数。原始 IP 和邮箱不会写入限流表或监控详情。
- 后台支持 Cloudflare Email Service 邮箱验证码重置：请求接口防邮箱枚举、15 分钟最多请求 3 次，验证码只保存带服务端 Secret 的哈希、10 分钟有效且最多尝试 5 次；成功后注销全部旧 Session。只有 Email binding 和 `PASSWORD_RESET_FROM_EMAIL` 同时配置时才显示入口。
- 后台同时支持无需邮件服务的离线恢复码：首次创建管理员时随机生成 10 个一次性恢复码且只展示明文一次，D1 仅保存与 `SESSION_SECRET` 组合后的哈希。恢复码只能授权设置新密码，不能直接建立会话；成功使用后注销全部旧 Session 并作废整批恢复码。登录后可在“系统设置 → 账户恢复”验证当前密码并重新生成一批。
- 后台写请求执行同源 Origin 校验，并配合 `SameSite=Strict` 会话 Cookie 防止跨站提交。
- 后台左下角账号区只展示当前资料中的头像、姓名和无背景的“退出登录”入口；退出时会删除当前服务端 Session 并清除 Cookie。
- 日志不记录 API Key、Cookie、Authorization、完整 prompt 或私密原文。
- 访客 IP 仅与随机访客 ID、服务端 Secret 组合生成匿名 SHA-256 哈希，用于限流和统计。
- 自定义模型 Base URL 仅允许 HTTPS 或本地开发地址。

## GEO 与 SEO

- 公开内容由 Worker SSR 输出，主体不依赖 JavaScript。
- 每页提供 title、description、canonical、Open Graph。
- 使用 `Person`、`WebSite`、`Article`、`BreadcrumbList` JSON-LD。
- 提供 Sitemap、robots.txt、RSS 和 llms.txt。
- 文章、简历与项目使用稳定 URL、明确作者、日期和可验证来源。
- 后台、草稿、预览和搜索结果设置 `noindex`。
- `llms-full.txt` 默认关闭，开启后也只包含公开内容。
- 页面 title、description、canonical、作者信息、`Person`、`WebSite`、`Article` 和面包屑 JSON-LD 均由 D1 中的当前资料动态生成。
- Sitemap、RSS 和 `llms.txt` 自动包含已发布文章与分类；草稿、归档和私有知识不会被输出。

## 本地开发

本地开发采用两个进程、一个共享数据目录：`apps/admin` 由 Cloudflare Vite 插件同时提供 React 管理界面和 Admin Worker API；`apps/web` 提供访客端和公开 Chat API。两者共享 `apps/admin/.wrangler/state` 中的本地 D1 数据，因此后台上传的内容可以立即被访客端检索，无需额外启动第三个 API 项目。

首次打开后台时会进入站长账号初始化页。密码至少 12 位；初始化完成后会生成 10 个只展示一次的离线恢复码，下载或复制保存后使用 HttpOnly 会话 Cookie 进入后台。登录页的“忘记密码”可选择离线恢复码；邮件服务配置完成后也可选择邮箱验证码。模型 API Key 输入框始终使用密码态，只显示首尾掩码和字符长度；服务端只返回 `key_preview`，密文使用 AES-256-GCM 保存，任何读取接口都不会返回原始 Key。

### 前置条件

- Node.js 22+
- pnpm 10+
- Cloudflare 账号仅在远程预览或部署时需要

### 安装

```bash
git clone <your-repository-url> ai-bunshin
cd ai-bunshin
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

本地地址：

- 访客端：`http://localhost:8787`
- 后台：`http://localhost:8788`

知识库流程为：上传文本型 PDF/TXT/Markdown → R2 存储 → Queue 消费 → PDF 文字提取 → 切片 → D1 向量索引 → 访客端相似度检索。未配置模型渠道时，Chat 会直接展示带来源的检索结果；配置 OpenAI-compatible 渠道后，会将检索上下文交给模型生成回答。扫描版 PDF 无可提取文字时会标记为 `needs_ocr`，需要先进行 OCR。

### 首次初始化

```bash
pnpm admin:init
```

随后进入后台完成：

1. 设置个人资料和公开域名。
2. 配置 Chat 与 Embedding 渠道。
3. 上传简历和知识文档。
4. 测试检索并发布站点。

## 环境变量与 Secrets

本地变量参考 `.dev.vars.example`。生产环境必须通过 Wrangler Secret 设置：

```bash
wrangler secret put MASTER_ENCRYPTION_KEY
wrangler secret put SESSION_SECRET
wrangler secret put ADMIN_BOOTSTRAP_TOKEN
# 可选：启用公开 Agent 人机验证时同时设置
wrangler secret put TURNSTILE_SITE_KEY --config apps/web/wrangler.jsonc
wrangler secret put TURNSTILE_SECRET_KEY --config apps/web/wrangler.jsonc
```

模型 API Key 由后台录入，经 `MASTER_ENCRYPTION_KEY` 加密后保存，不需要逐个写入 Wrangler。

Turnstile 只有在 Site Key 与 Secret Key 同时配置时启用。前端 Token 必须由 Web Worker 调用 Cloudflare Siteverify 校验，且每次成功或失败后都会重置；它与 D1 中默认 25 次的服务端额度是两层独立保护。`cf_clearance` 是 Cloudflare WAF/Challenge 的可选凭据，不作为业务额度身份。详细方案见 [生产监控、混合 RAG 与 Turnstile](./docs/observability-rag-turnstile.md)。

### 个人版最简配置

后台内置 OpenAI、DeepSeek、OpenRouter 与自定义 OpenAI-compatible 预设。普通使用只需选择厂商并输入一个 API Key；Base URL、推荐 Chat 模型和向量策略由系统自动选择。DeepSeek/OpenRouter 默认使用本地隐私向量，不会把简历发送给第三方 Embedding 服务。OpenAI 可选择外部 Embedding，但必须由站长显式勾选数据外传授权。

“测试并启用”会先调用推荐聊天模型验证 Key，测试失败不保存；测试成功后加密保存并设为默认渠道。已有渠道可使用“重新测试连接”恢复健康状态。个人资料发布后会生成一份内部 Markdown 文档并自动进入 Queue；上传简历或知识资料后同样自动解析、切片和索引。后台“Agent 设置”统一展示渠道健康、知识库就绪数量、今日问答和向量方案。

如果 OpenAI 返回 `Missing scopes: model.request`，说明 Key 本身已被识别，但没有模型推理权限。请到对应 Project 的 API Keys 页面把 Key 设置为 `All`，或在 `Restricted` 权限中开启模型请求，并确认账号在该 Project 中是 Member 或 Owner。模型渠道表单使用右侧抽屉，Key 在输入和保存后都只显示固定五颗星及首尾字符。

个人资料的结构化字段和 Markdown 原文保存在 D1，简历、头像等原始文件保存在私有 R2。后台“个人资料”按基本信息、关于我、经历与项目、简历附件、版本记录分区；支持 Markdown 实时预览、技能去重、动态社交链接、工作经历/项目/教育、头像焦点位置调整，以及公开展示和 Agent 使用两个独立开关。必填项统一使用红色星号标识。头像区域可直接点击上传、替换或恢复名称首字 SVG。简历上传展示浏览器上传进度和后续索引状态，可下载、重试、删除并查看历史版本。保存后主站侧边栏、关于页、SEO 和 Agent 读取同一份数据。头像和附件都通过 Worker 受控输出，不公开 R2 Bucket。文本型 PDF/TXT/Markdown 经 Queue 异步解析；本地隐私模式使用 D1 向量回退，显式授权外部 Embedding 后使用版本化 Vectorize 索引。切换模型应新建索引版本并重建，不能把不同维度混入同一索引。

文章管理已经接入 D1：后台列表按状态、分类和关键词筛选，编辑工作台支持自动保存、Markdown 预览、封面、标签、分类、SEO、定时发布、版本恢复和独立的 Agent 检索开关；PDF/Markdown/TXT 可批量导入为草稿，HTTPS 网页可安全导入后再校对。公开端的文章列表、详情、分类计数和归档全部读取真实数据，并展示封面与标签。公开 Markdown 使用白名单式安全渲染，支持标题、段落、列表、引用、链接、行内代码和代码块。Agent 的流式回答也会按段落和列表排版，并把 `[1]` 等引用显示为可辨识角标，公开文章来源可以点击回到原文。

内容导入采用“先进入草稿/处理队列，再由站长确认发布”的规则：文件和 URL 导入不会自动公开；URL 只允许 HTTPS，并拒绝本机、内网和元数据地址；扫描 PDF 不会静默产生空文章或空向量。Admin Worker 每 5 分钟执行一次定时发布任务，因此 `scheduled_at` 到期后最多约 5 分钟进入公开站并同步 RAG。

公开站点首页就是“问问分身”RAG 对话页，并默认选中该一级菜单；文章、分类、归档和关于均使用独立 URL，切换顶部或移动端下拉导航时正文会真正进入对应页面。手机下拉导航在点击内容空白区或选择菜单后自动收起，导航图标统一使用同一套描边 SVG。联想问题点击后立即发起问答，输入框按 Enter 发送、Shift+Enter 换行。公开标题会在读取个人资料后更新为“页面名称 · 显示名称-AI分身”，首页显示为“显示名称-AI分身”。

公开站点只采用两种响应式导航：`>=768px` 统一使用顶部导航，不显示左侧导航；`<=767px` 使用顶部菜单按钮和下拉导航抽屉。站内文章、分类、归档和关于页面由浏览器拦截同源链接并局部替换主内容，同时更新 History、canonical、Open Graph 和 JSON-LD；直接访问任意 URL 仍由 Worker 服务端渲染，SEO 与无 JavaScript 访问不受影响。Agent 参考资料只有在文档提供公开 `source_url` 时才显示“访问原文章”，文章来源会进入 `/articles/:slug`。后台在 `<=820px` 改为顶部工具栏与下拉导航抽屉，避免窄屏侧栏挤压表单；静态资源使用显式版本号，公开页内置最小关键布局样式作为加载延迟兜底。

Agent 的核心身份由服务端固定：它始终是资料所有者本人的 AI 分身，使用第一人称描述资料中的经历、项目、观点和文章；后台“附加系统要求”不能覆盖该身份。公开问答仍受后台启用开关、健康模型渠道、已索引知识库和服务端额度共同控制。

后台用量页和 ECharts 从 `usage_events` 读取真实 Chat/Embedding 请求、Token、延迟与状态。后台左下角和移动端头像区读取同一份个人资料，保存名称、职业标题或头像后会同步更新全局站长身份。费用只有在渠道价格可确定时才是估算值；它不等同于厂商账户真实余额。

## Cloudflare 资源初始化

正式部署需要：

- 两个 Workers：`ai-bunshin-web`、`ai-bunshin-admin`
- 一个 D1：`ai-bunshin`
- 一个 R2：`ai-bunshin-assets`
- 一个 Vectorize：`ai-bunshin-knowledge-v1`
- 一个 Queue 和一个 DLQ
- 一个 KV namespace
- 一个 Admin Worker Cron Trigger（每 5 分钟处理定时文章并校准附件元数据）

登录后执行：

```bash
pnpm cf:login
pnpm cf:setup
```

当前仓库已提供生产发布门禁。首次启用 R2 并完成资源配置后，执行：

```bash
pnpm deploy:production
```

脚本会依次检查 Cloudflare 登录和 R2、运行类型检查/测试/构建、应用远程 D1 迁移、部署两个 Worker、生成并安装生产 Secrets，最后输出一次性管理员初始化令牌。稳定密钥保存在本机被 Git 忽略的 `.deploy-secrets.json` 中；后续部署会复用，避免更换主密钥导致已保存的模型 API Key 无法解密。

`0008_operations.sql` 会创建系统配置、把已有站点的默认访客额度统一为 25 次，并回填可从 D1 版本记录确定的附件元数据；`0009_observability_rag_security.sql` 创建生产事件、告警、Queue 运行和 RAG 检索指标。部署完成后进入后台“系统设置”，填写正式公开地址并执行一次“修复历史附件元数据”，再到“生产监控”确认运行健康。

将命令返回的资源 ID 写入两个应用的 `wrangler.jsonc`，然后：

```bash
pnpm db:migrate:remote
pnpm deploy
```

建议域名：

- `example.com` → `ai-bunshin-web`
- `admin.example.com` → `ai-bunshin-admin`

`*.workers.dev` 只作为初始化和故障排查入口。生产环境应为两个 Worker 分别绑定 Cloudflare 托管区域中的 Custom Domain，而不是把普通 CNAME 直接指向 `workers.dev`：

```jsonc
// apps/web/wrangler.jsonc
"routes": [{ "pattern": "example.com", "custom_domain": true }]

// apps/admin/wrangler.jsonc
"routes": [{ "pattern": "admin.example.com", "custom_domain": true }]
```

域名必须已接入当前 Cloudflare 账号且处于 Active 状态，目标主机名不能保留冲突的 CNAME。部署时 Cloudflare 会自动创建 DNS 记录并签发证书。建议公开站使用主域名或 `www`，后台使用独立的 `admin` 子域；如需进一步限制后台入口，可在该主机名上增加 Cloudflare Access。绑定自定义域名可以避开部分网络对 `workers.dev` 的特殊解析或访问限制，但普通 Cloudflare 全球网络不等同于中国大陆境内加速，不能承诺所有大陆运营商链路都稳定。

## CI/CD

```text
Pull Request
→ lint + typecheck + test
→ build 两个应用
→ preview deploy
→ smoke tests
→ merge main
→ D1 向前兼容迁移
→ deploy admin
→ deploy web
```

生产迁移采用 expand/contract，不能在同一次发布中先删除旧字段。

## 常用命令

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm db:migrate:local
pnpm db:migrate:remote
pnpm deploy
```

## 开源部署注意事项

1. 不提交 `.dev.vars`、Cloudflare Token、真实 API Key 或数据库导出。
2. Fork 后修改站点名称、canonical origin 和管理员邮箱。
3. Embedding 模型或维度变更时新建版本化 Vectorize 索引，重建完成后再切换。
4. 厂商不提供余额 API 时，后台显示的是“本地预算剩余”，不是厂商真实余额。
5. 上线前配置预算、访客限流，并按需开启 Turnstile。

## 当前状态

访客端与管理后台均已部署到 Cloudflare Workers。已打通个人资料与简历上传、文章导入/编辑/定时发布/版本恢复、分类 CRUD、知识文件版本与召回测试、R2 原文件、Queue 解析、D1/Vectorize 检索、单 Key 渠道测试、流式 Agent 问答、引用展示、匿名 25 次限流和真实用量记录。扫描版 PDF 支持上传站长在本地生成的 OCR 文本继续索引；自动第三方 OCR 仍需后续增加明确的数据外传授权。多管理员、组织和充值计费不属于个人版范围。

## License

Apache-2.0。第三方依赖继续遵循其各自许可证。
