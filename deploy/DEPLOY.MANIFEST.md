# TokenPool 上线前修复 — 部署清单（v5.4 加固）

> 上线加固清单 — 2026-08-12 提交的 v5.4 上线前修复。
> v5.4 调整：Base URL 契约统一（gateway/healthcheck/SQL/前端均保留 /v1；拒绝非默认端口与深路径；不允许静默剥 query/hash；纯尾斜杠规范化不触发撤回）；Turnstile 强制 single-use（删除前端预验 + 删除 `/v1/verify-turnstile` 端点；每次 Supabase Auth 调用后 `resetTurnstile()`；signInWithPassword 与 resetPasswordForEmail 传新 captchaToken；expired-callback 强制重验）；SQL 显式 enable RLS + owner_select=3 + 全 ACL 自检（aclexplode 检查 grantee=0 PUBLIC EXECUTE + pg_roles 查 anon/authenticated OID + 补验 authenticated 已授 owner RPC）；网关 lifecycle 引入 `clientAbortController` 并验证 exactly-once 释放；recovery race 修复（同一用户也弹 resetPwdModal）；healthcheck fail-closed 改为非零退出且不批量改状态；deploy/nginx 优先原位替换现网 sharetoken 站点并保留 symlink。
> v5.3 调整：REVOKE/GRANT 移到所有 `create or replace function` 之后；补齐 v5 原有的 pause_contribution / withdraw_contribution / withdraw_contributions_by_key RPC 定义；自检段移到脚本末尾；从 schema-phase2 + fix-v3(v4.7) 首升可走（已用 PostgreSQL 16 隔离验证通过）。
> v5.2 追加：SSRF TOCTOU（update_llm_key 重写 + 触发器 https 强校验 + 网关 defense-in-depth）；Turnstile 绑定（前端 signInWithOtp/verifyOtp 传 captchaToken + DEPLOY 强制人工开启 Supabase Auth CAPTCHA）。
> 主会话（agent:xiaobaga:main）需按"待主会话执行"清单，逐项在 `/etc` / Supabase / systemd 上落盘。
> 本子代理权限：仅修改 `/root/project/llm-key-manager` 内部；未触碰 `/etc`、数据库、systemd。

## 1. 已交付修改清单

### 1.1 修改文件
| 文件 | 改动摘要 | 行数变化 |
| --- | --- | --- |
| `db/fix-v5-rls-tightening.sql` | v5 → v5.2：扩展到 llm_keys；新增 owner-only `delete_llm_key(p_id uuid)` RPC（atomic withdraw + soft-delete）；pool_keys pause/resume 移除不存在的 `updated_at`；resume_contribution 复检 enabled allowed_models/rate_rules 白名单；create_contribution 拒绝通配；显式 revoke public/anon 覆盖所有 RPC（含补漏 `update_llm_key`）；幂等动态 drop 三表所有写策略；自检抛错。**v5.2** 追加：`update_llm_key` 重写为严格 URL 校验 + base_url 变更时原子撤回贡献并返回 withdrawn count；`check_contrib_model` 触发器 + `resume_contribution` 服务端强校验 base_url `scheme=https` + 无 userinfo/query/hash。**v5.4** 追加：`update_llm_key` 接受单段路径 /v1 + 拒绝深路径 + 撤回判定只计 protocol/host/path；ACL 自检改用 `aclexplode()` 查 grantee=0 (PUBLIC) 是否授 EXECUTE（伪角色不在 pg_roles，旧实现漏验）+ `pg_roles` 查 anon/authenticated OID + 补验 authenticated 已授 owner RPC | +380 |
| `deploy/nginx-tokenpool.conf` | v1 → v2：根目录严格 `public/`；cert 直接引用 `/etc/nginx/ssl/{fullchain,privkey}.pem`；`/v1/` `proxy_read_timeout 300s`；取消 SPA fallback（白名单外 404）；API 502/504 → JSON（`@api_error` named location）；`/` `/index.html` `/favicon.svg` `/supabase-js.js` 全用 `expires` 指令代替 `add_header Cache-Control`（避免子 location add_header 覆盖父级安全头） | +50 |
| `gateway.mjs` | v2 → v3：上游 `fetch` 强制 `AbortController` 超时 270s（略低于 nginx 300s），每次 attempt 独立 timer；超时可重试；`keyRateMap` / `ipRateMap` 60s 清理 + `unref()`；客户端 `req.close` 释放并发槽；API contract 不变。**v5.2** 追加：每次选路硬校验上游 base_url（https only + 拒 userinfo/query/hash + 拒 localhost/私网/link-local + 命中 enabled allowed_models 白名单）；白名单拉取失败 fail-closed | +90 |
| `healthcheck.mjs` | v2 → v3：探测前 `parseSafeBaseUrl` 拒绝非 http/https / userinfo；`hostAllowed` 白名单（`allowed_models.enabled.allowed_hosts`）— 未命中标 unknown 不探测；fetch `redirect: 'manual'` 阻止重定向越权；抽共用函数 `parseSafeBaseUrl / hostAllowed / loadAllowedHosts`；白名单加载失败时本轮全部跳过（fail-closed） | +60 |
| `public/index.html` | Tab 键盘 `Arrow Left/Right/Home/End` 切换；密码重置兼容 Supabase v1 (hash) + v2 (query PKCE) + `PASSWORD_RECOVERY` 事件；`applySession` 单源避免 boot / onAuthStateChange 竞态；模态框 `role=dialog aria-modal aria-hidden` + 焦点恢复；调用示例 `api_key` 用 `<YOUR_PLATFORM_KEY>` 占位（`textContent` 安全）；删除键改走 `delete_llm_key` RPC。**v5.2** 追加：`signInWithOtp`/`verifyOtp`/`resendOtp` 传 `options.captchaToken` 绑定 Turnstile；saveKey 处理 update_llm_key 返回的 withdrawn count | +160 |
| `scripts/reset-daily.mjs` | 移除未使用的 `sbRpc`；错误改用 `process.exitCode`（不截断日志）；保持无 BOM、Asia/Shanghai 00:05 | −10 |
| `deploy/tokenpool-reset.cron` | 增加 `flock -n /var/run/tokenpool-reset.lock` 防并发；保留无 BOM | +2 |
| `deploy/DEPLOY.MANIFEST.md` | （本文件）按 v5.1 实际改动重写 | 重写 |

