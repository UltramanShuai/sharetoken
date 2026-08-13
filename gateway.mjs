// TokenPool Gateway v3 - 2026-08-12 上线加固
// 改动：
//   - 上游 fetch 增加明确 AbortController 超时（270s，略低于 nginx 300s）
//     每次 attempt 各自启 / 清 timer，超时可重试；与 nginx timeout 配合避免互相截断
//   - keyRateMap / ipRateMap 增加定时清理并 unref，避免 Map 永久增长
//   - 客户端断开时中止上游 fetch 并释放并发槽，避免后台请求与全局并发被占死
//   - API contract 不变
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
const dir = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const SB_URL = env.SUPABASE_URL, SB_KEY = env.SUPABASE_SERVICE_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const PORT = 20140, MAX_RETRIES = 2;
// ⚠️ 全局兜底最先注册：Supabase 抖动时单个请求失败不能崩进程（Node22 unhandledRejection 默认杀进程）
process.on('uncaughtException', (e) => { console.error(new Date().toISOString(), 'gateway uncaught:', String(e && e.message || e).slice(0, 200)); });
process.on('unhandledRejection', (e) => { console.error(new Date().toISOString(), 'gateway unhandled:', String(e && e.message || e).slice(0, 200)); });
// LKGP 粘性缓存：model -> { contribId, ts }
const stickyMap = new Map();
const STICKY_TTL = 300000; // 5分钟粘性

// 速率限制：per-key 按等级 rpm，per-IP 120rpm，全局并发50
const keyRateMap = new Map();   // poolKeyId -> [timestamps]
const ipRateMap = new Map();    // ip -> [timestamps]
let globalConcurrent = 0;
const IP_RPM = 120, MAX_CONCURRENT = 50;
function rateLimit(poolKeyId, ip, keyRpm) {
  const now = Date.now();
  const windowMs = 60000;
  keyRpm = keyRpm || 60;
  // per-key
  let kt = keyRateMap.get(poolKeyId) || [];
  kt = kt.filter(t => now - t < windowMs);
  if (kt.length >= keyRpm) return { ok: false, msg: 'Key rate limit: ' + keyRpm + '/min' };
  // per-ip
  let it = ipRateMap.get(ip) || [];
  it = it.filter(t => now - t < windowMs);
  if (it.length >= IP_RPM) return { ok: false, msg: 'IP rate limit: ' + IP_RPM + '/min' };
  // 全局并发
  if (globalConcurrent >= MAX_CONCURRENT) return { ok: false, msg: 'Server busy, try later' };
  // 记录
  kt.push(now); keyRateMap.set(poolKeyId, kt);
  it.push(now); ipRateMap.set(ip, it);
  return { ok: true };
}
// ⚠️ 防负数下溢：全局并发被多次自减会变负，污染未来并发统计
function rateLimitEnd() { if (globalConcurrent > 0) globalConcurrent--; else globalConcurrent = 0; }

// ⚠️ 定期清理速率 Map：未活跃 entry 立即删除；活跃 entry 裁剪到 60s 窗口。
// unref() 让该 timer 不阻塞进程退出（与 process.exit / SIGINT 配合）
const RATE_CLEANUP_INTERVAL_MS = 60000;
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  const windowMs = 60000;
  for (const [k, arr] of keyRateMap) {
    if (!arr || !arr.length) { keyRateMap.delete(k); continue; }
    const filtered = arr.filter(t => now - t < windowMs);
    if (filtered.length) keyRateMap.set(k, filtered); else keyRateMap.delete(k);
  }
  for (const [k, arr] of ipRateMap) {
    if (!arr || !arr.length) { ipRateMap.delete(k); continue; }
    const filtered = arr.filter(t => now - t < windowMs);
    if (filtered.length) ipRateMap.set(k, filtered); else ipRateMap.delete(k);
  }
  // 兜底：连续成功不会让 Map 增长失控；持续失败的旧 entry 也被回收
}, RATE_CLEANUP_INTERVAL_MS);
if (rateCleanupTimer.unref) rateCleanupTimer.unref();

// ⚠️ 全局缓存 TTL 惰性清理：tierCache / stickyMap / coeffCache / tiersCache / modelsCache /
//   _allowedHostsCache 都采用读时 TTL 判断、但 Map 自身只增不减，长期运行会缓慢渗漏。
//   这里每 10 分钟惰性扫一遍，只删过期项，unref() 不阻塞进程退出。
//   - tierCache / stickyMap：逐条读 ts，过期 delete
//   - tiersCache / coeffCache / modelsCache / _allowedHostsCache：整体 at 时间戳判断，过期置空
//   - contribsCache（同上）
const CACHE_GC_INTERVAL_MS = 600000; // 10 min
const cacheGcTimer = setInterval(() => {
  const now = Date.now();
  // tierCache：userId -> { ts, tier }
  for (const [k, v] of tierCache) { if (!v || (now - v.ts) >= TIER_TTL) tierCache.delete(k); }
  // stickyMap：model -> { contribId, ts }
  for (const [k, v] of stickyMap) { if (!v || (now - v.ts) >= STICKY_TTL) stickyMap.delete(k); }
  // 整体过期缓存：时间戳超期直接清空（下次读触发重拉）
  if (tiersCache && (now - tiersCacheAt) >= TIER_TTL) { tiersCache = null; tiersCacheAt = 0; }
  if (coeffCache && (now - coeffCacheAt) >= 300000) { coeffCache = null; coeffCacheAt = 0; }
  if (modelsCache && (now - modelsCacheAt) >= 300000) { modelsCache = null; modelsCacheAt = 0; }
  if (_allowedHostsCache && (now - _allowedHostsCacheAt) >= 30000) { _allowedHostsCache = null; _allowedHostsCacheAt = 0; }
  if (contribsCache.rows && (now - contribsCache.at) >= CONTRIBS_TTL_MS) { contribsCache.rows = null; contribsCache.at = 0; }
}, CACHE_GC_INTERVAL_MS);
if (cacheGcTimer.unref) cacheGcTimer.unref();

