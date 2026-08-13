# ShareToken 部署 SOP（从零到上线）

> 目标环境：Ubuntu/Debian x64 服务器 + Supabase 云（Postgres/Auth/RLS）+ Cloudflare Turnstile。
> 全程手工执行，每节末尾带「验证」。预计耗时 1.5~2.5 小时（含等待）。

## 0. 架构与端口

```
用户浏览器 ──TLS 19876──> Nginx ──静态──> /root/project/llm-key-manager/public/
                              └─/v1/* 反代──> 自研网关 gateway.mjs（127.0.0.1:20140）
                                                   │ fetch + service_role key
                                                   ▼
                                        Supabase（REST / RPC / Auth）
                                                   │
                              上游模型商 API（按 allowed_models 白名单域名直连）
```

| 组件 | 监听 | 说明 |
|---|---|---|
| Nginx | 0.0.0.0:19876（TLS） | 公网唯一入口 |
| gateway.mjs | 127.0.0.1:20140 | 仅本机，不直接暴露 |
| healthcheck.mjs | 无监听 | cron 周期执行，fail-closed |
| Supabase | 云端 | 无自建 DB |

## 1. 前置条件

- [ ] 服务器：≥2C2G，可 root；Node.js ≥20（`node -v`）
- [ ] 域名：已解析 A 记录到服务器 IP（如 `share.example.com`）
- [ ] 安全组/防火墙：放行 TCP 19876（TLS）；如用 80 做证书验证需临时放行 80
- [ ] 账号：Supabase、Cloudflare（Turnstile）、GitHub（OAuth App，可选）、Google Cloud（OAuth，可选）
- [ ] 网络：服务器需可直连国内模型 API 域名（见第 7 节 GFWList 说明）

## 2. Supabase 配置

### 2.1 创建项目

1. dashboard.supabase.com → New project（区域建议 Singapore，离国内延迟低且无需代理）
2. 记录 **Project Reference**（形如 `abcdefghijklmnop`）与 **Project URL**（`https://<ref>.supabase.co`）

### 2.2 执行 SQL（顺序敏感，勿跳步）

SQL Editor 依次全选执行以下文件（仓库 `db/` 目录）：

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | `schema-phase2.sql` | 建表：llm_keys / pool_contributions / allowed_models / rate_rules / reward_tiers / reward_config / app_config / 积分账本等 + 基础函数 |
| 2 | `fix-v3.sql` | 核心 RPC 加密重写（pgp 加密存 Key、reveal 权限修复、贡献/平台 Key 流程） |
| 3 | `fix-v5-rls-tightening.sql` | RLS 收紧、经济模型（花=赚×2）、update_llm_key 路径白名单 |
| 4 | `anti-abuse.sql` | 防滥用语义参考（函数实际定义以 fix-v3 为准） |
| 5 | `seed-example.sql` | 种子数据：reward_config / reward_tiers / allowed_models / rate_rules |

**验证**：`select count(*) from public.allowed_models;` 应 ≥6。

### 2.3 Auth 配置

Authentication → Providers：

- **Email**：开启（OTP 一并开启）；Site URL 填 `https://你的域名:19876`；Redirect URLs 加 `https://你的域名:19876/**`
- **GitHub / Google**（可选）：各自创建 OAuth App，Callback 用 Supabase 提供的 URL，回填 client id/secret
- **CAPTCHA**（重要，否则 Turnstile 验证全失败）：
  - Provider 选 **Turnstile**，Secret key 填第 3 节拿到的 **secret**（不是 sitekey）
  - 注册类接口（signup/otp/password reset）都需要该 secret 校验

### 2.4 收集 Key

Project Settings → API，收集 3 个值：

| 值 | 用途 | 写进哪 |
|---|---|---|
| Project URL | 后端 fetch / 前端常量 | `.env` 的 `SUPABASE_URL` |
| publishable key（`sb_publishable_` 开头） | 前端 createClient | `.env` 的 `SUPABASE_PUBLISHABLE_KEY` |
| service_role key | 后端 RPC/REST（权限最高） | `.env` 的 `SUPABASE_SERVICE_KEY`，**绝不进前端/仓库** |

## 3. Cloudflare Turnstile

1. Cloudflare Dash → Turnstile → Add widget（Widget Mode: **Managed**）
2. **Hostname 填正式访问域名**（如 `share.example.com`）。⚠️ Turnstile hostname 是精确匹配：
   - 页面域名与这里不一致 → widget 无法验证（"总是失败"的常见根因）
   - 裸域名配置不覆盖子域名；多个入口就配多个 hostname
3. 得到 **Site key**（前端）与 **Secret key**（后端校验）
4. **验证 secret 有效性**（可选但推荐）：
   ```bash
   curl -s -X POST https://challenges.cloudflare.com/turnstile/v0/siteverify \
     -d 'secret=<SECRET>&response=invalid-test'
   # 返回 invalid-input-response = secret 有效；invalid-input-secret = 抄错了
   ```