### 1.2 保留不变
- `gateway.mjs` / `healthcheck.mjs` / `healthcheck-alert.mjs` / `scripts/reset-daily.mjs` / `public/index.html`：实测均无 BOM（`od -An -c` 首三字节均为 ASCII：`2f 2f 20` / `3c 21 44`，不是 UTF-8 BOM `ef bb bf`）。v5.2 之前原文档误标“有 BOM”，本次按实测重写描述。
- `index.html`（根目录） — 保留作为开发参考副本；nginx 不会暴露
- `index.html.orig` — 显式不动
- `db/fix-v3.sql` / `db/schema-phase2.sql` — 保留
- `.env` / `docs/` / `cleanup.sh` / `tproxy-bypass.sh` — 全部未触碰

## 2. 测试结果（本子代理实际执行）

| 项 | 工具 | 结果 |
| --- | --- | --- |
| `node --check gateway.mjs` | node v22.23.0 | ✅ pass |
| `node --check healthcheck.mjs` | node v22.23.0 | ✅ pass |
| `node --check healthcheck-alert.mjs` | node v22.23.0 | ✅ pass |
| `node --check scripts/reset-daily.mjs` | node v22.23.0 | ✅ pass |
| 5 段 inline scripts 逐段 `node --check` | node v22.23.0 | ✅ 5/5 pass |
| 5 段 inline scripts 合并后 `node --check` | node v22.23.0 | ✅ pass |
| HTML 大括号 / 尖括号 / div / script 配对 | `awk` balance check | ✅ balance = 0 |
| `gateway.mjs` BOM 检查 | `od -An -c` | ✅ 无 BOM（v5.2 修正） |
| `public/index.html` BOM 检查 | `od -An -c` | ✅ 无 BOM |
| `db/fix-v5-rls-tightening.sql` BOM 检查 | `od -An -c` | ✅ 无 BOM |
| `deploy/nginx-tokenpool.conf` BOM 检查 | `od -An -c` | ✅ 无 BOM |
| `scripts/reset-daily.mjs` BOM 检查 | `od -An -c` | ✅ 无 BOM |
| `deploy/tokenpool-reset.cron` BOM 检查 | `od -An -c` | ✅ 无 BOM |
| 客户端直写 `pool_keys` / `pool_contributions` / `llm_keys` 静态扫描 | `rg` | ✅ 0 处（仅 RPC） |
| `pool_keys.updated_at` 引用静态扫描 | `rg` | ✅ 0 处（fix-v5.1 已移除） |
| nginx -t 候选 server block | `/usr/sbin/nginx -t` | ✅ pass（详见 §3.2） |
| `git diff --check` | git | （待主会话提交） |

> 注：子代理无 `psql` 直连权限，未在真实数据库执行 v5.1 SQL。下列 §3.1 自检 SELECT 必须由主会话执行后确认。

## 3. 待主会话执行（按顺序）

