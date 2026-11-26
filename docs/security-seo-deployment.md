# 数据、安全、GEO/SEO 与 Cloudflare 部署

## 1. 数据存储

| 数据 | 存储 | 说明 |
|---|---|---|
| 文章、分类、简历、配置、用量 | D1 | 关系数据与聚合统计 |
| PDF、图片、简历附件 | R2 | 默认私有桶，通过 Worker 鉴权访问 |
| 向量 | Vectorize | 仅保存 chunk ID、向量和最少元数据 |
| 原始切片正文 | D1 | 通过 Vectorize 返回 ID 后回查，便于权限控制 |
| 限流与短缓存 | KV/Cache API | 不作为权威数据源 |
| 异步任务 | Queues | 解析、切片、Embedding 和索引更新 |

## 2. 加密方案

### 2.1 传输中

- 所有公开和后台域名仅允许 HTTPS。
- 开启 HSTS，生产环境考虑 preload 前先验证所有子域。
- Worker 与 D1/R2 使用 Cloudflare 内部 TLS/绑定访问。
- 外部模型请求仅允许 HTTPS，并校验自定义 Base URL，阻止内网和保留地址，避免 SSRF。

### 2.2 静态存储

- D1 和 R2 由 Cloudflare 提供静态 AES-256 加密。
- Provider API Key 额外使用应用层 AES-256-GCM 信封加密。
- `MASTER_ENCRYPTION_KEY` 只存 Worker Secret，不进入 D1、Git 或构建产物。
- 每条密钥记录使用随机 nonce，并保存密钥版本用于轮换。
- 管理员密码使用 Argon2id；若 Worker 运行时兼容性不足，使用经过评审的 scrypt/WebCrypto 方案。
- TOTP Secret 加密保存；恢复码只保存哈希。

### 2.3 日志与隐私

- 永不记录 API Key、Authorization、Cookie 和完整 prompt。
- 访客 IP 使用带周期轮换盐的 HMAC 生成匿名标识，不永久保存原始 IP。
- 对话默认只保存用量和安全元数据；是否保存对话正文由站长显式开启，并在前台隐私声明中披露。
- RAG 的“仅供 AI”文档允许作为回答依据，但引用只展示安全标题与摘要，不暴露原文下载地址。

## 3. 后台安全

- Admin 使用独立子域，例如 `admin.example.com`。
- 会话 Cookie：`Secure`、`HttpOnly`、`SameSite=Strict`。
- 写请求使用同源 Origin 校验；会话 Cookie 使用 `SameSite=Strict`。当前个人版没有单独的 CSRF Token 表单流程。
- 登录已按来源 IP 与邮箱组合哈希限流：15 分钟内连续失败 8 次后暂时阻断。访客问答另有分钟与每日额度；更细粒度的模型测试、上传和删除限流仍属于后续加固项。
- TOTP MFA、恢复码和敏感操作近期重新认证尚未发布，不应在部署说明中视为已完成能力。
- 文件上传检查 MIME、扩展名、大小和魔数；随机化对象 Key。
- HTML/Markdown 渲染必须进行 allowlist 清洗，禁止任意脚本和事件属性。
- CSP 默认禁止内联脚本；使用 nonce/hash 处理必要脚本。
- 审计登录、密钥更新、内容发布、文档删除和索引重建。

建议响应头：

```text
Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy
Cross-Origin-Opener-Policy
```

## 4. SEO

### 4.1 技术 SEO

- 公开内容 SSR，文章有稳定、语义化 URL。
- 每页唯一 `title`、`description`、canonical。
- Open Graph、Twitter Card 和文章封面。
- `sitemap.xml`、`robots.txt`、RSS/Atom Feed。
- 文章使用 `Article`/`BlogPosting` JSON-LD。
- 个人页使用 `Person` JSON-LD，站点使用 `WebSite` JSON-LD。
- 面包屑使用 `BreadcrumbList`。
- 分类、标签和归档页支持分页，并避免无限组合索引。
- 草稿、后台、预览、搜索结果页设置 noindex。
- 图片提供尺寸、现代格式、懒加载与 alt。
- 保证 Core Web Vitals，避免整站依赖客户端渲染。

## 5. GEO（生成式引擎优化）

GEO 目标是让搜索与问答系统能够准确识别“你是谁、做过什么、证据在哪里”，不是为 AI 爬虫复制另一套虚假内容。

- 简历、项目和文章使用清晰标题、摘要、作者、日期和稳定 URL。
- 关键经历给出可验证事实与公开来源链接。
- 文章首屏提供简明摘要和更新日期。
- 提供 `llms.txt` 作为站点内容导航，同时保留 Sitemap 和结构化数据作为主标准。
- `llms-full.txt` 仅在站长开启时生成，只包含公开内容。
- Agent 回答引用可访问的 canonical URL。
- 不输出未公开知识库全文给爬虫。
- 对已更新事实保留 `dateModified`，必要时提供勘误说明。
- 默认允许主流搜索引擎；AI crawler 是否允许由后台策略配置，并反映到 robots.txt。

## 6. Cloudflare 资源

建议每个环境创建：

```text
Workers
├── ai-bunshin-web-{env}
└── ai-bunshin-admin-{env}

D1
└── ai-bunshin-{env}

R2
└── ai-bunshin-assets-{env}

Vectorize
└── ai-bunshin-knowledge-v1-{env}

Queues
├── ai-bunshin-ingestion-{env}
└── ai-bunshin-ingestion-dlq-{env}

KV
└── ai-bunshin-cache-{env}
```

生产域名建议：

- `example.com`：访客端。
- `admin.example.com`：后台。

## 7. 部署流程

```text
Pull Request
→ lint/typecheck/unit tests
→ build web/admin
→ preview resources + preview deploy
→ Playwright smoke tests
→ merge main
→ D1 migration（向前兼容）
→ deploy admin worker
→ deploy web worker
→ smoke tests
→ 标记 release
```

数据库迁移采用 expand/contract：先新增兼容字段和表，再发布读取逻辑，最后在后续版本清理旧结构。

## 8. 开源部署体验

仓库应提供：

- `README.md` 快速开始。
- `.dev.vars.example` 与秘密变量清单。
- `pnpm cf:setup` 创建 Cloudflare 资源。
- `pnpm db:migrate` 和 `pnpm admin:init`。
- 示例文章、简历和演示知识库。
- GitHub Actions 部署模板。
- Provider、Embedding 维度和 Vectorize 索引配置指南。
- 数据导出、备份、恢复和版本升级文档。

首次启动向导：

1. 检查 D1/R2/Vectorize/Queue 绑定。
2. 创建管理员与 MFA。
3. 配置网站资料。
4. 配置 Chat 与 Embedding Provider。
5. 上传简历并完成首次索引。
6. 预览后发布。

## 9. 官方能力依据

- Cloudflare 建议新项目优先使用 Workers Static Assets：<https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers Static Assets：<https://developers.cloudflare.com/workers/static-assets/>
- D1 数据安全：<https://developers.cloudflare.com/d1/reference/data-security/>
- R2 数据安全：<https://developers.cloudflare.com/r2/reference/data-security/>
- Worker Secrets：<https://developers.cloudflare.com/workers/configuration/secrets/>
- Vectorize 元数据过滤：<https://developers.cloudflare.com/vectorize/reference/metadata-filtering/>
- Cloudflare Queues：<https://developers.cloudflare.com/queues/get-started/>
