-- ============================================================
-- TokenPool 修复脚本 v3 - 2026-08-10
-- 执行位置：Supabase Dashboard > SQL Editor（直接全选粘贴执行）
-- 内容：
--   1. reveal_llm_key 重构：仅本人可 reveal（修复匿名泄露任意 key 明文）
--   2. 新增 reveal_llm_key_service：仅 service_role 可调（网关/健康检查用）
--   3. create_llm_key 重写：前端 4 参签名 + pgp 加密 + 20 上限
--   4. update_llm_key 重写：owner 校验 + 可选重加密
--   5. pool_stats RPC：公共池聚合统计（替代匿名全行读取）
--   6. RLS 收紧：撤销 pool_contributions 的匿名读策略
--   7. pool_keys 唯一约束：全量唯一 → active-only 唯一
-- 执行后必须重启网关（systemd 服务已由脚本自动处理）
-- ============================================================

-- ---------- 1+2. reveal 函数重构 ----------
-- 注意：pgcrypto 扩展安装在 extensions schema（Supabase 默认），
-- 所有 security definer 函数必须 set search_path = public, extensions，否则 pgp_* 找不到
-- 删除旧版本（签名不兼容，先删后建）
drop function if exists public.reveal_llm_key;

-- 前端版：仅本人可 reveal 自己的 key
create or replace function public.reveal_llm_key(p_key_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_enc bytea; v_fk text; v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select api_key_enc into v_enc from public.llm_keys where id=p_key_id and user_id=v_uid;
  if v_enc is null then raise exception 'not found or forbidden'; end if;
  select value into v_fk from public.app_config where key='field_key';
  return pgp_sym_decrypt(v_enc, v_fk);
end $$;

-- 网关版：校验 JWT role=service_role 才放行（网关/healthcheck 用）
create or replace function public.reveal_llm_key_service(p_key_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_enc bytea; v_fk text; v_role text;
begin
  v_role := coalesce(current_setting('request.jwt.claims', true)::json->>'role', '');
  if v_role <> 'service_role' then raise exception 'forbidden: service_role only'; end if;
  select api_key_enc into v_enc from public.llm_keys where id=p_key_id;
  if v_enc is null then raise exception 'not found'; end if;
  select value into v_fk from public.app_config where key='field_key';
  return pgp_sym_decrypt(v_enc, v_fk);
end $$;

-- 权限收紧：⚠️ 必须 revoke public（默认 PUBLIC 有 execute，revoke anon 无效，anon 是 PUBLIC 成员）
-- Supabase 自动给新函数授予 anon/authenticated/service_role，需逐个 revoke anon 后再 grant 给需要的角色
revoke execute on function public.reveal_llm_key(uuid) from public, anon;
revoke execute on function public.reveal_llm_key_service(uuid) from public, anon, authenticated;
grant execute on function public.reveal_llm_key(uuid) to authenticated;
grant execute on function public.reveal_llm_key_service(uuid) to service_role;

-- ---------- 3. create_llm_key 重写 ----------
drop function if exists public.create_llm_key;

create or replace function public.create_llm_key(
  p_provider text, p_base_url text, p_api_key text, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_count integer; v_uid uuid; v_fk text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select count(*) into v_count from public.llm_keys where user_id = v_uid;
  if v_count >= 20 then raise exception 'Key limit reached: maximum 20 keys per user'; end if;
  select value into v_fk from public.app_config where key='field_key';
  insert into public.llm_keys (user_id, provider, base_url, api_key_enc, key_preview, note)
  values (v_uid, p_provider, p_base_url,
          pgp_sym_encrypt(p_api_key, v_fk),
          case when length(p_api_key) > 8 then left(p_api_key,4)||'...'||right(p_api_key,4) else '****' end,
          p_note)
  returning id into v_id;
  return v_id;
end $$;

-- ---------- 4. update_llm_key 重写 ----------
drop function if exists public.update_llm_key;

create or replace function public.update_llm_key(
  p_id uuid, p_provider text, p_base_url text, p_api_key text default null, p_note text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid; v_fk text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.llm_keys where id=p_id and user_id=v_uid) then
    raise exception 'not found or not owner';
  end if;
  update public.llm_keys set
    provider = coalesce(p_provider, provider),
    base_url = coalesce(p_base_url, base_url),
    note = coalesce(p_note, note)
  where id = p_id;
  if p_api_key is not null and p_api_key <> '' then
    select value into v_fk from public.app_config where key='field_key';
    update public.llm_keys set
      api_key_enc = pgp_sym_encrypt(p_api_key, v_fk),
      key_preview = case when length(p_api_key) > 8 then left(p_api_key,4)||'...'||right(p_api_key,4) else '****' end
    where id = p_id;
  end if;
end $$;

-- ---------- 5. pool_stats RPC ----------
create or replace function public.pool_stats()
returns table (total_cap_tokens bigint, used_today bigint, total_used_tokens bigint, contributor_count bigint)
language sql security definer set search_path = public as $$
  select coalesce(sum(daily_cap_tokens),0)::bigint,
         coalesce(sum(used_today),0)::bigint,
         coalesce(sum(total_used_tokens),0)::bigint,
         count(distinct user_id)::bigint
  from public.pool_contributions where status='active';
$$;
-- 权限：revoke public/anon，仅 authenticated 可调
revoke execute on function public.pool_stats() from public, anon;
grant execute on function public.pool_stats() to authenticated;

-- ---------- 6. RLS 收紧 ----------
-- 撤销匿名/登录用户对贡献表全行的公开读（owner_all 保留，用户只看自己的）
drop policy if exists public_read_active on public.pool_contributions;

-- ---------- 7. pool_keys 约束修正 ----------
-- 全量唯一 → active-only 唯一（停用后可重新生成，不影响“每用户一把在用 key”）
drop index if exists pool_keys_one_per_user;
create unique index if not exists pool_keys_one_per_user_active
  on public.pool_keys (user_id) where status = 'active';

-- ---------- 完成提示 ----------
select 'TokenPool fix v3 applied OK' as status;

-- ============================================================
-- v3.1 补充（2026-08-10 19:20）：平台 Key 可随时查看
-- 背景：原设计只存 sha256 hash，明文仅展示一次不可恢复。
-- 改为：pool_keys 增加 key_enc 加密列，新生成的 Key 可随时 reveal。
-- 旧 Key（无 key_enc）无法恢复明文，提示重置即可。
-- ============================================================

-- 加密列
alter table public.pool_keys add column if not exists key_enc bytea;

-- 生成：前端传明文，服务端算 hash + pgp 加密（authenticated only）
create or replace function public.create_pool_key(p_plain text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_uid uuid; v_fk text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_plain is null or length(p_plain) < 10 then raise exception 'invalid key'; end if;
  select value into v_fk from public.app_config where key='field_key';
  insert into public.pool_keys (user_id, key_hash, key_enc, label)
  values (v_uid, encode(digest(p_plain, 'sha256'), 'hex'), pgp_sym_encrypt(p_plain, v_fk), '默认')
  returning id into v_id;
  return v_id;
end $$;

-- 查看：owner 校验 + 解密（authenticated only）
create or replace function public.reveal_pool_key(p_key_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_enc bytea; v_fk text; v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select key_enc into v_enc from public.pool_keys where id=p_key_id and user_id=v_uid;
  if v_enc is null then raise exception 'not found or not stored'; end if;
  select value into v_fk from public.app_config where key='field_key';
  return pgp_sym_decrypt(v_enc, v_fk);
end $$;

-- 权限
revoke execute on function public.create_pool_key(text) from public, anon;
revoke execute on function public.reveal_pool_key(uuid) from public, anon;
grant execute on function public.create_pool_key(text) to authenticated;
grant execute on function public.reveal_pool_key(uuid) to authenticated;

-- ============================================================
-- v3.2 补充（2026-08-10 19:31）：我的用量看板
-- 前端「用量」tab 调 my_usage_stats()，返回调用次数/token/模型分布/最近记录
-- ============================================================
create or replace function public.my_usage_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select jsonb_build_object(
    'total_calls', count(*) filter (where u.status='success'),
    'total_tokens', coalesce(sum(u.total_tokens) filter (where u.status='success'), 0),
    'prompt_tokens', coalesce(sum(u.prompt_tokens) filter (where u.status='success'), 0),
    'completion_tokens', coalesce(sum(u.completion_tokens) filter (where u.status='success'), 0),
    'by_model', coalesce((
      select jsonb_agg(jsonb_build_object('model', x.model, 'calls', x.calls, 'tokens', x.tokens) order by x.tokens desc)
      from (select u2.model, count(*) calls, sum(u2.total_tokens) tokens
            from usage_events u2 where u2.pool_key_id in (select id from pool_keys where user_id=v_uid) and u2.status='success'
            group by u2.model) x), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('model', model, 'total_tokens', total_tokens, 'status', status, 'created_at', created_at) order by created_at desc)
      from (select model, total_tokens, status, created_at from usage_events
            where pool_key_id in (select id from pool_keys where user_id=v_uid)
            order by created_at desc limit 10) t), '[]'::jsonb)
  ) into v
  from usage_events u
  where u.pool_key_id in (select id from pool_keys where user_id=v_uid);
  return v;
end $$;
revoke execute on function public.my_usage_stats() from public, anon;
grant execute on function public.my_usage_stats() to authenticated;

-- ============================================================
-- v3.3 补充（2026-08-10 19:33）：pool_stats 统计口径修正
-- 问题：所有指标只统计 status='active'，贡献撤回后当日/历史消耗消失
-- 修正：理论日额度/贡献者数只看 active；当日消耗/历史总消耗统计全部贡献（含 withdrawn）
-- ============================================================
create or replace function public.pool_stats()
returns table (total_cap_tokens bigint, used_today bigint, total_used_tokens bigint, contributor_count bigint)
language sql security definer set search_path = public as $$
  select
    (select coalesce(sum(daily_cap_tokens),0)::bigint from public.pool_contributions where status='active'),
    (select coalesce(sum(used_today),0)::bigint from public.pool_contributions),
    (select coalesce(sum(total_used_tokens),0)::bigint from public.pool_contributions),
    (select count(distinct user_id)::bigint from public.pool_contributions where status='active');
$$;

-- ============================================================
-- v3.4 经济体系重构（2026-08-10 19:45，Leo 拍板）
-- 原则：大部分用户 L1 基础调用；升级只靠累计贡献；自刷一定亏（兑换汇率兜底）
-- 1) 等级门槛改为「累计贡献 token」：L2 1亿 / L3 10亿 / L4 100亿
-- 2) 汇率缩放 100 倍：1 积分 = 10 万 MiniMax token（数值感）
-- 3) self-use 照常计分（兑换汇率保证自刷亏本），路由优先别人的贡献
-- 4) 每日积分上限取消（积分仅展示，后续开放兑换使用次数）
-- ============================================================
alter table public.usage_events add column if not exists is_self_use boolean not null default false;
alter table public.reward_tiers add column if not exists min_contributed_tokens bigint;
update public.reward_tiers set
  min_contributed_tokens = case level when 1 then 0 when 2 then 100000000 when 3 then 1000000000 when 4 then 10000000000 end,
  daily_quota = case level when 1 then 100000 when 2 then 300000 when 3 then 1000000 when 4 then 3000000 end,
  perks = jsonb_build_object('label', case level when 1 then '青铜' when 2 then '白银' when 3 then '黄金' when 4 then '钻石' end,
                             'rpm', case level when 1 then 60 when 2 then 120 when 3 then 300 when 4 then 600 end)
