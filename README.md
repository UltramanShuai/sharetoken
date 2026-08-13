# TokenPool（ShareToken）

社区共建的 LLM API Key 共享池网关：用户把闲置的官方 API Key 贡献进公共池赚取积分，其他用户用池内额度按模型调用，按「模型商 + 模型」粒度准入。

## 特性

- **公共贡献池**：贡献闲置 Key 赚积分（按模型系数），他人调用池内模型花积分
- **平台 Key**：每用户一把独立平台 Key，统一网关入口，兼容 OpenAI `/v1/chat/completions` 协议
- **安全设计**：Key 以 pgsodium 加密落库、白名单卡中转、RLS 收紧、限流（60/120/50）、熔断（5 连错）、防刷（×0 自调 / 日上限 2 / 24h 冷静）
- **经济模型**：积分账本（贡献赚 / 使用花，花 = 赚 × 2 同模型系数）、注册奖励、每日上限
- **鉴权**：邮箱密码 + OTP 注册、GitHub/Google OAuth、Cloudflare Turnstile 人机验证、忘记密码
- **计量**：调用统计、按模型分布、积分流水、健康检测（每 10 分钟，fail-closed）

## 架构

```
用户 → Nginx(HTTPS, CSP) → 自研 Node 网关(gateway.mjs) → 上游模型商 API（按贡献 Key 白名单中转）
                ↘ / → 静态前端 public/index.html
                      ↘ Supabase（auth / 数据 / RPC / 加密存储）
```

- **网关**：`gateway.mjs`（上游转发、LKGP 粘性选路、计量记账、熔断）
- **前端**：`public/index.html`（单文件 SPA，supabase-js SDK 本地引用）
- **数据库**：`db/`（schema 演进 SQL，按版本顺序执行）
- **运维**：`healthcheck.mjs`（fail-closed 健康检测）、`healthcheck-alert.mjs`（Bark 告警）、`scripts/`（日度重置、配置注入、网关校验）

## 快速部署

### 1. Supabase 准备

1. 新建 Supabase 项目（记录 Project URL、service_role key、publishable key）
2. SQL Editor 按顺序执行 `db/` 目录下的 SQL（版本顺序见各文件头注释）
3. Auth Providers 开启 Email（含 OTP）/ GitHub / Google，并按需配置 CAPTCHA（Cloudflare Turnstile → 填 secret）
4. 配置 `allowed_models` / `rate_rules` 表（模型商白名单与系数）

### 2. 本地配置

```bash
cp .env.example .env
# 编辑 .env：填 SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_PUBLISHABLE_KEY / TURNSTILE_SECRET / TURNSTILE_SITEKEY 等
bash scripts/apply-config.sh   # 从 .env 生成 public/index.html（含前端常量，该文件不进 git）
```

### 3. 启动网关

```bash
npm install   # 仅 supabase-js（前端 SDK 本地引用，见 public/supabase-js.js）
node gateway.mjs        # 监听 127.0.0.1，由 nginx 反代（参考 deploy/nginx-tokenpool.conf）
node healthcheck.mjs    # 由 cron 周期执行（见 deploy/tokenpool-reset.cron 同目录配置）
```

## 配置说明

| 变量 | 用途 |
|---|---|
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_SERVICE_KEY` | service_role key（仅后端 .env，绝不进前端） |
| `SUPABASE_PUBLISHABLE_KEY` | 前端 createClient 用（经 apply-config.sh 注入 index.html） |
| `TURNSTILE_SECRET` | Turnstile 后端校验 secret |
| `TURNSTILE_SITEKEY` | Turnstile 前端 sitekey（注入 index.html） |
| `PUBLIC_URL` | 对外访问地址（告警链接等） |
| `BARK_KEY` | Bark 推送 key（可选，告警用） |

## 测试

```bash
for f in test/test-*.mjs; do node "$f"; done
node scripts/test-gateway-baseurl.mjs
```

## 许可

MIT License