### 3.1 数据库：跑 v5.1 迁移（必须）
**主会话权限**：Supabase Dashboard > SQL Editor
**严禁**：命令行 psql 直连（service_role 旁路 RLS 会掩盖未生效真相）
**操作**：
```bash
# 0. 先备份当前关键 RPC（pg_dump 完整模式或手动）
pg_dump --schema-only --no-owner -h <host> -U postgres -d postgres > /tmp/schema-pre-v51.sql

# 1. Dashboard SQL Editor → 粘贴 db/fix-v5-rls-tightening.sql 全选 → Run
# 2. 输出末尾必须出现：
#    "OK: no client write policies on llm_keys/pool_keys/pool_contributions"
#    "OK: owner_select SELECT policy = 3"
#    "OK: owner RPC anon/PUBLIC denied; service_role RPC authenticated denied"
#    "OK: all 9 critical owner RPCs present (delete_llm_key, pause_pool_key, resume_pool_key, create_contribution, pause_contribution, resume_contribution, withdraw_contribution, withdraw_contributions_by_key, update_llm_key)"
#    "TokenPool fix v5.4 applied OK"
# 3. 自检（必跑；任意一项非预期即停止上线）：
```

```sql
-- (A) 写策略应为空
select tablename, policyname, cmd from pg_policies
where schemaname='public'
  and tablename in ('llm_keys','pool_keys','pool_contributions')
  and cmd in ('ALL','INSERT','UPDATE','DELETE');
-- 期望：0 行

-- (B) owner_select 应有 3 行（每表 1）
select tablename, policyname, cmd from pg_policies
where schemaname='public'
  and tablename in ('llm_keys','pool_keys','pool_contributions')
  and cmd='SELECT';
-- 期望：3 行 owner_select

-- (C) 关键 RPC 存在
select proname from pg_proc
where pronamespace='public'::regnamespace
  and proname in ('delete_llm_key','update_llm_key','pause_pool_key','resume_pool_key',
                  'create_contribution','pause_contribution','resume_contribution',
                  'withdraw_contribution','withdraw_contributions_by_key')
order by proname;
-- 期望：9 行

-- (D) PUBLIC/anon 不应持有任何 owner RPC 的 execute
select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') as allowed
from pg_proc p, pg_roles r
where p.pronamespace='public'::regnamespace
  and p.proname in ('delete_llm_key','update_llm_key','pause_pool_key','resume_pool_key',
                    'create_contribution','pause_contribution','resume_contribution',
                    'withdraw_contribution','withdraw_contributions_by_key',
                    'create_llm_key','reveal_llm_key','reveal_pool_key',
                    'create_pool_key','reset_pool_key',
                    'pool_stats','my_usage_stats','get_my_contributed_tokens')
  and r.rolname in ('anon','authenticated','service_role','public')
order by p.proname, r.rolname;
-- 期望：owner RPC (delete_llm_key / update_llm_key / *_pool_key / *_contribution) 仅 authenticated=true；
--       reveal_llm_key_service / update_usage_counters / adjust_points 仅 service_role=true；anon 全 false

-- (E) llm_keys 客户端直接 PATCH 应被拒（用 anon JWT）
-- 预期：permission denied for table llm_keys
```

**风险与回滚**：
- ⚠️ 已有的 `anon` JWT 客户端会在初始 SELECT 时 RLS 过滤仅 owner 行 → 这是预期
- ⚠️ 如果迁移前 service_role 写了脏数据（如 `used_today` 异常），收紧后业务读数不变；reset-daily 仍能清零
- ⚠️ 浏览器必须硬刷（Ctrl+Shift+R）以避免 304 缓存命中旧 frontend JS
- ⚠️ **回滚**：在 Dashboard 执行：
  ```sql
  create policy owner_all on public.llm_keys for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
  create policy owner_all on public.pool_keys for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
  create policy owner_all on public.pool_contributions for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
  ```
  （v5.1 不主动 drop 这些策略以外的 owner_select；上线后旧 owner_all 已被 v5.1 自动 drop，无需手动 rollback）

### 3.2 nginx：原位替换现有 sharetoken 站点（必须）
**主会话权限**：`/etc/nginx` + `systemctl reload nginx`
**策略**：优先**原位替换** `/etc/nginx/sites-available/YOUR-DOMAIN` + 保留现有 `/etc/nginx/sites-enabled/YOUR-DOMAIN` symlink + 现网证书路径不动。这样：
  - 不会出现“同时启用旧 sharetoken 站点 + 新 tokenpool 站点”的重复 server block / listen 19876 ssl 冲突
  - 公网域名 `https://YOUR-DOMAIN:19876` 不变（curl / DNS 缓存不需要重新拉）
  - 回滚只需 `cp` 回 .bak 文件

