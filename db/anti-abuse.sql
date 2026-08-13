-- ShareToken 防滥用限制 SQL
-- 在 Supabase Dashboard > SQL Editor 中执行
-- ⚠️ 2026-08-10 更新：create_llm_key 已重写为 4 参 + pgp 加密版本（见 fix-v3.sql），
--    本文件中的函数仅保留防滥用语义说明，实际定义以 fix-v3.sql 为准。

-- 1. create_llm_key 加 20 个 key 上限
-- 现定义：public.create_llm_key(p_provider text, p_base_url text, p_api_key text, p_note text)
-- 内部逻辑：auth.uid() 校验 → 20 上限 → pgp_sym_encrypt 加密 → 返回 id
-- 完整 SQL 见 db/fix-v3.sql 第 3 节

-- 2. 贡献表加 5 个上限触发器
CREATE OR REPLACE FUNCTION public.check_contrib_limit()
RETURNS TRIGGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.pool_contributions
  WHERE user_id = NEW.user_id AND status = 'active';
  IF v_count >= 5 THEN
    RAISE EXCEPTION 'Contribution limit reached: maximum 5 active contributions per user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_contrib_limit ON public.pool_contributions;
CREATE TRIGGER trg_contrib_limit
  BEFORE INSERT ON public.pool_contributions
  FOR EACH ROW EXECUTE FUNCTION public.check_contrib_limit();

-- 3. 平台 key 唯一性：每用户一把在用 key
-- ⚠️ 2026-08-10 修正：全量唯一 → active-only 唯一（fix-v3.sql 第 7 节）
--    drop index pool_keys_one_per_user;
--    create unique index pool_keys_one_per_user_active on pool_keys(user_id) where status='active';

-- 4. 贡献查重: 同一个 key_id 只能有一条 active 贡献
CREATE UNIQUE INDEX IF NOT EXISTS idx_contrib_unique_key
ON public.pool_contributions (key_id)
WHERE status = 'active';