where level in (1,2,3,4);
update public.rate_rules set tokens_per_point = tokens_per_point / 100;
update public.reward_config set value='999999999', note='v3: 积分仅展示，不再设上限' where key='daily_points_cap';
update public.reward_config set value='1', note='v3.1: 自用照常计分，兑换汇率保证自刷亏本' where key='self_use_multiplier';
create or replace function public.get_my_contributed_tokens()
returns bigint language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  return (select coalesce(sum(u.total_tokens),0)::bigint from usage_events u
          where u.status = 'success'
            and u.contribution_id in (select id from pool_contributions where user_id = v_uid));
end $$;
revoke execute on function public.get_my_contributed_tokens() from public, anon;
grant execute on function public.get_my_contributed_tokens() to authenticated;

-- ============================================================
-- v3.5 全面复查修复（2026-08-10 20:00）
-- 1) 原子计数 RPC：修复并发请求下 used_today 等计数覆盖丢失（SQL 内自增）
-- 2) llm_keys 软删：删除 key 不再物理删（级联外键链会报错），deleted_at 标记
-- 3) create_llm_key 名额统计排除软删 key
-- 4) 网关 last_success_at 失败不再丢弃已成功响应（避免重复计费）
-- ============================================================
alter table public.llm_keys add column if not exists deleted_at timestamptz;