**操作**：
```bash
# 1. 验证 public 目录 world-readable
ls -ld /root/project/llm-key-manager/public   # 应 755 root:root
chmod 755 /root/project/llm-key-manager/public

# 2. 验证证书文件存在（已存在）
ls -l /etc/nginx/ssl/fullchain.pem /etc/nginx/ssl/privkey.pem
# privkey 应为 600 root:root

# 3. 备份现有 sharetoken 站点 + 原位替换为 tokenpool server block
sudo cp /etc/nginx/sites-available/YOUR-DOMAIN \
        /etc/nginx/sites-available/YOUR-DOMAIN.bak.$(date +%s)
sudo cp /root/project/llm-key-manager/deploy/nginx-tokenpool.conf \
        /etc/nginx/sites-available/YOUR-DOMAIN
# ⚠️ 不创建新的 sites-available/tokenpool，避免双 server block 监听 19876 ssl
#    现网 symlink /etc/nginx/sites-enabled/YOUR-DOMAIN 指向的 available 文件被原位覆盖，
#    不需要动 sites-enabled/，reload nginx 后直接生效。

# 4. 验证 symlink 仍指向被覆盖的 available
ls -l /etc/nginx/sites-enabled/YOUR-DOMAIN
# 应仍指向 /etc/nginx/sites-available/YOUR-DOMAIN（已被覆盖）

# 5. 校验语法（绝不要跳过）
sudo /usr/sbin/nginx -t

# 6. 重新加载（不重启整个 nginx）
sudo nginx -s reload    # 或 sudo systemctl reload nginx
```

**子代理独立测试（实际跑过）**：
```bash
# 构造临时 server block 做语法检查（已通过）
cat > /tmp/test-nginx.conf <<EOF
events {}
http {
    include /root/project/llm-key-manager/deploy/nginx-tokenpool.conf;
}
EOF
/usr/sbin/nginx -t -c /tmp/test-nginx.conf -p /root/project/llm-key-manager
# 退出码 0；无报错
```

**风险**：
- ⚠️ **不再推荐** 新增 sites-available/tokenpool + 双站共存（19876 端口被占用风险 + DNS / 客户端证书 SNI 转换体验）
- ⚠️ 回滚路径：sudo cp sites-available/YOUR-DOMAIN.bak.<ts> sites-available/YOUR-DOMAIN && sudo nginx -s reload
- ⚠️ `client_max_body_size 1m` 限制上传：聊天接口 body < 1m 没问题；如果未来支持文件上传需调
- ⚠️ 首次发布后用客户端验证 CSP 是否阻挡 Turnstile / Google OAuth；若发现阻拦，按 `add_header Content-Security-Policy` 同步追加域名
- ⚠️ 取消 SPA fallback 后：客户端硬刷任意 `/foo` 路径将得到 404（不是 index.html 200）；前端 hash 路由不受影响

### 3.3 cron：替换 BOM 文件（必须）
**主会话权限**：`/etc/cron.d/`
**操作**：
```bash
# 1. 备份旧文件（即便已知是 BOM）
sudo cp /etc/cron.d/tokenpool-reset /etc/cron.d/tokenpool-reset.bom-ba.$(date +%s) 2>/dev/null || true

# 2. 拷贝无 BOM 版本
sudo cp /root/project/llm-key-manager/deploy/tokenpool-reset.cron /etc/cron.d/tokenpool-reset
sudo chown root:root /etc/cron.d/tokenpool-reset
sudo chmod 644 /etc/cron.d/tokenpool-reset

# 3. 验证
head -c 3 /etc/cron.d/tokenpool-reset | od -An -c | head -1
# 必须不是 "357 273 277"

# 4. 验证 cron 加载
systemctl status cron
grep -i CRON /var/log/syslog | tail -5   # Ubuntu/Debian
# 或 systemctl status cron

# 5. 第一次执行前手动跑一次脚本验证
sudo /usr/bin/node /root/project/llm-key-manager/scripts/reset-daily.mjs
echo "exit=$?"
tail -20 /var/log/tokenpool-reset.log
```

**风险**：
- ⚠️ cron 必须看到 644 权限文件属主正确，否则会被忽略
- ⚠️ `CRON_TZ=Asia/Shanghai` 必须存在；否则按主机 UTC 跑
- ⚠️ `flock` 锁定文件 `/var/run/tokenpool-reset.lock` 需保证目录可写

