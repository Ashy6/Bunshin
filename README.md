# ai-bunshin

开源、单人自托管的 AI 个人分身项目

可以基于你的简历、文章与博客创建。

访客可以浏览公开简历、项目、文章、分类、标签与归档，并通过 RAG 与站长的“个人分身 Agent”对话。站长通过独立后台维护内容、上传 PDF/Markdown/TXT、执行解析与向量化、配置任意模型厂商，并通过 ECharts 查看调用量、Token、费用、延迟和 RAG 指标。

> 维护规则：任何产品范围、项目结构、Cloudflare 资源、部署流程、环境变量、公开路由或安全方案的变更，都必须在同一个变更中同步更新本 README。

## 产品边界

- 单站长，不做组织、多租户、访客账号、充值或支付。
- 访客端没有用户概念，公开内容无需登录。
- 后台只有一个管理员，支持密码登录与可选 TOTP MFA。
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

`apps/admin` 提供：

- `/api/admin/auth/*`
- `/api/admin/profile/*`
- `/api/admin/articles/*`
- `/api/admin/categories/*`
- `/api/admin/documents/*`
- `/api/admin/providers/*`
- `/api/admin/analytics/*`
- Queue 消费者：解析、切片、Embedding、重建索引

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
问题 → 限流/安全检查 → Query Embedding → Vectorize 召回
→ D1 回查正文与可见性 → 组装引用 → Chat 模型 → SSE
→ 写入匿名用量事件
```

### 文档导入

```text
上传 PDF/Markdown/TXT → R2 → Queue → 解析 → 人工可修正文本
→ 语义切片 → Embedding → Vectorize → D1 更新状态
```

MVP 仅保证文本型 PDF。扫描 PDF 会标记为“需要 OCR”，不会生成空索引。

## 安全

- 所有流量仅使用 HTTPS。
- D1/R2 采用 Cloudflare 静态加密；Provider API Key 再使用 AES-256-GCM 应用层加密。
- `MASTER_ENCRYPTION_KEY` 只放 Worker Secret。
- 管理员密码使用强密码哈希，Session Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Strict`。
- 后台写请求执行 Origin/CSRF 校验。
- 日志不记录 API Key、Cookie、Authorization、完整 prompt 或私密原文。
- 访客 IP 仅生成周期性匿名 HMAC，用于限流和统计。
- 自定义模型 Base URL 必须通过 SSRF 校验。

## GEO 与 SEO

- 公开内容由 Worker SSR 输出，主体不依赖 JavaScript。
- 每页提供 title、description、canonical、Open Graph。
- 使用 `Person`、`WebSite`、`Article`、`BreadcrumbList` JSON-LD。
- 提供 Sitemap、robots.txt、RSS 和 llms.txt。
- 文章、简历与项目使用稳定 URL、明确作者、日期和可验证来源。
- 后台、草稿、预览和搜索结果设置 `noindex`。
- `llms-full.txt` 默认关闭，开启后也只包含公开内容。

## 本地开发

本地开发采用两个进程、一个共享数据目录：`apps/admin` 由 Cloudflare Vite 插件同时提供 React 管理界面和 Admin Worker API；`apps/web` 提供访客端和公开 Chat API。两者共享 `apps/admin/.wrangler/state` 中的本地 D1 数据，因此后台上传的内容可以立即被访客端检索，无需额外启动第三个 API 项目。

首次打开后台时会进入站长账号初始化页。密码至少 12 位；初始化完成后使用 HttpOnly 会话 Cookie 登录。模型 API Key 输入框始终使用密码态，只显示首尾掩码和字符长度；服务端只返回 `key_preview`，密文使用 AES-256-GCM 保存，任何读取接口都不会返回原始 Key。

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
```

模型 API Key 由后台录入，经 `MASTER_ENCRYPTION_KEY` 加密后保存，不需要逐个写入 Wrangler。

### 个人版最简配置

后台内置 OpenAI、DeepSeek、OpenRouter 与自定义 OpenAI-compatible 预设。普通使用只需选择厂商并输入一个 API Key；Base URL、推荐 Chat 模型和向量策略由系统自动选择。DeepSeek/OpenRouter 默认使用本地隐私向量，不会把简历发送给第三方 Embedding 服务。OpenAI 可选择外部 Embedding，但必须由站长显式勾选数据外传授权。

个人资料的结构化字段和 Markdown 原文保存在 D1，简历、头像等原始文件保存在私有 R2。后台“个人资料”页可直接修改显示名称、职业标题、头像和 Markdown 介绍，并上传 PDF/Markdown 简历；保存后主站侧边栏、头像和“关于我”页面读取同一份数据。头像通过 Worker 受控输出，不公开 R2 Bucket。文本型 PDF/TXT/Markdown 经 Queue 异步解析；本地隐私模式使用 D1 向量回退，显式授权外部 Embedding 后使用版本化 Vectorize 索引。切换模型应新建索引版本并重建，不能把不同维度混入同一索引。

后台用量页和 ECharts 从 `usage_events` 读取真实 Chat/Embedding 请求、Token、延迟与状态。费用只有在渠道价格可确定时才是估算值；它不等同于厂商账户真实余额。

## Cloudflare 资源初始化

正式部署需要：

- 两个 Workers：`ai-bunshin-web`、`ai-bunshin-admin`
- 一个 D1：`ai-bunshin`
- 一个 R2：`ai-bunshin-assets`
- 一个 Vectorize：`ai-bunshin-knowledge-v1`
- 一个 Queue 和一个 DLQ
- 一个 KV namespace

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

将命令返回的资源 ID 写入两个应用的 `wrangler.jsonc`，然后：

```bash
pnpm db:migrate:remote
pnpm deploy
```

建议域名：

- `example.com` → `ai-bunshin-web`
- `admin.example.com` → `ai-bunshin-admin`

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

访客端已部署到 Cloudflare Workers。管理后台等待账号启用 R2 后运行 `pnpm deploy:production` 完成发布；PDF 解析、真实用量看板和完整内容编辑仍属于后续功能迭代，不影响基础部署。

## License

Apache-2.0。第三方依赖继续遵循其各自许可证。