create or replace function public.update_usage_counters(p_pool_key_id uuid, p_contribution_id uuid, p_t bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_t is null or p_t < 0 then p_t := 0; end if;
  update public.pool_keys set used_today = used_today + p_t where id = p_pool_key_id;
  update public.pool_contributions set
    used_today = used_today + p_t,
    total_used_tokens = total_used_tokens + p_t,
    used_five_hour = case when five_hour_window_start is null or now() - five_hour_window_start > interval '5 hours'
                          then p_t else used_five_hour + p_t end,
    five_hour_window_start = case when five_hour_window_start is null or now() - five_hour_window_start > interval '5 hours'
                          then now() else five_hour_window_start end,
    updated_at = now()
  where id = p_contribution_id;
end $$;
revoke execute on function public.update_usage_counters(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.update_usage_counters(uuid,uuid,bigint) to service_role;

-- ============================================================
-- v3.6 根因修复: v2rayA 透明代理劫持 (2026-08-10 23:07)
-- 现象: 网关/healthcheck/Management API 间歇性 TCP 超时(15-30分钟自动恢复)
-- 误判: Cloudflare 黑洞 ✗ → 真实根因: v2rayA TPROXY 劫持本机出站 TCP
--   /etc/v2raya/v2raya.nft: nat hook output priority -105 redirect to :52345
--   Supabase(国外域名) → geosite:!cn → 130+节点 leastping 代理池 → 节点差则超时
-- 证据: ① ping 通但 TCP 超时(nft 只劫持 tcp) ② 仅国外域名受影响(geosite:cn 直连)
--       ③ v2raya 日志 [香港XX][ssr] dial supabase.co ④ Management API 握手超时
-- 修复(不动 v2rayA 配置): tpool-bypass.sh + systemd timer 每5分钟
--   在 mangle output priority -150 给 Supabase IP 打 mark 0x80
--   → v2raya tp_rule `meta mark & 0x80 == 0x80 return` 主动跳过 → 直连
-- 验证: 加载后 v2ray 日志无 supabase 记录; 请求 0.35-0.6s 稳定; Management API 0.5s
-- ============================================================

-- ============================================================
-- v4 积分经济（2026-08-11 09:45）
-- 1) 系数列：rate_rules.coefficient（模型价值比例，MiniMax=1.0；赚=token×系数，花=token×系数×2）
-- 2) 等级每日上限：L1 1000万 / L2 3000万 / L3 1亿 / L4 5亿 token
-- 3) user_points 余额表 + adjust_points 原子RPC（幂等：ref_usage_event_id+reason 复合唯一）
-- 4) 注册送 10万积分触发器（auth.users insert → signup_bonus）
-- 5) 网关：余额>0 才可调用；recordUsage 赚/花双记
-- ============================================================
alter table public.rate_rules add column if not exists coefficient numeric default 1.0;
update public.rate_rules set coefficient = case provider_key when 'minimax' then 1.0 when 'deepseek' then 0.9 when 'zhipu' then 3.4 when 'moonshot' then 2.1 when 'qwen' then 4.6 when 'openai' then 24.0 when 'anthropic' then 15.0 when 'doubao' then 1.0 when 'google' then 2.2 when 'mistral' then 5.5 when 'groq' then 0.1 when 'xai' then 5.5 when 'baidu' then 1.9 else 1.0 end;
insert into public.rate_rules (provider_key, model_pattern, tokens_per_point, enabled, coefficient, note) values ('siliconflow','siliconflow-%',100000,true,0.5,'中转聚合') on conflict do nothing;
update public.reward_tiers set daily_quota = case level when 1 then 10000000 when 2 then 30000000 when 3 then 100000000 when 4 then 500000000 else daily_quota end;
create table if not exists public.user_points (user_id uuid primary key references auth.users(id) on delete cascade, balance numeric not null default 0, updated_at timestamptz default now());
alter table public.user_points enable row level security;
create policy owner_read on public.user_points for select using (user_id = auth.uid());
drop index if exists points_ledger_ref_ueid_idx;
create unique index points_ledger_ref_ueid_reason_idx on public.points_ledger (ref_usage_event_id, reason) where ref_usage_event_id is not null;
create or replace function public.adjust_points(p_user_id uuid, p_delta numeric, p_reason text, p_ref uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.points_ledger (user_id, delta, reason, ref_usage_event_id, created_at)
  values (p_user_id, p_delta, p_reason, p_ref, now())
  on conflict do nothing
  returning id into v_id;
  if v_id is not null then
    insert into public.user_points (user_id, balance) values (p_user_id, p_delta)
    on conflict (user_id) do update set balance = user_points.balance + p_delta, updated_at = now();
  end if;
end $$;
revoke execute on function public.adjust_points(uuid,numeric,text,uuid) from public, anon, authenticated;
grant execute on function public.adjust_points(uuid,numeric,text,uuid) to service_role;
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_points (user_id, balance) values (new.id, 100000)
    on conflict (user_id) do nothing;
  insert into public.points_ledger (user_id, delta, reason, created_at)
    values (new.id, 100000, 'signup_bonus', now());
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ============================================================
-- v4.2 模型维度定价（2026-08-11 10:20）
-- 1) allowed_models 只启用 7 家：minimax/deepseek/zhipu/moonshot/qwen/openai/anthropic
-- 2) rate_rules 模型级精确行（10 个常规模型）+ 前缀兜底（新模型自动落档）
-- 3) 匹配算法：精确 > 最长前缀 > 默认 1.0（大小写不敏感）
-- ============================================================
update public.allowed_models set enabled = case provider_key when 'minimax' then true when 'deepseek' then true when 'zhipu' then true when 'moonshot' then true when 'qwen' then true when 'openai' then true when 'anthropic' then true else false end;
update public.rate_rules set enabled = case provider_key when 'minimax' then true when 'deepseek' then true when 'zhipu' then true when 'moonshot' then true when 'qwen' then true when 'openai' then true when 'anthropic' then true else false end;
update public.rate_rules set coefficient = 1.0 where provider_key='qwen' and model_pattern='qwen-%';
update public.rate_rules set coefficient = 12.0 where provider_key='anthropic' and model_pattern='claude-%';
insert into public.rate_rules (provider_key, model_pattern, tokens_per_point, enabled, coefficient, note) values
 ('minimax','MiniMax-M3',100000,true,1.0,'常规主力'),
 ('deepseek','DeepSeek-V4-Pro',100000,true,0.9,'常规主力'),
 ('deepseek','DeepSeek-V4-Flash',100000,true,0.3,'快速便宜'),
 ('zhipu','GLM-5',100000,true,3.4,'常规主力'),
 ('moonshot','Kimi-K2.5',100000,true,2.1,'常规主力'),
 ('qwen','Qwen-Plus',100000,true,1.0,'常规主力'),
 ('qwen','Qwen-Max',100000,true,4.6,'旗舰'),
 ('openai','GPT-5.5',100000,true,24.0,'常规主力'),
 ('anthropic','Claude-Opus-4',100000,true,20.6,'旗舰'),
 ('anthropic','Claude-Sonnet-4',100000,true,12.4,'常规')