### 3.4 网关：当前进程是旧版本（必须重启）
**主会话权限**：systemd / supervisor
**风险**：当前运行中的 `gateway.mjs` 是 08-11 11:43 启动的旧版（v2），磁盘上是新版 v3 — 用户在记忆 #6 中已标注为上线阻断。
**操作**：
```bash
# 通过 systemd:
sudo systemctl restart tokenpool-gateway
# 或 pm2 / supervisor 对应命令;主会话按实际部署使用
```

**风险**：
- ⚠️ 网关重启期间所有 `/v1/chat/completions` 调用会被断开；按业务时段（业务低峰）执行
- ⚠️ 重启后 healthcheck 30 秒内会触发 healthcheck-alert 一次冷启动告警；属预期

### 3.5 数据库：每日重置首次落地（必须）
**建议**：在 03.1 之后、03.4 之前，手动跑一次 reset-daily 让基线对齐：
```bash
sudo /usr/bin/node /root/project/llm-key-manager/scripts/reset-daily.mjs
# 期望：JSON 4-5 行（含 start + 3 个 PATCH 完成 + done），exit=0
```

### 3.6 Supabase Auth Turnstile / CAPTCHA 配置（必须人工操作）
**重要**：本子代理未修改任何远端配置；以下必须主会话在 Supabase Dashboard 操作完成。
**前提**：前端 v5.2 已传 `options.captchaToken` 给 `signInWithOtp` / `verifyOtp`；但这需要 Supabase Auth 原生启用 Cloudflare Turnstile 才会强制校验 CAPTCHA token，否则 token 被忽略。

**必需操作**（必须）：
1. 登录 Supabase Dashboard → Project `YOUR-PROJECT`
2. **Authentication** → **Sign In / Up** → **Security** → 启用 **Bot Abuse Prevention (CAPTCHA)**
3. Provider 选择 **Cloudflare Turnstile**；填入：
   - Site Key：`TURNSTILE_SITEKEY`（与前端 `public/index.html` 中常量 `TURNSTILE_SITEKEY` 一致）
   - Secret Key：填入（**仅供 Supabase Auth 内部消费**；前端不会调用 Cloudflare 验证，**网关也不读该 env**）
4. **保存**

**验证步骤**（必走）：
```bash
# 在 Supabase Dashboard SQL Editor：
select captcha_enabled from auth.config();
# 期望：true（如未启用则该 SQL 返回列不存在的报错或 false）
# 注：2026-08-12 验证：Auth settings 公开响应不返回 captcha_enabled/provider 字段；
#     主会话需手动到 Dashboard 确认已勾选，未勾选等于未生效。
```

**风险与限制**：
- ❌ **未启用原生 CAPTCHA 时不得声称防刷闭环**：前端传 captchaToken 仅供 Supabase Auth 消费；未启用 = token 被忽略 = 任何匿名可发 OTP
- ⚠️ **不再预验证 Turnstile token**：Cloudflare 官方文档明确 token `single-use` 且 TTL 300s；同一个 token 多次提交（前端预验后再交 Auth）会被 Cloudflare 直接拒绝。v5.4 删除 `/v1/verify-turnstile` 端点；前端 `signInWithOtp` / `verifyOtp` / `signInWithPassword` / `resetPasswordForEmail` / `resendOtp` 每次调用后都 `resetTurnstile()`（清 token + widget.reset），下次必须重新交互
- ⚠️ 一旦 Supabase Auth 启用 CAPTCHA 后，**匿名调用 signInWithOtp 缺少 captchaToken 必须报 400**；前端未传 token 时用户会被拒；补送 token 即可恢复
- ⚠️ Cloudflare Turnstile 密钥泄露需轮换；建议主会话记录在 `.env` 并 gitignore（当前已 gitignore）

## 4. 不在范围内（明确说明）

- ❌ 邮件/通知/Bark 推送 — 未触碰
- ❌ systemd unit 文件 — 未触碰
- ❌ 调度器（cron / systemd-timer）除建议替换 `/etc/cron.d/tokenpool-reset` 外
- ❌ 任何外部消息推送 / 邮件 / Bark
- ❌ 任何数据库写操作（实际执行）
- ❌ **未修改 Supabase 远端 Auth 配置**（Turnstile / CAPTCHA 必须主会话按 §3.6 操作）
- ❌ **未验证 Supabase Auth 是否已启用 CAPTCHA**（无 psql 直连权限；Auth settings 公开响应不返回 captcha_enabled 字段）
- ❌ `index.html.orig` — 显式不动
- ❌ `/tmp` — 未删除
- ❌ 根目录 `index/index.html` / `supabase-js.js` — 保留作为开发参考副本
- ❌ healthcheck-alert.mjs — 该脚本只探测 `127.0.0.1:20140`（本地网关）+ `SB_URL/rest/v1`（Supabase），不请求用户任意 base_url；本次未改

