# ai-bunshin 设计文档

`ai-bunshin` 是一个单人自托管的 AI 个人分身、简历与博客项目。仓库包含两个面向不同使用者的应用和一个可选内部模型执行服务：

- `apps/web`：公开访客端，无注册、无用户体系。
- `apps/admin`：仅站长使用的后台，包含内容、RAG、模型渠道和数据统计能力。
- `apps/runtime`：通过私有 HTTP Service Binding 调用的 Placement Model Worker，只负责 Chat、Embedding 和渠道健康检查；不依赖 Cloudflare Container。

## 文档索引

- [产品需求文档](./product-requirements.md)
- [技术架构方案](./technical-architecture.md)
- [Monorepo 项目结构](./repository-structure.md)
- [数据、安全、GEO/SEO 与 Cloudflare 部署](./security-seo-deployment.md)
- [生产监控、混合 RAG 与 Turnstile](./observability-rag-turnstile.md)
- [生产环境端到端验收记录（2026-11-27）](./production-acceptance-2026-11-27.md)
- [邮箱密码重置与模型连接方案](./password-reset-and-model-connectivity.md)
- [离线恢复码与密码重置方案](./offline-recovery-codes.md)
- [Placement Model Worker 拆分与迁移方案](./ai-runtime-architecture.md)
- [模型执行路由、状态机与故障恢复](./provider-execution-state-machine.md)

## 已确认的产品边界

1. 系统只有一个站长，不做组织、多租户、充值和支付。
2. 公开站点只有访客概念，不提供注册或登录。
3. 站长在后台配置自己的模型厂商和 API Key。
4. 后台支持简历、文章、纯文本、Markdown 和 PDF 数据源。
5. 数据源可选择已有分类、创建分类或不分类。
6. 文章可选择是否进入 RAG；没有分类时前台不显示分类入口。
7. 公开 UI 参考 `https://shijayhuo.github.io/` 的信息架构和交互语言，但采用 clean-room 方式独立实现，不复制其个人内容和受版权保护的素材。
8. 目标平台为 Cloudflare Workers。

## 名称约定

项目根目录与产品代号统一使用 `ai-bunshin`。Bunshin 取“分身”之意。
