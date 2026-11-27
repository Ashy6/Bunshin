# 邮箱密码重置与模型连接方案

## 1. 邮箱验证码重置密码

后台使用 Cloudflare Email Service 的 Worker binding 发送事务邮件。部署者需要先在 Cloudflare Dashboard 的 Email Service 中 Onboard 自己的发件域名，完成 SPF、DKIM 和 DMARC 配置，再设置 `PASSWORD_RESET_FROM_EMAIL`。

流程：

1. 登录页读取 `/api/admin/auth/status`；只有 Email binding 与发件地址同时存在时才显示“忘记密码”。
2. 用户提交邮箱后，接口始终返回相同文案，避免攻击者枚举管理员邮箱。
3. 服务端按“来源 IP + 规范化邮箱”的 SHA-256 键限流，15 分钟最多请求 3 次。
4. 生成 6 位验证码，只将 `SHA-256(code + SESSION_SECRET)` 写入 D1；旧的未使用验证码立即作废。
5. 验证码 10 分钟有效，最多尝试 5 次。邮件发送在 `waitUntil` 中异步执行，避免响应时间暴露邮箱是否存在。
6. 校验成功后使用现有 PBKDF2-SHA256 生成新密码哈希，并删除该管理员的全部 Session。

生产配置：

```bash
pnpm exec wrangler secret put PASSWORD_RESET_FROM_EMAIL --config apps/admin/wrangler.jsonc
```

值示例：`Bunshin <no-reply@example.com>`。该域名必须已在 Cloudflare Email Service 中验证。Cloudflare Free 计划只能向账号中验证过的目标邮箱发送；向任意地址发送需要符合其当前套餐要求。

## 2. 国内访问与模型连接不是同一个问题

门户浏览器不会直接请求 OpenAI。真实链路为：

```text
访客浏览器 → Bunshin Web Worker → 模型厂商
```

因此：

- 如果国内设备打不开门户，应该给 Web Worker 绑定自己的 Custom Domain；修改模型 Base URL 无法修复门户域名不可达。
- 如果门户可以打开，但 Web Worker 请求模型失败，才需要检查模型厂商、Cloudflare 出口、API Key 权限或服务端网关。
- API Key 永远不下发浏览器，也不应由前端直接请求 OpenAI，否则会泄露密钥并遇到 CORS 与网络限制。

## 3. 推荐的模型网关顺序

1. 默认使用 Worker 服务端直连官方模型地址，链路最短。
2. 需要观测、限流、缓存或路由时，优先使用部署者自己 Cloudflare 账号中的 AI Gateway。
3. 需要区域模型时，选择支持 OpenAI 协议且能够从 Cloudflare 访问的正规厂商。
4. 只有完全信任并控制网关时才配置自定义 Base URL。模型 API Key 会作为 Authorization 凭据发送到该网关，不能把 Key 交给来源不明的“公共反代”。

Cloudflare AI Gateway 的 OpenAI 地址格式为：

```text
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
```

接入前必须由站长明确选择以下一种凭据模式：

- Provider Key passthrough：Bunshin 将模型厂商 Key 发送给站长自己的 AI Gateway。
- Cloudflare BYOK：模型 Key 存在 AI Gateway，Bunshin 使用 Cloudflare Gateway 凭据。

两种模式都会改变密钥流向，不能在没有站长明确授权和具体 Gateway 标识时自动开启。

## 4. 安全边界

- 自定义 Base URL 必须使用 HTTPS，禁止内网、环回、链路本地和保留地址，防止 SSRF。
- 禁止跟随把 Authorization 转发到不同主机的重定向。
- 渠道测试必须先成功，才能设为默认渠道。
- Gateway 与直连的失败、延迟和费用需要分别写入 Usage/Observability，便于回退。
- 门户自定义域名、Cloudflare AI Gateway 和第三方模型网关是三个不同配置，不应在 UI 中混成一个“代理域名”。
