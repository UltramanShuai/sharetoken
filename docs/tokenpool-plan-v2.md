# TokenPool 方案 v2（当前生效版）2026-08-10

## 五项拍板
1. 自研 Node 网关
2. 汇率：MiniMax 官方 1000w token=1积分为锚，其他模型按等价折算，存 rate_rules 表可配置，全部默认 disabled 待审核启用
3. 日免费额度：默认 10w token/人/天
4. 积分出口：仅兑换额度（L1-L4 档位）
5. MVP 仅支持 OpenAI 兼容端点

## 汇率表初始值（tokens_per_point）
MiniMax-*: 10000000（基准锚，enabled）
deepseek-*: 7000000（disabled）
glm-*: 2600000（disabled）
kimi-*: 1050000（disabled）
qwen-*: 30000000（disabled）
gpt-*: 1170000（disabled）
claude-*: 600000（disabled）

## 贡献准入白名单（allowed_models）
三重关卡：域名关（base_url host 必须命中官方域名）+ 模型关（pattern 匹配）+ 开关关（rate_rules.enabled）
首期白名单：
- MiniMax: api.minimaxi.com / api.minimax.chat → MiniMax-*
- DeepSeek: api.deepseek.com → deepseek-*
- 智谱: open.bigmodel.cn → glm-*
- Moonshot: api.moonshot.cn → kimi-*
- 通义: dashscope.aliyuncs.com → qwen-*
个人 llm_keys 保管箱不受白名单限制，只有进池这一步被卡。

## 积分档位（reward_tiers，可配置）
L1: 0积分 → 10w token/天
L2: 2积分 → 20w + 繁忙优先
L3: 10积分 → 50w
L4: 50积分 → 100w + 新模型内测

## key 加密方案
llm_keys.api_key 用 pgcrypto 加密存储；
前端显示/复制走 RPC reveal_llm_key(key_id)（security definer，校验 auth.uid()=user_id）；
网关用 service key 调同一 RPC 取明文转发。

## 数据库表清单（二期建库）
1. llm_keys（已有，加健康字段）
2. pool_contributions（贡献记录）
3. pool_keys（平台分发key，只存hash）
4. usage_events（用量流水）
5. points_ledger（积分账本，只增不改）
6. health_checks（健康检查记录）
7. admin_audit（管理操作审计）
8. rate_rules（汇率配置，你可直接改）
9. reward_tiers（档位配置，你可直接改）
10. reward_config（全局开关，如日积分上限/冷静期）
11. allowed_models（贡献准入白名单）