// /v1/models 缓存
let modelsCache = null, modelsCacheAt = 0;
// Supabase REST helpers with 10s timeout（超时/网络错误可读化，不裸抛 AbortError）
async function jf(url, opt) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
  try { return await fetch(url, Object.assign({ signal: c.signal }, opt)); }
  catch (e) { throw new Error('fetch failed: ' + (e && e.name === 'AbortError' ? 'timeout>10000ms' : String(e && e.message || e)).slice(0, 150)); }
  finally { clearTimeout(t); }
}
async function sbGet(p) { const r = await jf(SB_URL + p, { headers: H }); if (!r.ok) throw new Error('GET ' + r.status); return r.json(); }
async function sbRpc(n, b) { const r = await jf(SB_URL + '/rest/v1/rpc/' + n, { method: 'POST', headers: H, body: JSON.stringify(b) }); if (!r.ok) throw new Error('RPC ' + n + ' ' + r.status); const txt = await r.text(); return txt ? JSON.parse(txt) : null; }
async function sbPatch(t, q, p) { const r = await jf(SB_URL + '/rest/v1/' + t + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify(p) }); if (!r.ok) throw new Error('PATCH ' + t + ' ' + r.status); }
async function sbPost(t, row) { const r = await jf(SB_URL + '/rest/v1/' + t, { method: 'POST', headers: Object.assign({}, H, { Prefer: 'return=representation' }), body: JSON.stringify(row) }); if (!r.ok) throw new Error('POST ' + t + ' ' + r.status); const j = await r.json(); return Array.isArray(j) ? j[0] : j; }
async function sha256hex(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
async function authPoolKey(bearer) {
  if (!bearer || !bearer.startsWith('pk_')) return null;
  const hash = await sha256hex(bearer);
  const rows = await sbGet('/rest/v1/pool_keys?key_hash=eq.' + hash + '&select=id,user_id,daily_quota,used_today,status');
  if (!rows.length) return null;
  const k = rows[0];
  return k.status === 'active' ? k : null;
}
// 等级体系：按累计贡献 token（含 withdrawn）算等级，每日额度/速率随等级（60s 缓存）
const tierCache = new Map();    // userId -> { ts, tier }
const TIER_TTL = 60000;
let tiersCache = null, tiersCacheAt = 0;
async function getTiers() {
  const now = Date.now();
  if (tiersCache && now - tiersCacheAt < TIER_TTL) return tiersCache;
  const rows = await sbGet('/rest/v1/reward_tiers?select=level,min_contributed_tokens,daily_quota,perks&order=level.asc');
  tiersCache = rows; tiersCacheAt = now;
  return rows;
}
async function getTier(userId) {
  const now = Date.now();
  const hit = tierCache.get(userId);
  if (hit && now - hit.ts < TIER_TTL) return hit.tier;
  let contributed = 0;
  try {
    const ids = await sbGet('/rest/v1/pool_contributions?user_id=eq.' + userId + '&select=id');
    if (ids.length) {
      const idList = ids.map(x => x.id).join(',');
      const us = await sbGet('/rest/v1/usage_events?select=total_tokens&status=eq.success&contribution_id=in.(' + idList + ')');
      contributed = us.reduce((s, u) => s + Number(u.total_tokens || 0), 0);
    }
  } catch {}
  const tiers = await getTiers();
  let tier = tiers[0] || { level: 1, daily_quota: 10000000, perks: {} };
  for (const t of tiers) { if (contributed >= Number(t.min_contributed_tokens)) tier = t; }
  const data = { level: tier.level, quota: Number(tier.daily_quota), rpm: Number((tier.perks || {}).rpm) || 60 };
  tierCache.set(userId, { ts: now, tier: data });
  return data;
}
// 模型系数（按价值比例，MiniMax=1.0）：rate_rules.coefficient，300s 缓存，未匹配 fallback 1.0
let coeffCache = null, coeffCacheAt = 0;
async function getCoefficient(model) {
  const now = Date.now();
  if (!coeffCache || now - coeffCacheAt > 300000) {
    try { coeffCache = await sbGet('/rest/v1/rate_rules?enabled=eq.true&select=provider_key,model_pattern,coefficient'); coeffCacheAt = now; }
    catch { if (!coeffCache) coeffCache = []; }
  }
  const ml = String(model || '').toLowerCase();
  // 匹配：精确模型名 > 最长前缀 > 默认 1.0（全部大小写不敏感）
  let best = null, bestLen = -1;
  for (const r of coeffCache) {
    const p = (r.model_pattern || '').replace(/[%*]$/, '').toLowerCase();
    if (!p) continue;
    if (ml === p) { best = r; break; }  // 精确命中优先
    if (ml.startsWith(p) && p.length > bestLen) { best = r; bestLen = p.length; }
  }
  return best ? (Number(best.coefficient) || 1.0) : 1.0;
}
// 用户积分余额（user_points 表）
async function getBalance(userId) {
  try {
    const rows = await sbGet('/rest/v1/user_points?user_id=eq.' + userId + '&select=balance');
    return rows.length ? Number(rows[0].balance || 0) : 0;
  } catch { return null; }
}
// 用户维度今日已用：所有平台 key（含 disabled 旧 key）的 used_today 之和
// 重置 key 不清零当日用量，避免重置一次刷新一次额度
async function getUserUsedToday(userId) {
  const rows = await sbGet('/rest/v1/pool_keys?user_id=eq.' + userId + '&select=used_today');
  return rows.reduce((s, r) => s + Number(r.used_today || 0), 0);
}
// LKGP 选路：粘性优先，额度用完/不健康才换；优先路由到别人的贡献（自用作为兑底）
// ⚠️ 30s TTL 缓存：active 贡献列表每请求全表拉会撞 Supabase 配额；30s 是池统计可接受的过期窗口；
//   失效时重拉并刷新时间戳；保持返回结构与原始实现一致（仍是单条 contrib 对象）。
const contribsCache = { rows: null, at: 0 };
const CONTRIBS_TTL_MS = 30000;
async function loadActiveContribs() {
  const now = Date.now();
  if (contribsCache.rows && now - contribsCache.at < CONTRIBS_TTL_MS) return contribsCache.rows;
  const rows = await sbGet('/rest/v1/pool_contributions?status=eq.active&select=id,key_id,user_id,model_pattern,daily_cap_tokens,used_today,five_hour_cap_tokens,used_five_hour,five_hour_window_start,total_cap_tokens,total_used_tokens,expires_at,health_status,last_success_at');
  contribsCache.rows = rows;
  contribsCache.at = now;
  return rows;
}
async function pickContribution(model, excludeIds, ownerId) {
  const contribs = await loadActiveContribs();
  const now = Date.now();
  const eligible = contribs.filter(c => {
    if (excludeIds.includes(c.key_id)) return false;
    // 合计用满 / 到期：自动撤回（异步，不阻塞选路）
    const autoWithdraw = (c.total_cap_tokens && Number(c.total_used_tokens) >= Number(c.total_cap_tokens)) || (c.expires_at && new Date(c.expires_at).getTime() < now);
    if (autoWithdraw) {
      // ⚠️ 不再静默：失败要可见（用户期望"自动撤回"实际生效，否则额度永远显示用满）
      sbPatch('pool_contributions', 'id=eq.' + c.id, { status: 'withdrawn', updated_at: new Date().toISOString() })
        .catch((e) => console.error(new Date().toISOString(), 'auto-withdraw failed:', c.id.slice(0, 8), String(e && e.message || e).slice(0, 160)));
      return false;
    }
    if (c.daily_cap_tokens && Number(c.used_today) >= Number(c.daily_cap_tokens)) return false;
    // 5 hour window check
    if (c.five_hour_cap_tokens && Number(c.used_five_hour) >= Number(c.five_hour_cap_tokens)) return false;
    if (c.expires_at && new Date(c.expires_at).getTime() < now) return false;
    if (c.total_cap_tokens && Number(c.total_used_tokens) >= Number(c.total_cap_tokens)) return false;
    if (c.health_status === 'down') return false;
    const pat = c.model_pattern || '*';
    if (pat === '*') return true;
    // 大小写不敏感匹配（贡献模型名与调用模型名可能大小写不同，如 deepseek-v4-flash vs DeepSeek-V4-Flash）
    return model.toLowerCase().startsWith(pat.replace(/[%*]$/, '').toLowerCase());
  });
  if (!eligible.length) return null;
  // 优先使用别人的贡献：自己的贡献作为兑底（避免自用消耗自身额度）
  const others = ownerId ? eligible.filter(c => c.user_id !== ownerId) : [];
  const pool = others.length ? others : eligible;
  // Provider 偏好：按模型名前缀匹配 provider，优先路由到同 provider 的贡献
  const providerPrefixes = {
    'deepseek-': 'api.deepseek.com',
    'MiniMax-': 'api.minimaxi.com',
    'glm-': 'open.bigmodel.cn',
    'kimi-': 'api.moonshot.cn',
    'qwen-': 'dashscope.aliyuncs.com',
    'gpt-': 'api.openai.com',
    'claude-': 'api.anthropic.com',
    'gemini-': 'generativelanguage.googleapis.com',
    'mistral-': 'api.mistral.ai',
    'grok-': 'api.x.ai',
    'mimo-': 'token-plan-cn.xiaomimimo.com',
    'ernie-': 'qianfan.baidubce.com',
    'doubao-': 'ark.cn-beijing.volces.com'
  };
  let preferredHost = null;
  // ⚠️ 模型名与前缀均做大小写归一化，避免 "DeepSeek-V4-Flash" 等大写模型命中失败
  const ml = model.toLowerCase();
  for (const prefix in providerPrefixes) {
    if (ml.startsWith(prefix.toLowerCase())) { preferredHost = providerPrefixes[prefix]; break; }
  }
  if (preferredHost) {
    // 批量查贡献对应 key 的 base_url（N+1 → 一次 in 查询）
    const ids = pool.map(c => c.key_id).join(',');
    let keyRows = [];
    try { keyRows = await sbGet('/rest/v1/llm_keys?id=in.(' + ids + ')&select=id,base_url'); } catch {}
    const hostMap = new Map();
    for (const kr of keyRows) { try { hostMap.set(kr.id, new URL(kr.base_url).hostname); } catch {} }
    const matched = pool.filter(c => hostMap.get(c.key_id) === preferredHost);
    if (matched.length) {
      // 在匹配的子集中做 LKGP
      const sticky = stickyMap.get(model);
      if (sticky && Date.now() - sticky.ts < STICKY_TTL) {
        const found = matched.find(c => c.id === sticky.contribId);
        if (found) return found;
      }
      const weights = matched.map(c => Math.max(Number(c.daily_cap_tokens) - Number(c.used_today), 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < matched.length; i++) { r -= weights[i]; if (r <= 0) return matched[i]; }
      return matched[matched.length - 1];
    }
  }
  // LKGP：先查粘性
  const sticky = stickyMap.get(model);
  if (sticky && now - sticky.ts < STICKY_TTL) {
    const found = pool.find(c => c.id === sticky.contribId);
    if (found) return found;
  }
  // 无粘性或粘性失效：加权随机（剩余额度 + 最近成功加分）
  const weights = pool.map(c => {
    let w = Number(c.daily_cap_tokens) - Number(c.used_today);
    if (c.last_success_at) {
      const ageMin = (now - new Date(c.last_success_at).getTime()) / 60000;
      if (ageMin < 10) w *= 3; // 最近10分钟成功过的权重x3
    }
    return Math.max(w, 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}
function extractUsage(body, isStream, sc) {
  if (!isStream && body && body.usage) return {prompt:body.usage.prompt_tokens||0,completion:body.usage.completion_tokens||0,total:body.usage.total_tokens||(body.usage.prompt_tokens+body.usage.completion_tokens),exact:true};
  if (isStream && sc && sc.length) { for (let i=sc.length-1;i>=0;i--) { try{const o=JSON.parse(sc[i].replace(/^data:\s*/,''));if(o.usage)return{prompt:o.usage.prompt_tokens||0,completion:o.usage.completion_tokens||0,total:o.usage.total_tokens||0,exact:true};}catch{} } }
  return {prompt:0,completion:0,total:0,exact:false};
}
async function recordUsage(pk,contrib,model,usage,lat,status) {
  const t=usage.total||0;
  // ⚠️ 模型名归一化：小写后入库，避免 'DeepSeek-V4-Flash' 与 'deepseek-v4-flash' 被记成两条记录
  //   影响 my_usage_stats RPC 的模型分组、用户贡献模型列表、运维健康看板等下游聚合；
  //   pickContribution 内部也仅以小写比较，原始大小写仅是显示语义。
  const modelNorm = String(model || '').toLowerCase();
  try {
    // 原子计数（并发安全）：SQL 内自增，5小时窗口库内判定
    await sbRpc('update_usage_counters',{p_pool_key_id:pk.id,p_contribution_id:contrib.id,p_t:t});
    // 先插 usage_event 拿到 id（后续积分流水用它做幂等键）
    const ue = await sbPost('usage_events',{pool_key_id:pk.id,contribution_id:contrib.id,model:modelNorm,prompt_tokens:usage.prompt,completion_tokens:usage.completion,total_tokens:t,latency_ms:lat,status,is_metered_exact:usage.exact,is_self_use:!!(pk.user_id&&pk.user_id===contrib.user_id),created_at:new Date().toISOString()});
    const ueid = ue && ue.id ? ue.id : null;
    if (status==='success'&&t>0) {
      // v4 积分：赚 = token×系数，花 = token×系数×2（self-use 照常，自刷净亏=系数）
      const coeff = await getCoefficient(modelNorm);
      const earn = t * coeff;
      const cost = t * coeff * 2;
      if (ueid && earn > 0) await sbRpc('adjust_points',{p_user_id:contrib.user_id,p_delta:earn,p_reason:'usage_reward',p_ref:ueid});
      if (ueid && cost > 0) await sbRpc('adjust_points',{p_user_id:pk.user_id,p_delta:-cost,p_reason:'usage_spend',p_ref:ueid});
    }
  } catch(e){console.error('recordUsage:',String(e).slice(0,200));}
}
// /v1/models：聚合池内可调用模型（active 贡献的 model_pattern，去重），5分钟缓存
async function getModelsList() {
  const now = Date.now();
  if (modelsCache && now - modelsCacheAt < 300000) return modelsCache;
  try {
  const contribs = await sbGet('/rest/v1/pool_contributions?status=eq.active&select=id,key_id,model_pattern,health_status');
  const healthy = contribs.filter(c => c.health_status !== 'down');
  const modelSet = new Set();
  for (const c of healthy) {
    // ⚠️ 排除所有通配/未明确模型：trim 后为空、含 % 或 * 的都不对外暴露
    const raw = (c.model_pattern || '').trim();
    if (!raw || /[%*]/.test(raw)) continue;
    modelSet.add(raw);
  }
  modelsCache = Array.from(modelSet).sort().map(id => ({ id, object: 'model' }));
  modelsCacheAt = now;
  return modelsCache;
  } catch (e) {
    // ⚠️ 失败不刷新时间戳：上次成功的快照必须按原 TTL 过期，避免长时间重复返回“看似新鲜”的旧数据
    // （之前实现会刷新 at，导致上游持续故障时用户模型列表不断“重启”计时器，
    //   永远不重新拉取下游、也看不见新的健康贡献）。
    // 仅保留旧缓存“本身”读一次（供当场返回），时间戳不变；下次调用会重新走重拉逻辑。
    console.error(new Date().toISOString(), 'models rebuild fail:', String(e && e.message || e).slice(0, 120));
    if (modelsCache) return modelsCache;
    throw e;
  }
}
// ⚠️ v5.2 防御性 D：网关侧硬校验上游 base_url（与 DB trigger 第二道防线）
//   - https only；no userinfo/query/hash
//   - host 必须命中 enabled allowed_models.allowed_hosts 白名单（hostname 精确匹配）
//   - host 不能是 localhost / 环回 / 私网 / link-local / 内部域名
//   残余风险：白名单可能与 DB 不同步（缓存 30s）；DNS rebinding（单次 fetch 内 hostname resolve 后 IP 可能变）
//     —— 残余已在 DEPLOY.MANIFEST 明确列出
async function loadAllowedHostsForGateway() {
  try {
    const rows = await sbGet('/rest/v1/allowed_models?enabled=eq.true&select=allowed_hosts');
    const set = new Set();
    for (const r of rows || []) {
      for (const h of (r.allowed_hosts || [])) set.add(String(h).toLowerCase());
    }
    return set;
  } catch (e) {
    // fail-closed：白名单拉不到时拒绝所有 upstream，避免走未知主机
    console.error('gateway: loadAllowedHosts failed:', String(e && e.message || e).slice(0, 120));
    return null;
  }
}
let _allowedHostsCache = null;
let _allowedHostsCacheAt = 0;
async function getAllowedHosts() {
  const now = Date.now();
  if (!_allowedHostsCache || now - _allowedHostsCacheAt > 30000) {
    _allowedHostsCache = await loadAllowedHostsForGateway();
    _allowedHostsCacheAt = now;
  }
  return _allowedHostsCache;
}
function validateUpstreamBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: 'parse' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'protocol-not-https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (u.search) return { ok: false, reason: 'query' };
  if (u.hash) return { ok: false, reason: 'hash' };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'no-host' };
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return { ok: false, reason: 'localhost' };
  if (/^10\./.test(host)) return { ok: false, reason: 'private-10' };
  if (/^192\.168\./.test(host)) return { ok: false, reason: 'private-192' };
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return { ok: false, reason: 'private-172' };
  if (/^169\.254\./.test(host)) return { ok: false, reason: 'link-local' };
  // ⚠️ IPv6 私网/特殊段（仅 ::1 不够）：
  //   fc00::/7（ULA 唯一本地地址，含 fc00:: 和 fd00::）+ fe80::/10（IPv6 link-local）
  //   + ::ffff:0:0/96 IPv4-mapped（含 ::ffff:127.0.0.1、::ffff:10.x 等环回/私网）
  //   + 100::/64（discard prefix，仅黑洞地址）+ ::/128（unspecified）+ ff00::/8（multicast）
  // 注意：Node URL API 的 hostname 含方括号（[fc00::1]）和 IPv4-mapped 会被 normalize 成 hex
  // （::ffff:127.0.0.1 → ::ffff:7f00:1），需在正则匹配前去括号、另检 ::ffff: 变体。
  const hostNoBrackets = host.replace(/^\[|\]$/g, '');
  if (/^::1$/.test(hostNoBrackets)) return { ok: false, reason: 'ipv6-loopback' };
  if (/^fc[0-9a-f]{2}:/i.test(hostNoBrackets) || /^fd[0-9a-f]{2}:/i.test(hostNoBrackets)) return { ok: false, reason: 'ipv6-ula' };
  if (/^fe[89ab][0-9a-f]?:/i.test(hostNoBrackets)) return { ok: false, reason: 'ipv6-link-local' };
  if (/^::ffff:/i.test(hostNoBrackets) || /^::ffff:[0-9a-f]+:[0-9a-f]+$/i.test(hostNoBrackets)) return { ok: false, reason: 'ipv4-mapped' };
  if (/^100:[0-9a-f]?:/i.test(hostNoBrackets)) return { ok: false, reason: 'ipv6-discard' };
  if (/^::$/.test(hostNoBrackets)) return { ok: false, reason: 'ipv6-unspecified' };
  if (/^ff[0-9a-f]{2}:/i.test(hostNoBrackets)) return { ok: false, reason: 'ipv6-multicast' };
  if (host.endsWith('.internal') || host.endsWith('.local')) return { ok: false, reason: 'internal-tld' };
  // ⚠️ 只允许默认端口（443）；非默认端口会让攻击者接 LAN 主机上伪造的服务
  if (u.port && u.port !== '443') return { ok: false, reason: 'non-default-port' };
  // ⚠️ 保留 base path（防丢 /v1）；路径白名单（含智谱 /api/paas/v4），其余拒绝
  let pathname = (u.pathname || '/').replace(/\/+$/, '');
  const allowedPaths = ['', '/v1', '/api', '/api/paas/v4'];
  if (!allowedPaths.includes(pathname.toLowerCase())) return { ok: false, reason: 'deep-path' };
  const baseUrl = 'https://' + host + pathname;
  return { ok: true, host, baseUrl };
}

// ⚠️ 上游 fetch + body drain 合并为单一 deadline 任务：
//   - 自调用起到整个响应体消费结束，全过程受 UPSTREAM_TIMEOUT_MS 限制
//   - SSE 客户端断开 → 立即 cancel reader，释放上游连接
//   - SSE 超时 → 立即 cancel reader，记 UPSTREAM_TIMEOUT（可重试）
//   - 每次 reader.read() 前重设 timer 到剩余 deadline，避免单次长读堵塞
//   - 非流响应 upResp.text() 也走同一 deadline
//   - opts.totalBudgetMs（测试用）：直接覆盖默认 270s
//   - opts.onHeaders（流模式）：upResp.ok 确认后、第一行 line 写出前调用；调用方负责
//     res.writeHead(200)，保证 4xx/5xx 时仍未对客户端承诺 200，可透明切到另一个 upstream
// 这样与 nginx proxy_read_timeout 300s 配合：网关在 270s 内主动 cancel，nginx 不会二次截断；
// 上游返回 headers 后慢速/挂起 body 仍会被 deadline 触发，避免后台连接无限占死。
const UPSTREAM_TIMEOUT_MS = 270000;

// ⚠️ 新代码统一走 upstreamFetchAndConsume 覆盖整个响应消费周期；
// 旧 upstreamFetchWithTimeout（仅 fetch 阶段、不含 body drain）已删除。
async function upstreamFetchAndConsume(url, init, clientSignal, opts) {
  opts = opts || {};
  const isStream = !!opts.isStream;
  const onStreamLine = opts.onStreamLine || null;
  const onHeaders = opts.onHeaders || null;
  const totalBudget = (typeof opts.totalBudgetMs === 'number' && opts.totalBudgetMs > 0)
    ? opts.totalBudgetMs
    : UPSTREAM_TIMEOUT_MS;
  const startTime = Date.now();
  let timedOut = false;
  const ctrl = new AbortController();

  const makeClientClosedErr = () => { const e = new Error('client disconnected'); e.code = 'CLIENT_CLOSED'; return e; };
  const makeTimeoutErr = () => { const e = new Error('upstream timeout>' + totalBudget + 'ms'); e.code = 'UPSTREAM_TIMEOUT'; return e; };
  const classifyErr = (e) => {
    if (clientSignal && clientSignal.aborted) return makeClientClosedErr();
    if (timedOut || (e && e.name === 'AbortError')) return makeTimeoutErr();
    return e;
  };

  let onClientAbort = null;
  if (clientSignal) {
    if (clientSignal.aborted) throw makeClientClosedErr();
    onClientAbort = () => ctrl.abort();
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }

  // 自适应 timer：每次 arm 都按"截止时间 - 当前时间"重设剩余值
  let timer = null;
  const armTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const remaining = startTime + totalBudget - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      ctrl.abort();
      return false;
    }
    timer = setTimeout(() => {
      timer = null;
      timedOut = true;
      ctrl.abort();
    }, remaining);
    return true;
  };

  try {
    // 1) 等待 headers（受 timer 约束）
    armTimer();
    let upResp;
    try {
      upResp = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
      if (timer) { clearTimeout(timer); timer = null; }
    } catch (e) {
      throw classifyErr(e);
    }

    // 上游返回 4xx/5xx → 不消费 body（直接交给调用方）
    if (!upResp.ok) {
      const eb = await upResp.text().catch(() => '');
      return { ok: false, status: upResp.status, body: eb };
    }

    if (isStream) {
      // 2a) SSE：逐块读取，client 断开或超时立即 cancel reader
      const reader = upResp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const sc = [];
      // ⚠️ 在第一行 line 写出前通知调用方发 headers（写 200）
      //   若调用方写 headers 失败（client closed 等）→ 立即 cancel reader 并抛错
      if (onHeaders) {
        try { await onHeaders(); }
        catch (e) {
          try { await reader.cancel(); } catch {}
          const err = (e && e.code) ? e : (() => { const x = new Error('client closed'); x.code = 'CLIENT_CLOSED'; return x; })();
          throw err;
        }
      }
      try {
        while (true) {
          if (clientSignal && clientSignal.aborted) {
            try { await reader.cancel(); } catch {}
            throw makeClientClosedErr();
          }
          if (!armTimer()) {
            try { await reader.cancel(); } catch {}
            throw makeTimeoutErr();
          }
          let rd;
          try {
            rd = await reader.read();
            if (timer) { clearTimeout(timer); timer = null; }
          } catch (e) {
            try { await reader.cancel(); } catch {}
            throw classifyErr(e);
          }
          if (rd.done) break;
          buf += dec.decode(rd.value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const ln of lines) {
            sc.push(ln);
            if (onStreamLine) {
              try { await onStreamLine(ln); } catch (e) {
                // 写入客户端失败（EPIPE 等）→ 视同 client 断开
                try { await reader.cancel(); } catch {}
                throw makeClientClosedErr();
              }
            }
          }
        }
      } finally {
        if (timer) { clearTimeout(timer); timer = null; }
      }
      return { ok: true, isStream: true, status: upResp.status, sc, leftoverBuf: buf };
    }

    // 2b) 非流：一次性读 body，受同一 deadline 约束
    if (!armTimer()) throw makeTimeoutErr();
    let rt;
    try {
      rt = await upResp.text();
      if (timer) { clearTimeout(timer); timer = null; }
    } catch (e) {
      throw classifyErr(e);
    }
    return { ok: true, isStream: false, status: upResp.status, body: rt };
  } finally {
    if (timer) { clearTimeout(timer); timer = null; }
    if (clientSignal && onClientAbort) clientSignal.removeEventListener('abort', onClientAbort);
  }
}

// ⚠️ 旧 upstreamFetchWithTimeout 已删除：仅覆盖 fetch 阶段（不含 body drain），
//   与新代码路线不一致；全仓仅 gateway.mjs 内部被定义、且无外部 caller（见脚本仓 grep），
//   保留即变成不可达代码、推高维护面（v6 收敛）。生产路径统一走 upstreamFetchAndConsume。
const server = http.createServer(async (req, res) => {
  let concurrentAcquired = false;
  let clientClosed = false;
  const clientAbortController = new AbortController();
  const releaseConcurrency = () => {
    if (!concurrentAcquired) return;
    concurrentAcquired = false;
    rateLimitEnd();
  };
  const markClientClosed = () => {
    if (res.writableEnded || clientClosed) return;
    clientClosed = true;
    clientAbortController.abort();
    releaseConcurrency();
  };
  // IncomingMessage 的 close 也会在正常请求体读完后触发，不能用它判断断线。
  // aborted 负责请求体中断；ServerResponse close 负责响应完成前的客户端断开。
  req.on('aborted', markClientClosed);
  res.on('close', markClientClosed);
  // ⚠️ 移除 /v1/verify-turnstile：Cloudflare Turnstile token single-use (300s TTL)，
  //   同一个 token 先经网关预校验后被 Supabase Auth 拒绝。Supabase Auth 直接消费 token；
  //   取消该 endpoint 后 CAPTCHA 失败 / 成功全在 Supabase Auth 侧给出响应。
  // /v1/models 端点
  if (req.url === '/v1/models' && req.method === 'GET') {
    try {
      const models = await getModelsList();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({object:'list',data:models}));
    } catch(e) {
      res.writeHead(500); res.end('{"error":{"message":"Failed to list models"}}');
    }
    return;
  }
  if (!req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end('{"error":{"message":"Use /v1/chat/completions or /v1/models"}}'); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end('{"error":{"message":"Method not allowed"}}'); return; }
  try {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  // 客户端在 body 读完前断开：放弃本请求
  if (clientClosed) return;
  let reqBody;
  try { reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end('{"error":{"message":"Invalid JSON"}}'); return; }
  if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) { res.writeHead(400); res.end('{"error":{"message":"Request body must be a JSON object"}}'); return; }
  // ⚠️ 在占用限流资源之前验证，避免占坑后才发现参数非法
  const model = typeof reqBody.model === 'string' ? reqBody.model.trim() : '';
  if (!model) { res.writeHead(400); res.end('{"error":{"message":"Missing or invalid model"}}'); return; }
  if (Object.prototype.hasOwnProperty.call(reqBody, 'stream') && typeof reqBody.stream !== 'boolean') { res.writeHead(400); res.end('{"error":{"message":"stream must be a boolean"}}'); return; }
  const isStream = reqBody.stream === true;
  if (isStream) reqBody.stream_options = { include_usage: true };
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const poolKey = await authPoolKey(bearer);
  if (!poolKey) { res.writeHead(401); res.end('{"error":{"message":"Invalid platform key"}}'); return; }
  // 等级动态额度/速率
  let tier;
  try { tier = await getTier(poolKey.user_id); } catch { tier = { level: 1, quota: 10000000, rpm: 60 }; }
  // 用户维度今日已用（重置 key 不清零：所有平台 key 用量之和）
  let usedToday;
  try { usedToday = await getUserUsedToday(poolKey.user_id); } catch { usedToday = Number(poolKey.used_today || 0); }
  if (usedToday >= tier.quota) { res.writeHead(429); res.end('{"error":{"message":"Daily quota exceeded (L' + tier.level + ' ' + tier.quota + '/day)"}}'); return; }
  // v4：积分余额 > 0 才能使用（并发超扣允许小额欠费，下次请求自愈拒绝）
  const bal = await getBalance(poolKey.user_id);
  if (bal !== null && bal <= 0) { res.writeHead(403); res.end('{"error":{"message":"Insufficient points (balance ' + bal + '). Contribute a key to earn points"}}'); return; }
  // 速率限制
  const clientIp = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  const rl = rateLimit(poolKey.id, clientIp, tier.rpm);
  if (!rl.ok) { res.writeHead(429); res.end(JSON.stringify({error:{message:rl.msg}})); return; }
  globalConcurrent++;
  concurrentAcquired = true;
  // ⚠️ try/finally 语义确保 exactly-once 释放：无论哪条出口（正常返回 / 客户端断开 / 上游错 / 重试耗尽 /
  //   顶部未预期异常）都走同一个 finally 分支，concurrentAcquired flag 依然是首调需守卫，避免
  //   抢占前 markClientClosed 已提前 release 后再被 finally 减一次（防 globalConcurrent 负数）。
  //   多个出口手动 releaseConcurrency() 不再需要（但保留幂等能力，供 markClientClosed 等旁路调用）。
  try {
  // 占用限流后再次确认客户端未断开：断开则立即释放并发槽
  if (clientClosed) return;
  const exclude = [];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 每次 attempt 入口检查客户端断开
    if (clientClosed) return;
    const contrib = await pickContribution(model, exclude, poolKey.user_id);
    if (!contrib) { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'No contribution for: '+model}})); return; }
    let apiKey;
    try { apiKey = await sbRpc('reveal_llm_key_service', { p_key_id: contrib.key_id }); } catch { exclude.push(contrib.key_id); continue; }
    const kr = await sbGet('/rest/v1/llm_keys?id=eq.' + contrib.key_id + '&select=base_url');
    const baseUrl = (kr[0] && kr[0].base_url) || '';
    if (!baseUrl) { exclude.push(contrib.key_id); continue; }
    // ⚠️ v5.2 防御性 D：每次选路再次校验上游 URL（与 DB trigger 双重防线）
    //   - https only（防明文 API Key 经 HTTP 泄露）
    //   - 无 userinfo / query / hash
    //   - host 必须命中 enabled allowed_models.allowed_hosts
    //   - host 不能是 localhost / 私网 / link-local
    const v = validateUpstreamBaseUrl(baseUrl);
    if (!v.ok) {
      console.error('upstream base_url rejected:', v.reason, contrib.key_id.slice(0, 8));
      // 不动 health_status（避免误伤）；仅本轮排除
      exclude.push(contrib.key_id);
      continue;
    }
    // 白名单 hostname 精确匹配（防御 DB 旁路 / 配置漂移）
    const allowedHosts = await getAllowedHosts();
    if (!allowedHosts || !allowedHosts.has(v.host)) {
      console.error(allowedHosts ? 'upstream host not in allowed_models:' : 'upstream allowlist unavailable:', v.host, contrib.key_id.slice(0, 8));
      exclude.push(contrib.key_id);
      continue;
    }
    const upUrl = v.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const t0 = Date.now();
    // ⚠️ 流模式：不在这里 writeHead(200)。4xx/5xx 时客户端未被承诺 200，才能透明切到另一个 upstream；
    //   通过 onHeaders 回调，在 helper 确认 upResp.ok 后、第一行 SSE 写出前向客户端写 200。
    //   一旦写了 200，后续任何失败只能结束，不能切到另一个上游（拼接半截流）。
    let writeStreamLine = null;
    let writeStreamHeaders = null;
    if (isStream) {
      writeStreamHeaders = async () => {
        // 幂等：onHeaders 在每 attempt 入口都可能被代表调用（这里每个 attempt 各起一次 helper），
        // 防止同一 attempt 内重复写
        if (res.headersSent || res.writableEnded) return;
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      };
      writeStreamLine = async (line) => {
        // 客户端断开或响应已关闭 → 抛错让 helper 立即 cancel reader
        if (res.writableEnded || res.destroyed || clientClosed) {
          const e = new Error('client closed'); e.code = 'CLIENT_CLOSED'; throw e;
        }
        try {
          res.write(line + '\n');
        } catch (e) {
          const err = new Error('client write failed'); err.code = 'CLIENT_CLOSED'; throw err;
        }
      };
    }
    try {
      // ⚠️ 单一 deadline 覆盖整个响应消费周期（fetch + body drain）
      const r = await upstreamFetchAndConsume(
        upUrl,
        { method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKey}, body:JSON.stringify(reqBody) },
        clientAbortController.signal,
        { isStream, onStreamLine: writeStreamLine, onHeaders: writeStreamHeaders }
      );
      if (clientClosed) return;
      // 上游 4xx/5xx：helper 已读完 body
      if (!r.ok) {
        // 401/403 直接标 down（key 失效），其它 4xx/5xx 仅排除本轮
        if (r.status === 401 || r.status === 403) {
          try { await sbPatch('llm_keys','id=eq.'+contrib.key_id,{health_status:'down',last_error:'upstream '+r.status,fail_streak:5}); } catch {}
        }
        if (!isStream) {
          // 非流：把上游 body 透传给客户端
          res.writeHead(r.status, {'Content-Type':'application/json'});
          res.end(r.body);
          await recordUsage(poolKey, contrib, model, { total: 0, exact: true }, Date.now() - t0, 'upstream_error');
          return;
        }
        // 流：若响应头尚未向客户端发出（首次 4xx/5xx），不写 200、不写任何字节，
        //   直接排除本轮重试另一 upstream — 完全不保证客户端 200
        if (!res.headersSent) {
          exclude.push(contrib.key_id);
          continue;
        }
        // 流：headers 已发（理论上只有 onHeaders 成功后才可能 headersSent；
        //   防御性分支：避免助手预留场景或以后调整中泄露；遇到时只能结束以保护客户端
        try { res.end(); } catch {}
        await recordUsage(poolKey, contrib, model, { total: 0, exact: true }, Date.now() - t0, 'upstream_error');
        return;
      }
      const lat = Date.now() - t0;
      // 成功：更新粘性 + last_success_at（失败不影响主流程，避免丢弃已成功响应）
      stickyMap.set(model, { contribId: contrib.id, ts: Date.now() });
      try { await sbPatch('pool_contributions', 'id=eq.' + contrib.id, { last_success_at: new Date().toISOString() }); } catch (e) {}
      if (r.isStream) {
        if (r.leftoverBuf) { try { res.write(r.leftoverBuf + '\n'); } catch {} }
        try { res.end(); } catch {}
        // ⚠️ 并发槽由外层 finally 统一释放；DB 写不影响并发计数
        await recordUsage(poolKey, contrib, model, extractUsage(null, true, r.sc), lat, 'success');
      } else {
        res.writeHead(200, {'Content-Type':'application/json'});
        try { res.end(r.body); } catch {}
        let rj; try { rj = JSON.parse(r.body); } catch {}
        // 同上：响应已结束 → 外层 finally 释放槽，再做 DB 写
        await recordUsage(poolKey, contrib, model, extractUsage(rj, false, null), lat, 'success');
      }
      return;
    } catch(e) {
      if (e && e.code === 'CLIENT_CLOSED') {
        // ⚠️ 客户端断开：并发槽可能被 markClientClosed 释放过；此处幂等，最终由外层 finally 唯一释放点处理
        return;
      }
      // ⚠️ 上游超时是可重试的（视为该 Key 网络不稳，不立即标 down）
      //   关键：并发槽必须在重试间保持占用；本 attempt 期间拿的 slot 覆盖整个请求，
      //   释放点只能是“响应写完 / 客户端断开 / 全部重试失败 / 顶层 catch”这 4 个出口（现在统一收口在 finally）。
      if (e && e.code === 'UPSTREAM_TIMEOUT') {
        console.error('upstream timeout:', contrib.key_id.slice(0,8));
        // 若响应头已发（流模式下 onHeaders 已写 200），则无法透明切到另一上游；只能结束。
        if (res.headersSent) { try { res.end(); } catch {} await recordUsage(poolKey, contrib, model, { total: 0, exact: true }, Date.now() - t0, 'upstream_error'); return; }
        // 头未发：排除本轮，下一轮 attempt 复用同一并发槽
        exclude.push(contrib.key_id);
        continue;
      }
      console.error('upstream:',String(e).slice(0,200));
      // 通用错误：已写 200 只能结束；未写 200 则可重试下一次
      if (res.headersSent) { try { res.end(); } catch {} await recordUsage(poolKey, contrib, model, { total: 0, exact: true }, Date.now() - t0, 'upstream_error'); return; }
      if (clientClosed) return;
      exclude.push(contrib.key_id);
      continue;
    }
  }
  if (clientClosed) return;
  res.writeHead(502); res.end('{"error":{"message":"All upstream attempts failed"}}');
  } finally {
    // ⚠️ exactly-once 释放点：不论正常 return / throw / 客户端断开 / markClientClosed 旁路调用，
    //   这里都走同一分支；concurrentAcquired flag 保证仅首次有效。后续手动调用仍是幂等的。
    releaseConcurrency();
  }
  } catch (e) {
    // ⚠️ 任何未预期异常：记录并返回 500，绝不让进程崩溃
    console.error(new Date().toISOString(), 'request error:', String(e && e.message || e).slice(0, 200));
    try {
      if (!res.headersSent && !clientClosed) { res.writeHead(500); res.end('{"error":{"message":"Internal error"}}'); }
      else { try { res.end(); } catch {} }
    } catch {}
  }
});

// ⚠️ 测试导出：仅当被 import 时可用；作为入口运行时直接 listen
// 回归测试路径：import { validateUpstreamBaseUrl, parseSafeBaseUrl } from './gateway.mjs';
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '127.0.0.1', () => { console.log(new Date().toISOString(), 'Gateway v3 on 127.0.0.1:' + PORT); });
}

export { validateUpstreamBaseUrl, upstreamFetchAndConsume };