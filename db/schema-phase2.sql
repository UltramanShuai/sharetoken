-- TokenPool 二期建库脚本 2026-08-10
-- 说明：llm_keys 扩容加密 + 池/积分/配置 10 张新表 + RLS + RPC + 种子数据
-- 全文不使用双引号（策略名下划线、JSON 用 jsonb_build_object），避免传输转义问题

create extension if not exists pgcrypto;

-- 服务端配置表（仅 service_role 可读，无公开策略）
create table if not exists public.app_config (
  key text primary key,
  value text not null
);
alter table public.app_config enable row level security;
insert into public.app_config(key, value)
values ('field_key', encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- llm_keys 扩容：加密列 + 健康字段
alter table public.llm_keys add column if not exists api_key_enc bytea;
alter table public.llm_keys add column if not exists key_preview text;
alter table public.llm_keys add column if not exists health_status text not null default 'unknown';
alter table public.llm_keys add column if not exists last_check_at timestamptz;
alter table public.llm_keys add column if not exists last_latency_ms integer;
alter table public.llm_keys add column if not exists last_error text;
alter table public.llm_keys add column if not exists fail_streak integer not null default 0;

-- 存量明文迁移为加密（旧明文列暂留，前端切 RPC 后再删）
update public.llm_keys
set api_key_enc = pgp_sym_encrypt(api_key, (select value from public.app_config where key='field_key')),
    key_preview = case when length(api_key) > 8 then left(api_key,4)||'...'||right(api_key,4) else '****' end
where api_key_enc is null and api_key is not null;

-- 过渡期触发器：旧前端直写明文时自动维护加密列与预览
create or replace function public.llm_keys_sync_enc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.api_key is not null and new.api_key <> '' then
    new.api_key_enc := pgp_sym_encrypt(new.api_key, (select value from public.app_config where key='field_key'));
    new.key_preview := case when length(new.api_key) > 8 then left(new.api_key,4)||'...'||right(new.api_key,4) else '****' end;
  end if;
  return new;
end $$;

drop trigger if exists trg_llm_keys_sync_enc on public.llm_keys;
create trigger trg_llm_keys_sync_enc before insert or update on public.llm_keys
for each row execute function public.llm_keys_sync_enc();

-- reveal RPC：前端版仅本人可 reveal（security definer 校验 auth.uid()=user_id）
-- 网关版 reveal_llm_key_service 校验 JWT role=service_role；完整定义见 fix-v3.sql
-- ⚠️ search_path 必须包含 extensions（Supabase 的 pgcrypto 装在这里）
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
-- 完整 create_llm_key(4参,加密) / update_llm_key / pool_stats / reveal_llm_key_service 定义见 fix-v3.sql

-- 贡献准入白名单
create table if not exists public.allowed_models (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null, display_name text not null,
  allowed_hosts text[] not null, model_pattern text not null,
  enabled boolean not null default true, note text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.allowed_models enable row level security;
create policy public_read on public.allowed_models for select using (true);

-- 汇率配置表（Table Editor 改数字即生效）
create table if not exists public.rate_rules (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null, model_pattern text not null,
  tokens_per_point bigint not null, enabled boolean not null default false,
  note text not null default '', updated_at timestamptz not null default now(),
  unique(provider_key, model_pattern)
);
alter table public.rate_rules enable row level security;
create policy public_read on public.rate_rules for select using (true);

-- 积分档位表（可配置）
-- ⚠️ v3.4：等级门槛改为 min_contributed_tokens（累计贡献 token），见 fix-v3.sql v3.4
create table if not exists public.reward_tiers (
  level integer primary key, min_points numeric not null,
  daily_quota bigint not null, perks jsonb not null default '{}'::jsonb
);
alter table public.reward_tiers enable row level security;
create policy public_read on public.reward_tiers for select using (true);

-- 全局配置开关（防刷参数集中在此）
create table if not exists public.reward_config (
  key text primary key, value text not null, note text not null default ''
);
alter table public.reward_config enable row level security;

-- 贡献记录
-- 状态机：active（贡献中）/ paused（暂停）/ throttled（健康降级）/ withdrawn（撤回，软删除）
-- 撤回不物理删除：usage_events 外键关联，积分账本保留；撤回后同 key 可重新贡献
-- 贡献记录
-- 状态机：active（贡献中）/ paused（暂停）/ throttled（健康降级）/ withdrawn（撤回，软删除）
-- 撤回不物理删除：usage_events 外键关联，积分账本保留；撤回后同 key 可重新贡献
--
-- ⚠️ 漂移修正：v4.7 已将 daily_cap_tokens 改为 nullable（前端用 NULL 表示「不限」）
-- 这里与 fix-v3.sql v4.7 保持一致；初次落库也是 nullable，避免后续 ALTER
create table if not exists public.pool_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  key_id uuid not null references public.llm_keys(id) on delete cascade,
  model_pattern text not null, daily_cap_tokens bigint,
  used_today bigint not null default 0, status text not null default 'active',
  total_used_tokens bigint not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- 线上已手动补加的列（与 gateway.mjs 对齐）：
--   total_cap_tokens bigint         生命周期总上限
--   expires_at timestamptz          到期时间
--   health_status text              健康状态（unknown/healthy/degraded/down）
--   last_success_at timestamptz     最近成功时间（选路加权）
--   five_hour_cap_tokens bigint     每5小时上限
--   used_five_hour bigint           当前5小时窗口已用
--   five_hour_window_start timestamptz  5小时窗口起点
-- 新增列 SQL：
--   alter table public.pool_contributions add column if not exists total_cap_tokens bigint;
--   alter table public.pool_contributions add column if not exists expires_at timestamptz;
--   alter table public.pool_contributions add column if not exists health_status text not null default 'unknown';
--   alter table public.pool_contributions add column if not exists last_success_at timestamptz;
--   alter table public.pool_contributions add column if not exists five_hour_cap_tokens bigint;
--   alter table public.pool_contributions add column if not exists used_five_hour bigint not null default 0;
--   alter table public.pool_contributions add column if not exists five_hour_window_start timestamptz;
alter table public.pool_contributions enable row level security;
create policy owner_all on public.pool_contributions for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
-- 注意：public_read_active（匿名读 active 全行）已在 fix-v3.sql 中撤销，改为 pool_stats RPC

-- 平台分发 key（只存 sha256）
create table if not exists public.pool_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  key_hash text not null unique, label text not null default '',
  daily_quota bigint not null default 100000, used_today bigint not null default 0,
  status text not null default 'active', created_at timestamptz not null default now()
);
alter table public.pool_keys enable row level security;
create policy owner_all on public.pool_keys for all using (auth.uid()=user_id) with check (auth.uid()=user_id);

-- 用量流水
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  pool_key_id uuid references public.pool_keys(id),
  contribution_id uuid references public.pool_contributions(id),
  model text not null,
  prompt_tokens integer not null default 0, completion_tokens integer not null default 0,
  total_tokens integer not null default 0, latency_ms integer,
  status text not null default 'success', is_metered_exact boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.usage_events enable row level security;
create policy caller_read_own on public.usage_events for select using (
  pool_key_id in (select id from public.pool_keys where user_id=auth.uid()));
create policy contributor_read_own on public.usage_events for select using (
  contribution_id in (select id from public.pool_contributions where user_id=auth.uid()));

-- 积分账本（只增不改）
create table if not exists public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta numeric not null, reason text not null,
  ref_usage_event_id uuid references public.usage_events(id),
  created_at timestamptz not null default now()
);
alter table public.points_ledger enable row level security;
create policy owner_read on public.points_ledger for select using (auth.uid()=user_id);