## 5. 重要兼容性提示

### 5.1 RLS 三表客户端写全部失效
- 旧前端：直接 `UPDATE pool_keys / pool_contributions / llm_keys`
- 新前端：所有写操作必须走 RPC
- **风险**：浏览器开发者工具手改客户端 → 403 → 引导用户硬刷

### 5.2 `delete_llm_key` RPC 是 delKey 的唯一入口
- 旧：两步直写（先调 `withdraw_contributions_by_key`，再 `UPDATE llm_keys SET deleted_at = now()`）
- 新：单次 `delete_llm_key(p_id)` RPC，事务内完成 withdraw + soft-delete
- **风险**：旧两步流程在 RLS 收紧后会 403（`llm_keys` 写策略已撤销）

### 5.3 pool_keys 表无 updated_at 列
- 修复 v5 中 pause/resume_pool_key 错误引用 `updated_at = now()` 已移除
- **风险**：若有人手动 `alter table pool_keys add column updated_at timestamptz`，需同步修改 v5.1 暂停更新此列（防止未来再次出错）

### 5.4 浏览器硬刷
- 任何 401/403 出现时，引导用户 `Ctrl+Shift+R`（Mac: `Cmd+Shift+R`）
- nginx 配置已对 `index.html` 设 `Cache-Control: no-cache, no-store, must-revalidate`

### 5.5 已知信任链
- Turnstile 由 **Supabase Auth 原生消费**（Dashboard 启用 CAPTCHA 后由 Auth 内部转发到 Cloudflare siteverify；前端 / 网关均不调用 Cloudflare 验证接口）
- Anthropic / OpenAI / Gemini 等 provider 仅作 `provider_key` 标记；不在公共池开放
- 当前 `allowed_models` 仅 `minimax` / `deepseek` 启用（v4.6 起）

## 6. 验证清单（上线后 30 分钟内必做）

1. 浏览器访问 `https://YOUR-DOMAIN:19876/` → 看到登录页
2. 浏览器开发者工具 → Network → 第一个 GET `index.html` 必须 200 + `Content-Type: text/html`
3. 浏览器开发者工具 → Application → Service Workers / Cache Storage 清空
4. 网络抓包：浏览器访问 `https://YOUR-DOMAIN:19876/gateway.mjs` 必须 404（nginx 拒绝）
5. 网络抓包：浏览器访问 `https://YOUR-DOMAIN:19876/.env` 必须 404
6. 网络抓包：浏览器访问 `https://YOUR-DOMAIN:19876/foo` 必须 404（无 SPA fallback）
7. 网络抓包：停掉本地网关 → 浏览器访问 `https://YOUR-DOMAIN:19876/v1/models` 必须返回 JSON 502（不是 HTML）
8. Network → 注册流程不会命中 `/v1/verify-turnstile`（端点已移除）；所有 Turnstile 验证由 Supabase Auth 内部完成
9. 浏览器控制台 → `await (await fetch('/v1/models')).json()` 命中 200
10. Tab 键聚焦第一个 Tab → 按 ArrowRight 切换焦点与激活面板
11. 邮件点击重置密码链接 → 浏览器跳转 → 自动弹出站内 modal 输入新密码
12. `/etc/cron.d/tokenpool-reset` 第一次执行后看 `/var/log/tokenpool-reset.log`
13. `bark` 通知 — 主动停服测试 alert 链路

## 7. v5.2 残余风险（明确说明）

### 7.1 SSRF defense-in-depth 残余
- ✅ DB trigger + RPC 要求 base_url scheme=https + 无 userinfo/query/hash
- ✅ 网关选路时再次硬校验 https + 拒 localhost/私网/link-local + 命中白名单
- ⚠️ **DNS rebinding**：单次 fetch 内 hostname resolve 后 IP 可能变；Node `fetch` / `lookup` 默认 follow 系统 DNS，攻击者可注册短 TTL 域名让首次解析过但二次解析到 127.0.0.1
  - 主会话可考虑在 nginx resolver 用 `valid=30s` + 网关去 `lookup` / 锁定 IP（代码修改量较大；本次未动）
- ⚠️ **白名单缓存窗口**：`getAllowedHosts` 30s 缓存；运营在 Supabase Dashboard 启用/禁用 provider 后最长 30s 网关才生效
- ⚠️ **白名单拉取失败 fail-closed**：白名单拉不到时所有 upstream 拒绝（返 502）；不会走未知主机，但可能误伤正在使用的 provider
- ⚠️ **`validateUpstreamBaseUrl` 不依赖白名单也能拦截非 https / localhost / 私网**；仅白名单 hostname match 需要 DB 查