## 4. 服务器部署

### 4.1 代码与目录

```bash
mkdir -p /root/project && cd /root/project
git clone https://github.com/<你的用户名>/sharetoken.git llm-key-manager
cd llm-key-manager
# gateway.mjs 为原生 Node ESM，零第三方依赖，无需 npm install
```

### 4.2 环境配置

```bash
cp .env.example .env
chmod 600 .env
vim .env   # 填 6 个键（见 .env.example 注释）：
#   SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_PUBLISHABLE_KEY
#   TURNSTILE_SECRET / TURNSTILE_SITEKEY / PUBLIC_URL（可选 BARK_KEY）
bash scripts/apply-config.sh   # 生成 public/index.html（真实配置版，已 gitignore）
```

**验证**：`grep -c "__SUPABASE" public/index.html` 应为 0（占位符全部替换）。

### 4.3 systemd 网关服务

`/etc/systemd/system/tokenpool-gateway.service`：

```ini
[Unit]
Description=TokenPool Gateway
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /root/project/llm-key-manager/gateway.mjs
WorkingDirectory=/root/project/llm-key-manager
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now tokenpool-gateway
```

**验证**：`systemctl is-active tokenpool-gateway` → active；`curl -s http://127.0.0.1:20140/v1/models` → 200。

### 4.4 Nginx

```bash
cp deploy/nginx-tokenpool.conf /etc/nginx/sites-available/tokenpool
# 编辑：server_name 改 YOUR-DOMAIN；
#       CSP 中 https://YOUR-PROJECT.supabase.co 换成你的 Supabase URL；
#       root 路径按实际部署位置
ln -s /etc/nginx/sites-available/tokenpool /etc/nginx/sites-enabled/tokenpool
chmod -R 755 /root/project/llm-key-manager/public   # nginx worker 需要读权限
nginx -t && systemctl reload nginx
```

要点（conf 内已注明）：`/` 与白名单静态文件 → public/；`/v1/*` → 127.0.0.1:20140；其余 404；**API 502/503 返回 JSON 而非落到 index.html**。

### 4.5 证书（acme.sh）

```bash
curl https://get.acme.sh | sh
~/.acme.sh/acme.sh --register-account -m 你的邮箱
# 方式 A：80 端口验证（需临时放行 80 且站点已指向本机）
~/.acme.sh/acme.sh --issue -d 你的域名 --standalone
# 方式 B：DNS API 验证（无需 80），以 Cloudflare 为例：
#   export CF_Token=... CF_Account_ID=...
#   ~/.acme.sh/acme.sh --issue -d 你的域名 --dns dns_cf
mkdir -p /etc/nginx/ssl
~/.acme.sh/acme.sh --install-cert -d 你的域名 \
  --key-file /etc/nginx/ssl/privkey.pem --fullchain-file /etc/nginx/ssl/fullchain.pem \
  --reloadcmd "systemctl reload nginx"
chmod 600 /etc/nginx/ssl/privkey.pem
```

**验证**：`curl -sI https://你的域名:19876/ | head -3` → 200 + 证书有效。

### 4.6 cron 任务（4 个）

`/etc/cron.d/tokenpool-reset`（每日 00:05 清零 used_today + 撤回过期贡献；文件末尾必须保留换行、**严禁 UTF-8 BOM**——BOM 会导致脚本不被执行）：

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
5 0 * * * root /usr/bin/flock -n /tmp/tokenpool-reset.lock /usr/bin/node /root/project/llm-key-manager/scripts/reset-daily.mjs >> /var/log/tokenpool-reset.log 2>&1
```

其余 3 个：

```cron
# /etc/cron.d/llm-key-healthcheck —— 每 10 分钟健康检测（fail-closed：白名单加载失败即非零退出）
*/10 * * * * root /usr/bin/node /root/project/llm-key-manager/healthcheck.mjs >> /var/log/llm-key-healthcheck.log 2>&1

# /etc/cron.d/tokenpool-alert —— 每 5 分钟告警（Bark，需 .env 配 BARK_KEY）
*/5 * * * * root /usr/bin/node /root/project/llm-key-manager/healthcheck-alert.mjs >> /var/log/tokenpool-alert.log 2>&1