on conflict do nothing;

-- ============================================================
-- v4.3 模型粒度贡献准入（2026-08-11 10:30）
-- 1) 触发器：贡献的 model_pattern 必须是 rate_rules enabled 精确行（禁 *、禁未定价模型）
-- 2) 前端：模型下拉选择（从 rate_rules 读）；同 Key 可贡献多个模型（同 Key 同模型查重）
-- 配置位置：
--   可加入平台 -> allowed_models (provider_key / allowed_hosts / enabled)
--   可加入模型 + 积分比例 -> rate_rules (provider_key / model_pattern / coefficient / enabled)
-- ============================================================
create or replace function public.check_contrib_model() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cnt integer;
begin
  if new.model_pattern is null or trim(new.model_pattern) in ('', '*') then
    raise exception 'model_pattern must be a specific model (model-level contribution only, no *)';
  end if;
  select count(*) into v_cnt from public.rate_rules
  where enabled = true
    and position('%' in model_pattern) = 0
    and position('*' in model_pattern) = 0
    and lower(model_pattern) = lower(new.model_pattern);
  if v_cnt = 0 then
    raise exception 'model % is not in the allowed contribution list (rate_rules.enabled exact rows)', new.model_pattern;
  end if;
  return new;
end $$;
drop trigger if exists contrib_model_check on public.pool_contributions;
create trigger contrib_model_check before insert or update of model_pattern, key_id on public.pool_contributions
for each row execute function public.check_contrib_model();

