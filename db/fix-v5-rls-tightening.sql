-- ============================================================
-- TokenPool 修复脚本 v5.4 - 2026-08-12 上线前 RLS 全面收紧
-- 执行位置：Supabase Dashboard > SQL Editor（直接全选粘贴执行）
-- 严禁命令行 psql 直连执行（service_role 旁路 RLS，会掩盖未生效真相）
-- 全文幂等；可在已应用 v3 / v4 / v5 / v5.1 / v5.2 / v5.3 的库上重复执行
-- 重启网关 / 浏览器硬刷（Ctrl+Shift+R）后生效
-- v5.3 调整：全面 revoke/grant 移到所有 create or replace function 之后，
--   保证从 schema-phase2 + fix-v3(v4.7) 基线首次升级可走。
--   同时补齐 v5 原有的 pause_contribution / withdraw_contribution / withdraw_contributions_by_key RPC 定义。
-- v5.4 调整：
--   - update_llm_key 允许 /v1 单段路径；严格 /chat 等深路径拒绝；base path 实际变更才触发撤回
--   - 自检段除策略与 RPC 存在外，增加：RLS 显式 enable、owner_select=3、owner RPC 对 anon/PUBLIC deny、
--     service_role RPC 对 authenticated deny
--   - ACL 自检改用 aclexplode() 检查 grantee=0 (PUBLIC) 是否授 EXECUTE；补验 authenticated 已授予 owner RPC，
--     避免错 revoke。旧实现 join pg_roles 并测 r.rolname='PUBLIC'会漏验默认 PUBLIC EXECUTE（伪角色不在 pg_roles）。
-- 内容：
--   1. 动态清理三表所有 ALL/INSERT/UPDATE/DELETE 客户端策略
--      （llm_keys / pool_keys / pool_contributions）
--   2. drop + recreate owner_select（仅 SELECT，auth.uid()=user_id）
--   3. 新增 owner-only delete_llm_key(p_id uuid) RPC
--      - 验证 owner
--      - 原子撤回该 Key 未撤回贡献（pool_contributions→withdrawn）
--      - soft-delete llm_keys.deleted_at
--   4. 收齐所有 RPC 的 execute 权限：revoke public,anon；
--      仅 grant authenticated / service_role
--      含补漏：update_llm_key 此前未显式 revoke
--   5. resume_contribution 加白名单复检：host+model 仍属 enabled
--      allowed_models / rate_rules，否则拒绝恢复（防已禁用模型恢复）
--   6. create_contribution 显式拒绝通配（%、*），参数校验收紧
--   7. pause/resume_pool_key 不写 updated_at（pool_keys 表无该列）
--   8. 自检：发现任何客户端写策略立即抛错（双保险）
-- ============================================================

-- ============================================================
-- 1. 动态清理三表所有写策略
-- 兼容策略命名差异（owner_all / owner_write / 等任意命名）
-- ============================================================
do $$
declare r record;
begin
  for r in
    select policyname, tablename, cmd
    from pg_policies
    where schemaname='public'
      and tablename in ('llm_keys','pool_keys','pool_contributions')
      and cmd in ('ALL','INSERT','UPDATE','DELETE')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    raise notice 'dropped write policy % (%) on %', r.policyname, r.cmd, r.tablename;
  end loop;
end $$;

-- ============================================================
-- 2. drop + recreate owner_select（三表）
-- 幂等：先 drop，再 create
-- ============================================================
do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname='public'
      and tablename in ('llm_keys','pool_keys','pool_contributions')
      and policyname = 'owner_select'
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    raise notice 'dropped existing owner_select on %', r.tablename;
  end loop;
end $$;

create policy owner_select on public.llm_keys
  for select using (auth.uid() = user_id);

create policy owner_select on public.pool_keys
  for select using (auth.uid() = user_id);

create policy owner_select on public.pool_contributions
  for select using (auth.uid() = user_id);