# /etc/cron.d/tokenpool-cleanup —— 每日 00:10 清理 health_checks(7d)/usage_events(90d)
10 0 * * * root /root/project/llm-key-manager/cleanup.sh >> /var/log/tokenpool-cleanup.log 2>&1
```

**验证**：`head -c 3 /etc/cron.d/tokenpool-reset | od -c` 不应是 `357 273 277`（BOM）。

## 5. 初始化种子数据

1. `db/seed-example.sql` 已在第 2.2 步执行，含：奖励参数、等级配额、6 家模型商白名单、模型系数
2. **生成本地密钥**（app_config.field_key，加密相关）：
   ```bash
   openssl rand -hex 32   # 复制输出
   ```
   到 SQL Editor 执行（替换 `<值>`）：
   ```sql
   insert into public.app_config (key, value) values ('field_key', '<值>')
   on conflict (key) do update set value = excluded.value;
   ```
3. 自定义：调整 `rate_rules` 系数（按你设定的价格锚）、`allowed_models` 开放更多模型商

## 6. 全链路验证清单

- [ ] `curl -sk https://你的域名:19876/` → 200 且响应含 CSP 头
- [ ] `curl -sk https://你的域名:19876/v1/models` → 200 JSON（模型列表）
- [ ] 浏览器打开页面：登录/注册页出现，**无**人机验证框（懒加载：点「发送验证码」才出现）✅
- [ ] 注册流程：填邮箱密码 → 点发送验证码 → Turnstile 弹出 → 邮箱收码 → 验证成功进入主界面
- [ ] 主界面「我的 Key」→ 新增平台 Key：任意模型商官方 Key + base_url（国内商 `/v1`；智谱 `/api/paas/v4`）
- [ ] 「公共池」→ 贡献该 Key 到某模型 → 状态「贡献中」
- [ ] 用平台 Key 调一次池内模型（OpenAI 兼容）：
  ```bash
  curl -s https://你的域名:19876/v1/chat/completions \
    -H "Authorization: Bearer <平台Key>" -H "Content-Type: application/json" \
    -d '{"model":"<池内模型ID>","messages":[{"role":"user","content":"hi"}]}'
  ```
- [ ] 「用量」页出现刚才的调用记录；积分页有流水
- [ ] 手动跑 `node healthcheck.mjs; echo $?` → 0
- [ ] 次日 00:05 后 used_today 归零（`/var/log/tokenpool-reset.log`）

## 7. 网络与代理（国内服务器）

- 国内模型商 API（minimax/deepseek/xiaomi/zhipu/moonshot/qwen）在服务器上**必须直连**，不要走机场代理（会被限流/拒绝）
- 若还需入池被墙模型商（openai/anthropic 等），建议 v2rayA **GFWList 模式**（default: direct + 被墙域名走代理），示例 RoutingA：

```text
default: direct

domain(ext:"LoyalsoldierSite.dat:gfw")->proxy
domain(ext:"LoyalsoldierSite.dat:greatfire")->proxy
domain(geosite:google)->proxy
domain(geosite:google-scholar)->proxy
domain(geosite:github)->proxy
domain(geosite:category-scholar-!cn)->proxy

ip(geoip:hk,geoip:mo)->proxy
ip(geoip:private, geoip:cn)->direct
```

⚠️ OpenAI/Google API 即使走代理也可能被节点 IP 封锁（表现为连接超时），这是节点质量问题，与路由配置无关。

## 8. 日常运维

| 事项 | 位置/命令 |
|---|---|
| 网关日志 | `journalctl -u tokenpool-gateway -f` |
| 健康检测日志 | `/var/log/llm-key-healthcheck.log` |
| 告警日志 | `/var/log/tokenpool-alert.log` |
| 升级代码 | `cd /root/project/llm-key-manager && git pull && bash scripts/apply-config.sh && systemctl restart tokenpool-gateway` |
| DB 备份 | Supabase Dashboard → Database → Backups（PITR 建议开启） |
| 证书续期 | acme.sh 自动（cron 由安装脚本写入）；`~/.acme.sh/acme.sh --list` 查看 |

## 9. 常见问题

| 症状 | 根因 | 处理 |
|---|---|---|
| Turnstile 总是失败/不渲染 | widget hostname 与实际域名不匹配；或 Auth 的 CAPTCHA secret 抄错 | 第 3 节逐项核对；siteverify 命令验 secret |
| 保存 Key 报 base_url 路径错误 | 深路径不在白名单（仅允许 `/v1` `/api` `/api/paas/v4`） | 检查 base_url 是否带 `/v1/chat` 之类后缀 |
| used_today 不清零 | cron 文件被编辑器写入 UTF-8 BOM | `head -c 3` 检查；重写无 BOM 文件 |
| 贡献的 Key 状态「已限流」 | 上游健康检测连续失败被熔断 | 等 10 分钟自动复检，或公共池手动「尝试启用」 |
| /v1 请求 502 | 网关没起/端口不对 | `systemctl status tokenpool-gateway`；nginx proxy_pass 应为 127.0.0.1:20140 |
| 页面 403 | public/ 权限不是 755 | `chmod -R 755 public/` |