-- 健康检查记录
create table if not exists public.health_checks (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references public.llm_keys(id) on delete cascade,
  status text not null, latency_ms integer, http_code integer, error_msg text,
  created_at timestamptz not null default now()
);
alter table public.health_checks enable row level security;
create policy owner_read on public.health_checks for select using (
  key_id in (select id from public.llm_keys where user_id=auth.uid()));

-- 管理审计
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor text not null, action text not null, target text, detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_audit enable row level security;

-- 种子数据：贡献准入白名单
insert into public.allowed_models(provider_key,display_name,allowed_hosts,model_pattern,enabled) values
('minimax','MiniMax',array['api.minimaxi.com','api.minimax.chat'],'MiniMax-%',true),
('deepseek','DeepSeek',array['api.deepseek.com'],'deepseek-%',true),
('zhipu','ZhipuGLM',array['open.bigmodel.cn'],'glm-%',true),
('moonshot','Moonshot',array['api.moonshot.cn'],'kimi-%',true),
('qwen','Qwen',array['dashscope.aliyuncs.com'],'qwen-%',true)
on conflict do nothing;

-- 种子数据：汇率（MiniMax 启用，其余 disabled 待审核）
insert into public.rate_rules(provider_key,model_pattern,tokens_per_point,enabled,note) values
('minimax','MiniMax-%',10000000,true,'anchor: MiniMax 2.1 per 1M'),
('deepseek','deepseek-%',7000000,false,'3 per 1M'),
('zhipu','glm-%',2600000,false,'8 per 1M'),
('moonshot','kimi-%',1050000,false,'20 per 1M'),
('qwen','qwen-%',30000000,false,'0.7 per 1M'),
('openai','gpt-%',1170000,false,'18 per 1M'),
('anthropic','claude-%',600000,false,'35 per 1M')
on conflict(provider_key,model_pattern) do nothing;

-- 种子数据：积分档位（perks 用 jsonb_build_object 避免双引号）
insert into public.reward_tiers(level,min_points,daily_quota,perks) values
(1,0,100000,jsonb_build_object('label','L1','priority',0)),
(2,2,200000,jsonb_build_object('label','L2','priority',1,'busy_priority',true)),
(3,10,500000,jsonb_build_object('label','L3','priority',2)),
(4,50,1000000,jsonb_build_object('label','L4','priority',3,'beta_access',true))
on conflict(level) do nothing;

-- 种子数据：全局配置
insert into public.reward_config(key,value,note) values
('daily_points_cap','2','max points per contributor per day'),
('new_user_cooling_hours','24','hours before new user can contribute or get pool key'),
('self_use_multiplier','0','multiplier for self-use calls (0=no reward)'),
('scarcity_threshold_low','2','contributors <= this get x2 multiplier'),
('scarcity_threshold_mid','5','contributors <= this get x1.5 multiplier'),
('reliability_high','0.99','7d health rate >= this gets x1.2'),
('reliability_low','0.90','7d health rate < this gets x0.8'),
('estimate_discount','0.8','discount when usage is locally estimated')
on conflict(key) do nothing;