-- ============================================================
-- v4.4 贡献弹窗重设计（2026-08-11 10:35）
-- 1) 模型必选下拉（只能从 rate_rules 可入池模型选）
-- 2) 限制字段精简：每日上限 / 合计上限 / 到期时间（5小时字段 UI 移除，数据兼容保留）
-- 3) 自动撤回：网关选路时检测合计用满/过期 → 异步置 withdrawn（不阻塞）
-- 4) 列表展示：万/亿格式化 + 进度百分比 + 已用满标签
-- ============================================================

-- ============================================================
-- v4.5 上线前测试修复（2026-08-11 11:30）
-- 1) 唯一索引：idx_contrib_unique_key(key_id 单列) → (key_id, model_pattern) where status='active'
--    修复"同一 Key 贡献多个模型"被数据库挡死的问题
-- 2) rate_rules DeepSeek 精确行改上游真实名：DeepSeek-V4-Pro → deepseek-v4-pro、DeepSeek-V4-Flash → deepseek-v4-flash
-- 3) 网关 pickContribution 模型匹配改大小写不敏感（model.toLowerCase().startsWith）
-- 4) /v1/models 从"上游探测"改为"聚合 active 贡献 model_pattern"（与贡献列表一致）
-- ============================================================
drop index if exists public.idx_contrib_unique_key;
drop index if exists public.idx_contrib_unique_key_model;
create unique index idx_contrib_unique_key_model on public.pool_contributions(key_id, model_pattern) where status='active';