### 7.2 Turnstile 防刷残余
- ❌ **未启用 Supabase Auth 原生 CAPTCHA 时不能声称防刷闭环**：前端传 captchaToken 仅作为标识，Supabase Auth 不会强制校验
- ❌ **Auth settings 公开响应未返回 captcha_enabled/provider 字段**：本子代理无法据此证明已启用；主会话必须在 Dashboard 视觉确认
- ⚠️ Cloudflare Turnstile 密钥泄露需轮换；若同密钥被滥用 Cloudflare 会限流并告知
- ⚠️ Turnstile token `single-use` 300s：每次 Supabase Auth 调用（signInWithOtp / verifyOtp / signInWithPassword / resetPasswordForEmail / resendOtp）都消耗一个 token；前端 `resetTurnstile()` 在调用后强制清空并 widget.reset；下次必须重新交互；resetPasswordForEmail 需独立 Turnstile challenge（不能复用主登录 token）

### 7.3 update_llm_key 自动撤回贡献
- ⚠️ base_url 实际变更（protocol 或 host 不同）→ 原子撤回该 Key 未撤回贡献
- ⚠️ 积分账本 + usage_events 不受影响（withdrawn 不物理删）
- ⚠️ 前端 saveKey 接收到 wdN>0 时 toast `'已更新，N 条贡献已撤回（地址变更）'`，用户需重新创建贡献
- ⚠️ **不会出现误撤回**：只有 base_url 真正改变时才触发；同 URL 重新保存（user 重新输入空格等）会被规范化后跳过撤回
### 7.4 Base URL 契约（v5.4 统一）
| 层 | 行为 |
|---|---|
| 前端 `saveKey` / `addKey` | `normalize` 后发 `https://host/v1`；查询串 / hash / userinfo / 非 443 端口 / 深路径均在 `validateUpstreamBaseUrl` 被拒 |
| SQL `update_llm_key` | 同 `validateUpstreamBaseUrl`；`?` / `#` / `@` / `:`-非-443 端口 / `/v1/chat` 等深路径拒绝；尾部斜杠规范化后仅是 path 字段尾空格处理，不触发撤回 |
| SQL `check_contrib_model` | 触发器层同样：host 必须命中 enabled `allowed_models.allowed_hosts` 且 base_url scheme=`https` |
| SQL `resume_contribution` | 同触发器 |
| 网关 `validateUpstreamBaseUrl` | 保留 path（避免丢 `/v1`）；拼接 `baseUrl.replace(/\/+$/,'') + '/chat/completions'`；同样拒 http / userinfo / query / hash / 非默认端口 / localhost / 私网 / link-local |
| 网关 `getAllowedHosts` | 30s 缓存 enabled `allowed_models.allowed_hosts`；拉取失败返回 `null` → fail-closed → 该上游拒绝（不再走未知主机） |
| healthcheck `parseSafeBaseUrl` | 白名单内 host 也只允许 https；`/v1` 保留；深路径（≥ 2 段）跳过探测；明文探测路径已彻底删除 |

**生产现网两把有效 key 的 base_url**：
- `https://api.minimaxi.com/v1`
- `https://api.deepseek.com/v1`

### 7.5 请求生命周期（v5.4 网关契约）
- `req.on('aborted')` 触发 → 标记 `clientClosed` + abort `clientAbortController` + 释放并发槽
- `res.on('close')` 触发（响应未结束前客户端断开）→ 同上
- 正常 POST body 读取完成（`req.on('end')` 隐式）→ **不会**触发 `aborted`，仅 `res.on('close')` 在 res.end() 后正常触发（此时 `res.writableEnded === true`，被 `markClientClosed` 早退，不会重复 release）
- `releaseConcurrency` exactly-once：`concurrentAcquired` flag 防止重入；`rateLimitEnd()` 配套只调一次
- 上游 fetch 270s 超时（`AbortController` + `setTimeout`，每次 attempt 独立 timer）；客户端 abort 也走同一 `clientAbortController.signal`；abort 后抛 `err.code = 'CLIENT_CLOSED'`
- 上游响应消费（headers + body drain）受单一 deadline 控制：`upstreamFetchAndConsume()` 内部自适应 timer；SSE reader 在 client 断开 / 超时时 `reader.cancel()` 释放上游连接；并发槽释放位置：响应结束之后、`recordUsage` 之前（避免 DB 写期间占住全局并发）

