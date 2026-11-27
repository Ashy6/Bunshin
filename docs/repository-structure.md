# Monorepo 项目结构

## 1. 结构原则

- 产品层面只有两个用户端：`web` 和 `admin`；另有一个可选内部模型执行服务 `runtime`。
- `web` 负责公开页面、公开只读 API 和对话流。
- `admin` 负责后台 UI、管理 API，以及 Queue 消费者。
- `runtime` 只负责带 Placement Hint 的 Chat、Embedding 和渠道测试，不持有业务数据。
- 共享代码只能放入职责明确的 `packages`，禁止创建无边界的 `shared` 大杂烩。
- Cloudflare 资源定义集中管理，开发、预览和生产环境使用独立绑定。

## 2. 建议目录

```text
ai-bunshin/
├── apps/
│   ├── web/                         # 访客端：SSR + Public Worker
│   │   ├── app/
│   │   │   ├── components/
│   │   │   ├── features/
│   │   │   │   ├── agent/
│   │   │   │   ├── articles/
│   │   │   │   ├── portfolio/
│   │   │   │   └── search/
│   │   │   ├── routes/
│   │   │   ├── styles/
│   │   │   └── root.tsx
│   │   ├── worker/
│   │   │   ├── api/
│   │   │   ├── middleware/
│   │   │   └── index.ts
│   │   ├── public/
│   │   ├── tests/
│   │   ├── vite.config.ts
│   │   └── wrangler.jsonc
│   │
│   ├── admin/                       # 后台 SPA/SSR + Admin Worker + Queue
│       ├── app/
│       │   ├── components/
│       │   ├── features/
│       │   │   ├── auth/
│       │   │   ├── dashboard/
│       │   │   ├── documents/
│       │   │   ├── articles/
│       │   │   ├── taxonomy/
│       │   │   ├── providers/
│       │   │   └── settings/
│       │   └── routes/
│       ├── worker/
│       │   ├── api/
│       │   ├── jobs/
│       │   │   ├── parse-document.ts
│       │   │   ├── chunk-document.ts
│       │   │   ├── embed-document.ts
│       │   │   └── rebuild-index.ts
│       │   ├── middleware/
│       │   ├── queue.ts
│       │   └── index.ts
│       ├── tests/
│       ├── vite.config.ts
│       └── wrangler.jsonc
│
│   └── runtime/                     # 内部 Placement Model Worker
│       ├── src/app.ts               # Hono 内部协议与模型适配
│       ├── src/index.ts             # 可选 Node 本地开发入口
│       ├── src/worker.ts            # Cloudflare fetch 入口
│       ├── wrangler.jsonc           # Service Worker 与 Placement Hint
│       ├── .env.example
│       └── package.json
│
├── packages/
│   ├── ai/                          # Provider adapters、路由、流式响应
│   ├── auth/                        # 单管理员会话、密码、TOTP
│   ├── config/                      # 类型安全配置与环境校验
│   ├── content/                     # Markdown、目录、Slug、HTML 清洗
│   ├── crypto/                      # Key 加解密与哈希
│   ├── db/                          # D1 schema、Drizzle、migrations
│   ├── domain/                      # 领域实体、枚举、业务规则
│   ├── observability/               # 日志、Trace、Usage events
│   ├── rag/                         # Parser、chunker、retriever、citation
│   ├── ui/                          # 设计令牌与通用 UI
│   └── validation/                  # Zod schema、API contract
│
├── tooling/
│   ├── eslint/
│   ├── typescript/
│   └── vitest/
│
├── infra/
│   ├── cloudflare/
│   │   ├── d1/
│   │   ├── queues/
│   │   ├── r2/
│   │   └── vectorize/
│   └── scripts/
│
├── docs/
├── .github/workflows/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

## 3. 应用边界

### apps/web

- 公开 SSR 页面。
- 文章、分类、标签、归档和搜索。
- 公共资源下载。
- Agent SSE 流式对话。
- 公开接口只允许读取已发布、允许公开的数据。
- 不包含后台表单或密钥管理代码。

### apps/admin

- 后台登录与 MFA。
- 内容和知识库 CRUD。
- 文件直传 R2 的签名流程。
- 模型配置、加密 Key 和连接测试。
- ECharts 聚合数据接口。
- Queue 消费者执行解析、切片和向量化。
- 管理接口只通过独立后台域名提供。

### apps/runtime

- 仅提供 HMAC 签名保护的内部接口。
- 模型 Key 只存在于运行平台 Secret。
- 不访问 D1、R2、Vectorize、Session 或访客 Cookie。
- 预设厂商使用固定 Base URL，自定义厂商必须进入允许列表。
- 默认以普通 Cloudflare Worker 部署，并使用 `aws:us-east-1` Placement Hint；这不是固定区域或固定出口保证。
- 生产内部接口使用 HMAC、时间窗和防重放校验。

## 4. 包依赖方向

```text
apps/*
  ↓
domain / validation / ui
  ↓
db / ai / rag / auth / crypto / observability
```

约束：

- `domain` 不依赖具体 Cloudflare SDK。
- `rag` 通过接口使用 Embedding 与 Vector Store。
- `ai` 不能直接访问 UI 或路由。
- `db` 不包含页面展示逻辑。
- `apps/web` 不得导入 Admin 专属模块。

## 5. 主要脚本

```text
pnpm dev                 # 同时启动 web/admin 和本地资源模拟
pnpm dev:web
pnpm dev:admin
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm db:migrate
pnpm db:seed
pnpm cf:setup            # 创建 D1/R2/Vectorize/Queue
pnpm deploy:preview
pnpm deploy:production
```

## 6. 环境

- `local`：本地 Miniflare/Wrangler。
- `preview`：Pull Request 预览资源。
- `production`：正式域名与正式数据。

三个环境使用不同的 D1、R2、Vectorize 和 Queue，禁止预览环境读取生产数据。