-- ============================================================
-- v4.6 上线后页面与状态机修复（2026-08-11 14:20）
-- 1) reset_pool_key：禁用旧 active + 创建新 key 同一事务，消除前端多请求竞态
-- 2) 贡献准入触发器同时校验 key 的官方 host 与模型 provider，防止跨平台模型误配
-- 3) 暂停未完成现网协议/模型 ID 核验的 5 家入池资格（Key 仍可作为自用 Key 保存）
-- 4) pool_stats 保留“已设置的日上限”口径；前端明确不含不限贡献，不伪装为理论容量
-- ============================================================
update public.allowed_models set enabled = (provider_key in ('minimax','deepseek'));
update public.rate_rules set enabled = false
where provider_key in ('zhipu','moonshot','qwen','openai','anthropic');

create or replace function public.reset_pool_key(p_plain text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_uid uuid; v_fk text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_plain is null or length(p_plain) < 10 then raise exception 'invalid key'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select value into v_fk from public.app_config where key='field_key';
  update public.pool_keys set status='disabled' where user_id=v_uid and status='active';
  insert into public.pool_keys (user_id, key_hash, key_enc, label, status)
  values (v_uid, encode(digest(p_plain, 'sha256'), 'hex'), pgp_sym_encrypt(p_plain, v_fk), '默认', 'active')
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.reset_pool_key(text) from public, anon;
grant execute on function public.reset_pool_key(text) to authenticated;

create or replace function public.check_contrib_model() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_provider text; v_cnt integer;
begin
  if new.model_pattern is null or trim(new.model_pattern) in ('', '*') then
    raise exception 'model_pattern must be a specific model (model-level contribution only, no *)';
  end if;
  select am.provider_key into v_provider
  from public.llm_keys k
  join public.allowed_models am on am.enabled = true
    and exists (
      select 1 from unnest(am.allowed_hosts) host
      where lower(host) = lower(split_part(split_part(k.base_url, '://', 2), '/', 1))
    )
  where k.id = new.key_id and k.user_id = new.user_id and k.deleted_at is null
  limit 1;
  if v_provider is null then raise exception 'key host is not in the enabled provider allowlist'; end if;
  select count(*) into v_cnt from public.rate_rules
  where enabled = true and provider_key = v_provider
    and position('%' in model_pattern) = 0 and position('*' in model_pattern) = 0
    and lower(model_pattern) = lower(new.model_pattern);
  if v_cnt = 0 then
    raise exception 'model % is not allowed for provider %', new.model_pattern, v_provider;
  end if;
  return new;
end $$;
drop trigger if exists contrib_model_check on public.pool_contributions;
create trigger contrib_model_check before insert or update of model_pattern, key_id on public.pool_contributions
for each row execute function public.check_contrib_model();

create or replace function public.check_contrib_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if new.status <> 'active' then return new; end if;
  select count(*) into v_count from public.pool_contributions
  where user_id = new.user_id and status = 'active' and id <> new.id;
  if v_count >= 5 then
    raise exception 'Contribution limit reached: maximum 5 active contributions per user';
  end if;
  return new;
end $$;
drop trigger if exists trg_contrib_limit on public.pool_contributions;
create trigger trg_contrib_limit before insert or update of status on public.pool_contributions
for each row execute function public.check_contrib_limit();

-- ============================================================
-- v4.7 贡献保存 / Key 名额 / 触发器健壮性（2026-08-11 18:20）
-- 1) pool_contributions.daily_cap_tokens 改为 nullable
--    原因：前端页面允许"每日上限留空"，INSERT 不传该字段会因 NOT NULL 失败。
--    兼容：已有非空行不受影响；新增可空；触发器/RPC 已用 coalesce 兜底。
-- 2) create_llm_key 名额统计排除软删 key（deleted_at is null）
--    原因：v3.5 引入软删后，delete + recreate 会因旧软删行被计数而拒绝。
-- 3) check_contrib_model 触发器健壮 owner 查询
--    原因：之前依赖 NEW.user_id 与 llm_keys.user_id 相等；若 NEW.user_id 未预填，
--    INSERT 在 with check(auth.uid()=user_id) 默认补齐之前进入触发器会失败。
--    修复：以 auth.uid() / llm_keys.user_id 为唯一真源，忽略 NEW.user_id 旧值。
-- 4) saveContrib 路径额外保护：可选 cap 列若 schema 允许空，插入时显式置 NULL；
--    同时允许 NEW.user_id 缺省（依赖列默认 auth.uid() 兜底）。
-- ============================================================