### 7.6 ACL 自检 PUBLIC 伪角色（v5.4 修复）
- **问题**：原 ACL 自检用 `pg_roles.rolname in ('anon','PUBLIC')` 查 PUBLIC 是否有 EXECUTE，但 PUBLIC 是伪角色（OID=0），**不在** `pg_roles` 表，旧查询永远不匹配 → 默认 PUBLIC EXECUTE 被漏验
- **修复**：用 `aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))` 拆解函数 ACL，逐条检查 `acl.grantee = 0` (PUBLIC OID) 是否含 `EXECUTE`；anon / authenticated 仍走 `pg_roles.oid` 单独查
- **补充**：补验 owner RPC 的 authenticated EXECUTE 已授予（避免错 revoke 后还以为已授）；service_role RPC 的 authenticated EXECUTE 已拒绝
- **验证**：以上 4 项检查若任一项未达期望，脚本 `raise exception 'ACL self-check failed: % violations'` 终止，主会话会在 NOTICE 里看到违例详情（哪个函数、哪个角色）

## 8. 回归验证记录（v5.4）

### 8.1 自动回归测试（`scripts/test-gateway-baseurl.mjs`）
- A. `validateUpstreamBaseUrl` 19 用例：保留 `/v1`、拒绝 http/userinfo/query/hash/非默认端口/localhost/私网/link-local/internal-tld/深路径
- B. `upstreamFetchWithTimeout` 2 用例：预先 abort + 中途 abort 都正确抛 `CLIENT_CLOSED`
- C. HTTP 生命周期 2 用例：完整 POST 200 + body 完整收到；客户端 abort → 服务端 `req.on('aborted')` 触发
- D. `releaseConcurrency` exactly-once 1 用例：3 次调用仅 1 次 release
- 全部 24/24 通过

### 8.2 PostgreSQL 16 隔离（`postgres:16-alpine` 容器）
- `schema-phase2.sql` + `fix-v3.sql` (v4.7) + `fix-v5-rls-tightening.sql` (v5.4) 首次升级 ✅
- 第二次运行 `fix-v5-rls-tightening.sql` 幂等 ✅
- 5 条 NOTICE：`RLS enabled`、`owner_select=3`、`anon/PUBLIC denied`、`9 owner RPCs`、`no client write policies`

### 8.3 update_llm_key 路径变体（PG16 实测）
- ✅ 尾部斜杠 `https://x.com/v1/` → 返回 0（不触发撤回）
- ✅ `v1 → v2` 实际变更 → 返回 1（撤回活跃贡献）
- ✅ 深路径 `/v1/chat` → 拒绝 `deep-path`
- ✅ `http://` → 拒绝（无贡献时 silent ok，有贡献时 `must be https`）
- ✅ `https://user:***@evil.com` → 拒绝 `userinfo`
- ✅ `https://x.com/v1?key=***` → 拒绝 `query`（不静默剥）
- ✅ `https://x.com/v1#frag` → 拒绝 `hash`（不静默剥）
- ✅ `https://evil.com/v1`（无白名单）→ 拒绝 `host not in enabled allowed_models`

### 8.4 静态确认
- `public/index.html`：5 段 inline script `node --check` 逐段 + 合并通过
- `gateway.mjs` / `healthcheck.mjs` / `healthcheck-alert.mjs` / `scripts/reset-daily.mjs` / `scripts/test-gateway-baseurl.mjs`：`node --check` 通过
- `grep -n 'verify-turnstile' public/index.html gateway.mjs` → 无匹配（前端预验端点已删）
- `grep -n 'TURNSTILE_SECRET' gateway.mjs` → 无匹配（网关不再读 env）
- nginx 隔离 `nginx -t` 通过
- `git diff --check` 无 whitespace 错误

## 9. 仍需主会话人工 / 运行态执行项

1. ❗ **Supabase Dashboard → Authentication → Sign In / Up → Security**：启用 **Bot Abuse Prevention (CAPTCHA)**；Provider 选 **Cloudflare Turnstile**；填 sitekey + secret。SQL `select captcha_enabled from auth.config()` 无法可靠返回，**必须视觉确认 Dashboard 已勾选**；未勾选 = token 被忽略 = 任何匿名可发 OTP
2. ❗ **生产 nginx 实际 reload**：本子代理在隔离 sandbox 验证 `nginx -t`，未触生产 `systemctl reload nginx`
3. ❗ **生产 PostgreSQL 实际执行 SQL**：在 Supabase Dashboard SQL Editor 粘贴 `db/fix-v5-rls-tightening.sql`，观察 5 条 NOTICE 全部 `OK`
4. ❗ **生产 service restart / 浏览器硬刷**：网关重启 + `Ctrl+Shift+R` 后生效（前端 Turnstile widget 也需重渲染）
5. ❗ **DNS rebinding**（§7.1 残余）：生产可考虑 nginx resolver `valid=30s` + 网关锁定 IP；本子代理未动
