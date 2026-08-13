-- ============================================================
-- ShareToken 种子数据示例（seed-example.sql）
-- 执行位置：Supabase Dashboard > SQL Editor（在执行完 schema-phase2 / fix-v3 / fix-v5 / anti-abuse 之后）
-- ⚠️ 本文件为示例种子，与生产值等价但已脱敏；可按需调整系数/配额后执行
-- ============================================================

-- ---------- 1. 积分奖励参数（reward_config）----------
insert into public.reward_config (key, value, note) values
  ('new_user_cooling_hours','24','hours before new user can contribute or get pool key'),
  ('scarcity_threshold_low','2','contributors <= this get x2 multiplier'),
  ('scarcity_threshold_mid','5','contributors <= this get x1.5 multiplier'),
  ('reliability_high','0.99','7d health rate >= this gets x1.2'),
  ('reliability_low','0.90','7d health rate < this gets x0.8'),
  ('self_use_multiplier','1','自用照常计分，兑换汇率保证自刷亏本'),
  ('daily_points_cap','10','积分仅展示，不再设上限'),
  ('estimate_discount','0.8','discount when usage is locally estimated'),
  ('health_checks_retention_days','7','health_checks 保留天数'),
  ('usage_events_retention_days','90','usage_events 保留天数'),
  ('model_list_cache_seconds','300','可用模型列表缓存秒数')
on conflict (key) do nothing;

-- ---------- 2. 用户等级与配额（reward_tiers）----------
insert into public.reward_tiers (level, min_points, daily_quota, perks, min_contributed_tokens) values
  (1, '0',  10000000,  '{"rpm":60,"label":"青铜"}', 0),
  (2, '10', 30000000,  '{"rpm":120,"label":"白银"}', 100000000),
  (3, '30', 100000000, '{"rpm":300,"label":"黄金"}', 1000000000),
  (4, '80', 500000000, '{"rpm":600,"label":"钻石"}', 10000000000)
on conflict (level) do nothing;

-- ---------- 3. 模型商白名单（allowed_models）----------
-- 语义：provider_key=网关内部名；display_name=前端展示；
--       allowed_hosts=上游 API 域名白名单（网关仅放行这些 host，防 SSRF）；
--       model_pattern=该商家的模型 ID 前缀（* / % 通配）；enabled 决定是否可用/可入池
insert into public.allowed_models (provider_key, display_name, allowed_hosts, model_pattern, enabled) values
  ('minimax', 'MiniMax', array['api.minimaxi.com'], 'MiniMax-%', true),
  ('deepseek', 'DeepSeek', array['api.deepseek.com'], 'deepseek-%', true),
  ('xiaomi', '小米MiMo', array['token-plan-cn.xiaomimimo.com'], 'mimo-%', true),
  ('zhipu', '智谱GLM', array['open.bigmodel.cn'], 'glm-%', true),
  ('moonshot', 'Moonshot(Kimi)', array['api.moonshot.cn'], 'kimi-%', true),
  ('qwen', '通义千问', array['dashscope.aliyuncs.com'], 'qwen-%', true)
on conflict (provider_key) do nothing;

-- 其余模型商如需开放（默认 disabled，仅可自用不可入池），按同结构 INSERT：
--   openai(api.openai.com) / anthropic(api.anthropic.com) / google(generativelanguage.googleapis.com)
--   / mistral(api.mistral.ai) / groq(api.groq.com) / doubao(ark.cn-beijing.volces.com)
--   / baidu(qianfan.baidubce.com) / siliconflow(api.siliconflow.cn) / xai(api.x.ai)

-- ---------- 4. 模型定价系数（rate_rules）----------
-- 语义：model_pattern 精确行优先于前缀兜底行（大小写不敏感）；
--       coefficient = 积分系数（以 MiniMax=1.0 为基准，按 3×输入+1×输出加权价换算，可自定）；
--       tokens_per_point = 1 积分对应的基准 token 数（展示/旧链路用）
insert into public.rate_rules (provider_key, model_pattern, tokens_per_point, coefficient, enabled) values
  ('minimax',  'MiniMax-%',        100000, '1.0',  true),
  ('minimax',  'MiniMax-M3',       100000, '1.0',  true),
  ('deepseek', 'deepseek-%',        70000, '0.9',  true),
  ('deepseek', 'deepseek-v4-pro',  100000, '0.9',  true),
  ('deepseek', 'deepseek-v4-flash',100000, '0.3',  true),
  ('xiaomi',   'mimo-%',           100000, '0.3',  true),
  ('xiaomi',   'mimo-v2.5-pro',    100000, '1.0',  true),
  ('zhipu',    'glm-%',             26000, '3.4',  true),
  ('zhipu',    'GLM-5.2',          100000, '3.5',  true),
  ('moonshot', 'kimi-%',            10500, '2.1',  true),
  ('moonshot', 'Kimi-K3',          100000, '11.0', true),
  ('qwen',     'qwen-%',           300000, '1.0',  true),
  ('qwen',     'qwen-max',         100000, '5.0',  true)
on conflict do nothing;

-- ---------- 5. 本地密钥（app_config.field_key）----------
-- 用于服务端本地加密/签名（非 pgsodium），请勿照抄示例值！
-- 生成方式（服务器上执行）：openssl rand -hex 32
-- 然后执行：
--   insert into public.app_config (key, value) values ('field_key', '<上面生成的 64 位 hex>')
--   on conflict (key) do update set value = excluded.value;
-- ⚠️ 泄露该值等同于泄露加密密钥，务必只保留在 Supabase 与服务器 .env 之外的安全位置。