-- (1) daily_cap_tokens 改为可空（幂等）
alter table public.pool_contributions alter column daily_cap_tokens drop not null;

-- (2) create_llm_key 名额统计排除软删 key（幂等重建）
create or replace function public.create_llm_key(
  p_provider text, p_base_url text, p_api_key text, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_count integer; v_uid uuid; v_fk text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select count(*) into v_count from public.llm_keys where user_id = v_uid and deleted_at is null;
  if v_count >= 20 then raise exception 'Key limit reached: maximum 20 keys per user'; end if;
  select value into v_fk from public.app_config where key='field_key';
  insert into public.llm_keys (user_id, provider, base_url, api_key_enc, key_preview, note)
  values (v_uid, p_provider, p_base_url,
          pgp_sym_encrypt(p_api_key, v_fk),
          case when length(p_api_key) > 8 then left(p_api_key,4)||'...'||right(p_api_key,4) else '****' end,
          p_note)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.create_llm_key(text,text,text,text) from public, anon;
grant execute on function public.create_llm_key(text,text,text,text) to authenticated;

-- (3) 触发器 owner 校验：以 auth.uid() + llm_keys.user_id 为真源
create or replace function public.check_contrib_model() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_provider text; v_cnt integer; v_owner uuid;
begin
  if new.model_pattern is null or trim(new.model_pattern) in ('', '*') then
    raise exception 'model_pattern must be a specific model (model-level contribution only, no *)';
  end if;
  -- 只信任当前 JWT；不接受客户端用 NEW.user_id 指定其他 owner
  v_owner := auth.uid();
  if v_owner is null then raise exception 'not authenticated'; end if;
  select am.provider_key into v_provider
  from public.llm_keys k
  join public.allowed_models am on am.enabled = true
    and exists (
      select 1 from unnest(am.allowed_hosts) host
      where lower(host) = lower(split_part(split_part(k.base_url, '://', 2), '/', 1))
    )
  where k.id = new.key_id and k.user_id = v_owner and k.deleted_at is null
  limit 1;
  if v_provider is null then raise exception 'key host is not in the enabled provider allowlist'; end if;
  new.user_id := v_owner;
  select count(*) into v_cnt from public.rate_rules
  where enabled = true and provider_key = v_provider
    and position('%' in model_pattern) = 0 and position('*' in model_pattern) = 0
    and lower(model_pattern) = lower(new.model_pattern);
  if v_cnt = 0 then
    raise exception 'model % is not allowed for provider %', new.model_pattern, v_provider;
  end if;
  return new;
end $$;
drop trigger if exists contrib_model_check on public.pool_contributions;
create trigger contrib_model_check before insert or update of model_pattern, key_id on public.pool_contributions
for each row execute function public.check_contrib_model();

-- 完成
select 'TokenPool fix v4.7 applied OK' as status;