-- ============================================================
-- 3. owner-only 原子 delete_llm_key(p_id uuid) RPC
-- 流程：owner 校验 → 撤回该 Key 的 active/paused/throttled 贡献 → soft-delete
-- ⚠️ 不依赖前端先调 withdraw_contributions_by_key，再单独 UPDATE llm_keys
--    整段在 RPC 内一个事务里完成，避免两步竞态
-- ============================================================
create or replace function public.delete_llm_key(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_id is null then raise exception 'id required'; end if;
  if not exists (
    select 1 from public.llm_keys
    where id = p_id and user_id = v_uid and deleted_at is null
  ) then
    raise exception 'not found or not owner';
  end if;
  -- 撤回该 Key 未撤回的贡献
  update public.pool_contributions
     set status = 'withdrawn', updated_at = now()
   where key_id = p_id and user_id = v_uid
     and status in ('active','paused','throttled');
  -- soft-delete（标记 deleted_at；前端创建 20 上限 / 列表面板已过滤软删行）
  update public.llm_keys
     set deleted_at = now()
   where id = p_id and user_id = v_uid and deleted_at is null;
end $$;

-- ⚠️ revoke/grant 移到本脚本末尾（定义全部 RPC 后执行）以保证首次从 v4.7 基线升级可执行

-- resume_contribution 定义见 §10.2（v5.2 supersedes；本脚本只保留一份定义）

-- ============================================================
-- 6. create_contribution：显式拒绝通配（%、*）
--    触发器 check_contrib_model 已校验，但 RPC 入口再做一次防御
-- ============================================================
create or replace function public.create_contribution(
  p_key_id uuid,
  p_model_pattern text,
  p_daily_cap_tokens bigint default null,
  p_total_cap_tokens bigint default null,
  p_expires_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_key_id is null then raise exception 'key_id required'; end if;
  if p_model_pattern is null or trim(p_model_pattern) = '' then
    raise exception 'model_pattern required';
  end if;
  if position('%' in p_model_pattern) > 0 or position('*' in p_model_pattern) > 0 then
    raise exception 'model_pattern must be specific (no wildcards)';
  end if;
  if p_daily_cap_tokens is not null and p_daily_cap_tokens <= 0 then
    raise exception 'daily_cap_tokens must be > 0';
  end if;
  if p_total_cap_tokens is not null and p_total_cap_tokens <= 0 then
    raise exception 'total_cap_tokens must be > 0';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expires_at must be in the future';
  end if;
  insert into public.pool_contributions (
    user_id, key_id, model_pattern, daily_cap_tokens, total_cap_tokens, expires_at
  ) values (
    v_uid, p_key_id, p_model_pattern, p_daily_cap_tokens, p_total_cap_tokens, p_expires_at
  )
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.create_contribution(uuid,text,bigint,bigint,timestamptz) from public, anon;
grant  execute on function public.create_contribution(uuid,text,bigint,bigint,timestamptz) to authenticated;

-- ============================================================
-- 7. pause/resume_pool_key：不再写 updated_at
--    原因：pool_keys 表没有 updated_at 列（schema-phase2.sql line 142-147）
--    注释保持状态机语义（防未来误改回来）
-- ============================================================
create or replace function public.pause_pool_key(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_status text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select status into v_status from public.pool_keys where id = p_id and user_id = v_uid;
  if v_status is null then raise exception 'not found or not owner'; end if;
  if v_status <> 'active' then raise exception 'only active pool keys can be paused'; end if;
  -- pool_keys 表无 updated_at 列；只更新 status
  update public.pool_keys set status = 'disabled' where id = p_id;
end $$;

create or replace function public.resume_pool_key(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_status text; v_other int;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select status into v_status from public.pool_keys where id = p_id and user_id = v_uid;
  if v_status is null then raise exception 'not found or not owner'; end if;
  if v_status <> 'disabled' then raise exception 'only disabled pool keys can be resumed'; end if;
  -- 旧 Key（无 key_enc 加密明文）不可恢复明文；启用后用户拿不到 key，拒绝并引导生成新 Key
  if not exists (select 1 from public.pool_keys where id = p_id and user_id = v_uid and key_enc is not null) then
    raise exception 'old key has no recoverable plaintext; generate a new key instead';
  end if;
  -- 唯一约束保护：确保没有另一把 active
  select count(*) into v_other from public.pool_keys where user_id = v_uid and status = 'active';
  if v_other > 0 then raise exception 'another active pool key exists for this user'; end if;
  -- pool_keys 表无 updated_at 列；只更新 status
  update public.pool_keys set status = 'active' where id = p_id;
end $$;

revoke execute on function public.pause_pool_key(uuid) from public, anon;
grant  execute on function public.pause_pool_key(uuid) to authenticated;
revoke execute on function public.resume_pool_key(uuid) from public, anon;
grant  execute on function public.resume_pool_key(uuid) to authenticated;

-- ============================================================
-- 8. 自检移至本脚本末尾（所有 RPC 定义 + ACL 之后执行）
-- ============================================================

-- ============================================================
-- 10. v5.2 增强（2026-08-12 16:07+08:00 子代理追加）
--   A) SSRF TOCTOU：update_llm_key 重写为严格 URL 校验 + base_url 变更时
--       原子撤回该 Key 所有未撤回贡献；返回 withdrawn count
--   C) 贡献/恢复相关 RPC + 触发器：服务端强制 base_url scheme=https、
--       无 userinfo/query/hash（不能只比 hostname）
-- ============================================================

-- ============================================================
-- 10.1 check_contrib_model 触发器：增加 base_url 强校验
--   - 必须 https://（防 API Key 明文经 HTTP 发出）
--   - 无 userinfo / query / hash
-- ============================================================
create or replace function public.check_contrib_model() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_provider text;
  v_cnt integer;
  v_owner uuid;
  v_host text;
begin
  if new.model_pattern is null or trim(new.model_pattern) in ('', '*') then
    raise exception 'model_pattern must be a specific model (model-level contribution only, no *)';
  end if;
  -- 只信任当前 JWT；不接受客户端用 NEW.user_id 指定其他 owner
  v_owner := auth.uid();
  if v_owner is null then raise exception 'not authenticated'; end if;

  -- ⚠️ v5.2：贡献 Key 必须是 https（防 API Key 明文经 HTTP 泄露）+ 拒绝 userinfo/query/hash
  select k.base_url into v_host  -- 复用变量作为临时字符串
    from public.llm_keys k
   where k.id = new.key_id and k.user_id = v_owner and k.deleted_at is null;
  if v_host is null then raise exception 'key not found or not owner'; end if;
  if position('@' in v_host) > 0 then raise exception 'key base_url must not contain userinfo'; end if;
  if position('?' in v_host) > 0 then raise exception 'key base_url must not contain query'; end if;
  if position('#' in v_host) > 0 then raise exception 'key base_url must not contain hash'; end if;
  if v_host !~* '^https://' then
    raise exception 'contribution requires key base_url scheme=https (got: %)', split_part(v_host, '://', 1);
  end if;

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

-- ============================================================
-- 10.2 resume_contribution：增加 base_url scheme=https 校验
-- ============================================================
create or replace function public.resume_contribution(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_status text;
  v_key_id uuid;
  v_model text;
  v_health text;
  v_deleted timestamptz;
  v_dup int;
  v_host text;
  v_base_url text;
  v_provider text;
  v_cnt int;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select status, key_id, model_pattern
    into v_status, v_key_id, v_model
    from public.pool_contributions
   where id = p_id and user_id = v_uid;
  if v_status is null then raise exception 'not found or not owner'; end if;
  if v_status not in ('paused','throttled') then raise exception 'only paused or throttled contributions can be resumed'; end if;

  -- 原 Key 状态必须正常（未软删、未 down）
  select health_status, deleted_at, base_url
    into v_health, v_deleted, v_base_url
    from public.llm_keys
   where id = v_key_id and user_id = v_uid;
  if v_deleted is not null then raise exception 'key deleted: cannot resume'; end if;
  if v_health = 'down' then raise exception 'key down: cannot resume'; end if;

  -- ⚠️ v5.2：base_url 必须 https + 无 userinfo/query/hash
  if v_base_url is null then raise exception 'key base_url missing'; end if;
  if position('@' in v_base_url) > 0 then raise exception 'key base_url must not contain userinfo'; end if;
  if position('?' in v_base_url) > 0 then raise exception 'key base_url must not contain query'; end if;
  if position('#' in v_base_url) > 0 then raise exception 'key base_url must not contain hash'; end if;
  if v_base_url !~* '^https://' then raise exception 'resume requires key base_url scheme=https'; end if;

  -- 复检 host + model 仍在 enabled allowed_models / rate_rules 白名单
  v_host := lower(split_part(split_part(v_base_url, '://', 2), '/', 1));
  select am.provider_key into v_provider
    from public.allowed_models am
   where am.enabled = true
     and exists (
       select 1 from unnest(am.allowed_hosts) h where lower(h) = v_host
     )
   limit 1;
  if v_provider is null then
    raise exception 'key host not in enabled provider allowlist';
  end if;
  select count(*) into v_cnt
    from public.rate_rules
   where enabled = true
     and provider_key = v_provider
     and position('%' in model_pattern) = 0
     and position('*' in model_pattern) = 0
     and lower(model_pattern) = lower(v_model);
  if v_cnt = 0 then
    raise exception 'model not allowed for provider %', v_provider;
  end if;

  -- 同 Key 同模型不允许双重 active
  select count(*) into v_dup
    from public.pool_contributions
   where user_id = v_uid
     and key_id = v_key_id
     and model_pattern = v_model
     and status = 'active'
     and id <> p_id;
  if v_dup > 0 then
    raise exception 'another active contribution exists for this key+model';
  end if;

  update public.pool_contributions
     set status = 'active', updated_at = now()
   where id = p_id;
end $$;

revoke execute on function public.resume_contribution(uuid) from public, anon;
grant  execute on function public.resume_contribution(uuid) to authenticated;

-- ============================================================
-- 10.3 update_llm_key 重写：严格 URL 校验 + base_url 变更时原子撤回贡献
-- 返回值：被原子撤回的贡献条数；前端可提示用户重新贡献
--   场景：
--     - 该 Key 有 active/paused/throttled 贡献 → 新 base_url 必须 https 且 hostname 命中白名单
--     - base_url 实际变更（protocol 或 host 不同）→ 原子撤回未撤回贡献，再更新 Key
--     - 自定义（未贡献）Key：仍允许 http / https，但 healthcheck 必须跳过非白名单
-- ============================================================
drop function if exists public.update_llm_key(uuid,text,text,text,text);

create or replace function public.update_llm_key(
  p_id uuid,
  p_provider text,
  p_base_url text,
  p_api_key text default null,
  p_note text default null
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid;
  v_fk text;
  v_old_base_url text;
  v_old_protocol text;
  v_old_host text;
  v_old_path text;
  v_new_protocol text;
  v_new_host text;
  v_new_path text;
  v_base_clean text;
  v_base_after_host text;
  v_path text;
  v_has_active_contrib boolean;
  v_count_withdrawn int := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_id is null then raise exception 'id required'; end if;
  if p_provider is null or trim(p_provider) = '' then raise exception 'provider required'; end if;
  if p_base_url is null or trim(p_base_url) = '' then raise exception 'base_url required'; end if;

  -- 严格 URL 校验：明确拒绝 userinfo / query / hash，不静默剥离
  if position('?' in p_base_url) > 0 then raise exception 'base_url must not contain query string'; end if;
  if position('#' in p_base_url) > 0 then raise exception 'base_url must not contain hash fragment'; end if;
  if position('@' in p_base_url) > 0 then raise exception 'base_url must not contain userinfo'; end if;
  v_base_clean := p_base_url;
  if position('://' in v_base_clean) = 0 then raise exception 'base_url must start with http:// or https://'; end if;
  v_new_protocol := lower(split_part(v_base_clean, '://', 1));
  if v_new_protocol <> 'http' and v_new_protocol <> 'https' then
    raise exception 'base_url protocol must be http or https';
  end if;
  -- 抽出 host（host:port → host）；port 不强制限定
  v_new_host := lower(split_part(split_part(v_base_clean, '://', 2), '/', 1));
  if v_new_host = '' then raise exception 'base_url missing host'; end if;
  -- ⚠️ base_url 路径白名单（含智谱 /api/paas/v4）；其余深路径拒绝
  -- 先剥除尾部斜杠（避免 /v1/ 被误判为深路径）
  v_base_after_host := regexp_replace(split_part(v_base_clean, '://', 2), '/+$', '');
  v_new_path := '';
  if position('/' in v_base_after_host) > 0 then
    v_new_path := substring(v_base_after_host from position('/' in v_base_after_host));
  end if;
  if lower(v_new_path) not in ('', '/v1', '/api', '/api/paas/v4') then
    raise exception 'base_url path not allowed (got: %)', v_new_path;
  end if;
  -- 规范化 base_url（去除尾部斜杠）
  v_base_clean := regexp_replace(v_base_clean, '/+$', '');

  -- Owner 校验 + 旧值读取（合并到一次 SELECT，减少 race）
  select base_url into v_old_base_url
    from public.llm_keys
   where id = p_id and user_id = v_uid and deleted_at is null;
  if v_old_base_url is null then raise exception 'not found or not owner'; end if;

  v_old_protocol := lower(split_part(v_old_base_url, '://', 1));
  v_old_host := lower(split_part(split_part(v_old_base_url, '://', 2), '/', 1));
  -- 旧 path（标准化）
  v_old_path := '';
  declare v_old_remainder text; begin
    v_old_remainder := split_part(v_old_base_url, '://', 2);
    if position('/' in v_old_remainder) > 0 then
      v_old_path := '/' || split_part(v_old_remainder, '/', 2);
    end if;
    v_old_path := regexp_replace(v_old_path, '/+$', '');
  end;

  -- 若该 Key 有 active/paused/throttled 贡献：新 base_url 必须 https + path 实际存在且 hostname 命中白名单
  select exists (
    select 1 from public.pool_contributions
     where key_id = p_id and user_id = v_uid
       and status in ('active','paused','throttled')
  ) into v_has_active_contrib;

  if v_has_active_contrib then
    if v_new_protocol <> 'https' then
      raise exception 'base_url must be https for keys with active contributions';
    end if;
    if not exists (
      select 1 from public.allowed_models am
       where am.enabled = true
         and exists (
           select 1 from unnest(am.allowed_hosts) h where lower(h) = v_new_host
         )
    ) then
      raise exception 'base_url host not in enabled allowed_models (active contributions require whitelist match)';
    end if;
  end if;

  -- base_url 实际变更（protocol / host / path 任一不同）→ 原子撤回未撤回贡献
  -- 尾部斜杠规范化不算变更（如 https://api.deepseek.com/v1 与 https://api.deepseek.com/v1/ 视为同一）
  if v_old_protocol is distinct from v_new_protocol
     or v_old_host is distinct from v_new_host
     or v_old_path is distinct from v_new_path then
    with upd as (
      update public.pool_contributions
         set status = 'withdrawn', updated_at = now()
       where key_id = p_id and user_id = v_uid
         and status in ('active','paused','throttled')
      returning 1
    )
    select count(*) into v_count_withdrawn from upd;
  end if;

  -- 更新 Key 基础字段（统一覆盖，不 coalesce：避免旧值与新值类型不一致）
  update public.llm_keys set
    provider = p_provider,
    base_url = v_base_clean,
    note = coalesce(p_note, note)
  where id = p_id and user_id = v_uid;

  -- 重新加密 API Key（如提供）
  if p_api_key is not null and p_api_key <> '' then
    select value into v_fk from public.app_config where key='field_key';
    update public.llm_keys set
      api_key_enc = pgp_sym_encrypt(p_api_key, v_fk),
      key_preview = case when length(p_api_key) > 8 then left(p_api_key,4)||'...'||right(p_api_key,4) else '****' end
    where id = p_id;
  end if;

  return v_count_withdrawn;
end $$;

revoke execute on function public.update_llm_key(uuid,text,text,text,text) from public, anon;
grant  execute on function public.update_llm_key(uuid,text,text,text,text) to authenticated;

-- ============================================================
-- 10.3.5 补齐 v5 原有 RPC 定义（原 v5 脚本里的 pause_contribution / withdraw_*）
--   原 v5 已定义这些，本子代理在 v5.1 重写时误删，现恢复以保证从 v4.7 基线首升可执行
-- ============================================================

-- 暂停贡献
create or replace function public.pause_contribution(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_status text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  select status into v_status from public.pool_contributions where id = p_id and user_id = v_uid;
  if v_status is null then raise exception 'not found or not owner'; end if;
  if v_status <> 'active' then raise exception 'only active contributions can be paused'; end if;
  update public.pool_contributions set status = 'paused', updated_at = now() where id = p_id;
end $$;

revoke execute on function public.pause_contribution(uuid) from public, anon;
grant  execute on function public.pause_contribution(uuid) to authenticated;

-- 撤回贡献（任意状态 → withdrawn，软删）
create or replace function public.withdraw_contribution(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  update public.pool_contributions set status = 'withdrawn', updated_at = now()
    where id = p_id and user_id = v_uid;
  if not found then raise exception 'not found or not owner'; end if;
end $$;

revoke execute on function public.withdraw_contribution(uuid) from public, anon;
grant  execute on function public.withdraw_contribution(uuid) to authenticated;

-- 删除 Key 时联动撤回所有未撤回贡献（v5 原本 deleteKey 流程上会调用）
create or replace function public.withdraw_contributions_by_key(p_key_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_n int;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authenticated'; end if;
  with upd as (
    update public.pool_contributions
       set status = 'withdrawn', updated_at = now()
     where key_id = p_key_id and user_id = v_uid
       and status in ('active','paused','throttled')
    returning 1
  )
  select count(*) into v_n from upd;
  return v_n;
end $$;

revoke execute on function public.withdraw_contributions_by_key(uuid) from public, anon;
grant  execute on function public.withdraw_contributions_by_key(uuid) to authenticated;

-- ============================================================
-- 10.3.6 全面收齐 RPC 的 execute 权限（定义全部 RPC 后执行；首次从 v4.7 升级可走）
-- 含补漏：update_llm_key v3 漏 revoke（默认 PUBLIC 可调）
-- 在已部署过 v5/v5.1 的库上也是幂等（重 revoke 不报错）
-- ============================================================

-- 前端 owner 可调：authenticated
revoke execute on function public.reveal_llm_key(uuid)        from public, anon;
grant  execute on function public.reveal_llm_key(uuid)        to authenticated;

revoke execute on function public.reveal_pool_key(uuid)       from public, anon;
grant  execute on function public.reveal_pool_key(uuid)       to authenticated;

revoke execute on function public.create_llm_key(text,text,text,text) from public, anon;
grant  execute on function public.create_llm_key(text,text,text,text) to authenticated;

revoke execute on function public.update_llm_key(uuid,text,text,text,text) from public, anon;
grant  execute on function public.update_llm_key(uuid,text,text,text,text) to authenticated;

revoke execute on function public.create_pool_key(text)       from public, anon;
grant  execute on function public.create_pool_key(text)       to authenticated;

revoke execute on function public.reset_pool_key(text)        from public, anon;
grant  execute on function public.reset_pool_key(text)        to authenticated;

revoke execute on function public.pause_pool_key(uuid)        from public, anon;
grant  execute on function public.pause_pool_key(uuid)        to authenticated;

revoke execute on function public.resume_pool_key(uuid)       from public, anon;
grant  execute on function public.resume_pool_key(uuid)       to authenticated;

revoke execute on function public.create_contribution(uuid,text,bigint,bigint,timestamptz) from public, anon;
grant  execute on function public.create_contribution(uuid,text,bigint,bigint,timestamptz) to authenticated;

revoke execute on function public.pause_contribution(uuid)    from public, anon;
grant  execute on function public.pause_contribution(uuid)    to authenticated;

revoke execute on function public.resume_contribution(uuid)   from public, anon;
grant  execute on function public.resume_contribution(uuid)   to authenticated;

revoke execute on function public.withdraw_contribution(uuid) from public, anon;
grant  execute on function public.withdraw_contribution(uuid) to authenticated;

revoke execute on function public.withdraw_contributions_by_key(uuid) from public, anon;
grant  execute on function public.withdraw_contributions_by_key(uuid) to authenticated;

revoke execute on function public.delete_llm_key(uuid)        from public, anon;
grant  execute on function public.delete_llm_key(uuid)        to authenticated;

revoke execute on function public.pool_stats()                from public, anon;
grant  execute on function public.pool_stats()                to authenticated;

revoke execute on function public.my_usage_stats()            from public, anon;
grant  execute on function public.my_usage_stats()            to authenticated;

revoke execute on function public.get_my_contributed_tokens() from public, anon;
grant  execute on function public.get_my_contributed_tokens() to authenticated;

-- 服务端 RPC：仅 service_role（必须严格，否则前端可改 used_today / total_used）
revoke execute on function public.reveal_llm_key_service(uuid)         from public, anon, authenticated;
grant  execute on function public.reveal_llm_key_service(uuid)         to service_role;

revoke execute on function public.update_usage_counters(uuid,uuid,bigint) from public, anon, authenticated;
grant  execute on function public.update_usage_counters(uuid,uuid,bigint) to service_role;

revoke execute on function public.adjust_points(uuid,numeric,text,uuid) from public, anon, authenticated;
grant  execute on function public.adjust_points(uuid,numeric,text,uuid) to service_role;

-- ============================================================
-- 10.3.7 自检：所有 RPC + 策略检查（脚本末尾执行）
-- ============================================================

-- (a) 三表 RLS enabled（幂等、显式）
alter table public.llm_keys            enable row level security;
alter table public.pool_keys          enable row level security;
alter table public.pool_contributions enable row level security;
do $$ begin raise notice 'OK: RLS enabled on llm_keys, pool_keys, pool_contributions'; end $$;

-- (b) 三表无客户端写策略（owner_select for SELECT 以外）
do $$
declare rec record; cnt int := 0;
begin
  for rec in
    select tablename, policyname, cmd
    from pg_policies
    where schemaname='public'
      and tablename in ('llm_keys','pool_keys','pool_contributions')
      and cmd in ('INSERT','UPDATE','DELETE','ALL')
  loop
    raise notice 'WARNING: write policy % on % (cmd=%)', rec.policyname, rec.tablename, rec.cmd;
    cnt := cnt + 1;
  end loop;
  if cnt > 0 then
    raise exception 'found % client write policies on llm_keys/pool_keys/pool_contributions; abort', cnt;
  else
    raise notice 'OK: no client write policies on llm_keys/pool_keys/pool_contributions';
  end if;
end $$;

-- (c) owner_select SELECT 策略 = 3 条（每表一条）
do $$
declare cnt int := 0;
begin
  select count(*) into cnt
    from pg_policies
   where schemaname='public'
     and tablename in ('llm_keys','pool_keys','pool_contributions')
     and policyname='owner_select'
     and cmd='SELECT';
  if cnt <> 3 then
    raise exception 'owner_select policy count = % (expected 3)', cnt;
  else
    raise notice 'OK: owner_select SELECT policy = 3';
  end if;
end $$;

-- (d) owner RPC ACL：anon + PUBLIC 均不有 EXECUTE；authenticated 仅用于 owner RPC
--    service_role RPC：仅 service_role 可调
-- ⚠️ v5.4 修正：旧实现 join pg_roles 并测 r.rolname='PUBLIC'；但 PUBLIC 是伪角色、OID=0，
--   不在 pg_roles 表，旧查漏验证默认 PUBLIC EXECUTE。改用 aclexplode() 拆解函数 ACL，
--   检查 grantee=0 (PUBLIC) 是否授予 EXECUTE；anon / authenticated 走 pg_roles OID 单独查。
do $$
declare rec record; bad int := 0;
declare v_anon_oid oid; v_auth_oid oid;
begin
  select oid into v_anon_oid from pg_roles where rolname='anon';
  select oid into v_auth_oid from pg_roles where rolname='authenticated';
  if v_anon_oid is null or v_auth_oid is null then
    raise exception 'role anon / authenticated missing in pg_roles (oid anon=%, auth=%)', v_anon_oid, v_auth_oid;
  end if;

  -- 1) owner RPC：检查 grantee=0 (PUBLIC) 不应拥有 EXECUTE
  for rec in
    select p.proname, 'PUBLIC'::text as grantee, 'X'::text as privilege_type
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
     where p.pronamespace='public'::regnamespace
       and p.proname in ('delete_llm_key','pause_pool_key','resume_pool_key',
                         'create_contribution','pause_contribution','resume_contribution',
                         'withdraw_contribution','withdraw_contributions_by_key','update_llm_key',
                         'reveal_llm_key','reveal_pool_key','create_llm_key','create_pool_key',
                         'reset_pool_key','pool_stats','my_usage_stats','get_my_contributed_tokens')
       and acl.grantee = 0
       and acl.privilege_type = 'EXECUTE'
  loop
    raise notice 'ACL ERROR: % should be denied to %', rec.proname, rec.grantee;
    bad := bad + 1;
  end loop;
  -- 2) owner RPC：anon OID 不应拥有 EXECUTE（个别函数保留仅 authenticated）
  for rec in
    select p.proname, r.rolname
      from pg_proc p, pg_roles r
     where p.pronamespace='public'::regnamespace
       and p.proname in ('delete_llm_key','pause_pool_key','resume_pool_key',
                         'create_contribution','pause_contribution','resume_contribution',
                         'withdraw_contribution','withdraw_contributions_by_key','update_llm_key',
                         'reveal_llm_key','reveal_pool_key','create_llm_key','create_pool_key',
                         'reset_pool_key','pool_stats','my_usage_stats','get_my_contributed_tokens')
       and r.oid = v_anon_oid
       and has_function_privilege(r.oid, p.oid, 'EXECUTE')
  loop
    raise notice 'ACL ERROR: % should be denied to %', rec.proname, rec.rolname;
    bad := bad + 1;
  end loop;
  -- 3) service_role RPC：authenticated 不应可调
  for rec in
    select p.proname, r.rolname
      from pg_proc p, pg_roles r
     where p.pronamespace='public'::regnamespace
       and p.proname in ('reveal_llm_key_service','update_usage_counters','adjust_points')
       and r.oid = v_auth_oid
       and has_function_privilege(r.oid, p.oid, 'EXECUTE')
  loop
    raise notice 'ACL ERROR: % should not be granted to %', rec.proname, rec.rolname;
    bad := bad + 1;
  end loop;
  -- 4) 补充证明：authenticated 对 owner RPC 有 EXECUTE（避免错 revoke）
  for rec in
    select p.proname
      from pg_proc p
     where p.pronamespace='public'::regnamespace
       and p.proname in ('delete_llm_key','pause_pool_key','resume_pool_key',
                         'create_contribution','pause_contribution','resume_contribution',
                         'withdraw_contribution','withdraw_contributions_by_key','update_llm_key',
                         'reveal_llm_key','reveal_pool_key','create_llm_key','create_pool_key',
                         'reset_pool_key','pool_stats','my_usage_stats','get_my_contributed_tokens')
       and not has_function_privilege(v_auth_oid, p.oid, 'EXECUTE')
  loop
    raise notice 'ACL ERROR: % missing authenticated EXECUTE', rec.proname;
    bad := bad + 1;
  end loop;
  if bad > 0 then
    raise exception 'ACL self-check failed: % violations (PUBLIC/anon must be denied; service_role RPC must not be granted to authenticated)', bad;
  else
    raise notice 'OK: owner RPC PUBLIC/anon denied (aclexplode grantee=0 + oid); authenticated granted; service_role RPC authenticated denied';
  end if;
end $$;

-- (b) 关键 RPC 存在性检查
do $$
begin
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='delete_llm_key';
  if not found then raise exception 'delete_llm_key RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='pause_pool_key';
  if not found then raise exception 'pause_pool_key RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='resume_pool_key';
  if not found then raise exception 'resume_pool_key RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='create_contribution';
  if not found then raise exception 'create_contribution RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='pause_contribution';
  if not found then raise exception 'pause_contribution RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='resume_contribution';
  if not found then raise exception 'resume_contribution RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='withdraw_contribution';
  if not found then raise exception 'withdraw_contribution RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='withdraw_contributions_by_key';
  if not found then raise exception 'withdraw_contributions_by_key RPC missing'; end if;
  perform 1 from pg_proc where pronamespace='public'::regnamespace and proname='update_llm_key';
  if not found then raise exception 'update_llm_key RPC missing'; end if;
  raise notice 'OK: all 9 critical owner RPCs present (delete_llm_key, pause_pool_key, resume_pool_key, create_contribution, pause_contribution, resume_contribution, withdraw_contribution, withdraw_contributions_by_key, update_llm_key)';
end $$;

-- ============================================================
-- 10.4 启发式：存量不合规 base_url 一次性标记（仅供运营参考，不阻塞）
-- 列出仍为 http:// 的 active Key（若存在，运营需手动决策迁 https）
-- ============================================================
do $$
declare rec record;
begin
  for rec in
    select k.id, k.user_id, k.base_url, k.provider
      from public.llm_keys k
     where k.deleted_at is null
       and k.base_url !~* '^https://'
       and exists (
         select 1 from public.pool_contributions c
          where c.key_id = k.id and c.status in ('active','paused','throttled')
       )
  loop
    raise notice 'HEURISTIC: active contribution on http key: id=%, provider=%, base_url=%', rec.id, rec.provider, rec.base_url;
  end loop;
end $$;

select 'TokenPool fix v5.4 applied OK' as status;