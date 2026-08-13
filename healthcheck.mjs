// TokenPool 健康检查 v3 - 2026-08-12 上线加固
// 改动：
//   - 上线 SSRF 防御：探测 base_url 必须命中 enabled allowed_models.allowed_hosts；
//     否则将该 Key 标记为 degraded（不允许标 down 暴露内部资源；只跳过本次探测）
//   - fetch 加 redirect:'manual'，禁止重定向越过白名单（避免攻击者把 base_url 设成
//     https://evil.com/ → 302 → http://localhost/admin）
//   - 自定义 base_url / 未白名单 Key：探测前 short-circuit，不发起请求，避免泄露
//     内部网络（环回地址、私网、link-local、非 http/https、userinfo 等一律拒绝探测）
//   - 抽共用函数到本文件顶部；不引入新依赖
// 运行：cron 每10分钟；依赖 .env（SUPABASE_URL / SUPABASE_SERVICE_KEY）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// ⚠️ 兜底必须最先注册：顶层 await 在文件其余部分执行，若失败时 handler 未注册则无日志直接崩
process.on('uncaughtException', (e) => { console.error(new Date().toISOString(), 'uncaught:', String(e && e.message || e).slice(0, 300)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(new Date().toISOString(), 'unhandled:', String(e && e.message || e).slice(0, 300)); process.exit(1); });
const dir = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const SB_URL = env.SUPABASE_URL, SB_KEY = env.SUPABASE_SERVICE_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const T = 10000; // 10s 请求超时

// ============================================================
// 共用：低层 Supabase REST / RPC / PATCH / POST 封装
// ============================================================
async function jf(url, opt) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), T);
  try { return await fetch(url, Object.assign({ signal: c.signal }, opt)); }
  catch (e) { throw new Error('fetch failed: ' + (e && e.name === 'AbortError' ? 'timeout>' + T + 'ms' : String(e && e.message || e)).slice(0, 120)); }
  finally { clearTimeout(t); }
}
async function sbGet(p) { const r = await jf(SB_URL + p, { headers: H }); if (!r.ok) throw new Error('GET ' + r.status); return r.json(); }
async function sbRpc(n, b) { const r = await jf(SB_URL + '/rest/v1/rpc/' + n, { method: 'POST', headers: H, body: JSON.stringify(b) }); if (!r.ok) throw new Error('RPC ' + n + ' ' + r.status); return r.json(); }
async function sbPatch(t, q, p) { const r = await jf(SB_URL + '/rest/v1/' + t + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify(p) }); if (!r.ok) throw new Error('PATCH ' + t + ' ' + r.status); }
async function sbPost(t, row) { const r = await jf(SB_URL + '/rest/v1/' + t, { method: 'POST', headers: H, body: JSON.stringify(row) }); if (!r.ok) throw new Error('POST ' + t + ' ' + r.status); }

// ============================================================
// SSRF 防御 + URL 校验
// ============================================================
// 解析 base_url；拒绝非 https、userinfo/query/hash、深路径、非默认端口、localhost/私网
// 失败时返回 { ok:false, reason }；reason 是一段不暴露内部细节的分类字符串
function parseSafeBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(s); }
  catch { return { ok: false, reason: 'parse' }; }
  // ⚠️ v5.4：白名单 host 探测仅允许 https（防明文 API Key 经 HTTP 泄露）；http://localhost 自用不探测
  if (u.protocol !== 'https:') return { ok: false, reason: 'protocol-not-https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (u.search) return { ok: false, reason: 'query' };
  if (u.hash) return { ok: false, reason: 'hash' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'non-default-port' };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'no-host' };
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return { ok: false, reason: 'localhost' };
  if (/^10\./.test(host)) return { ok: false, reason: 'private-10' };
  if (/^192\.168\./.test(host)) return { ok: false, reason: 'private-192' };
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return { ok: false, reason: 'private-172' };
  if (/^169\.254\./.test(host)) return { ok: false, reason: 'link-local' };
  if (host.endsWith('.internal') || host.endsWith('.local')) return { ok: false, reason: 'internal-tld' };
  // ⚠️ 路径白名单（含智谱 /api/paas/v4）；其余路径视为被改、跳过探测
  const pathname = u.pathname || '';
  const cleanPath = pathname.replace(/\/+$/, '');
  const allowedPaths = ['', '/v1', '/api', '/api/paas/v4'];
  if (!allowedPaths.includes(cleanPath.toLowerCase())) return { ok: false, reason: 'deep-path' };
  // ⚠️ 保留 base path（防丢 /v1）；去除尾部斜杠
  const baseUrl = 'https://' + host + cleanPath;
  return { ok: true, url: baseUrl, host };
}

// 主机是否在 enabled allowed_models.allowed_hosts 白名单内（大小写不敏感）
function hostAllowed(host, allowedHosts) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  for (const a of allowedHosts || []) {
    if (String(a || '').toLowerCase() === h) return true;
  }
  return false;
}

// 加载白名单：enabled provider 的 allowed_hosts 并集
async function loadAllowedHosts() {
  const rows = await sbGet('/rest/v1/allowed_models?enabled=eq.true&select=allowed_hosts');
  const hosts = new Set();
  for (const r of rows || []) {
    for (const h of (r.allowed_hosts || [])) hosts.add(String(h).toLowerCase());
  }
  return hosts;
}

// ============================================================
// 探测：仅在白名单内启用；超时 8s；redirect: 'manual' 阻止越过白名单
// ============================================================
async function probe(baseUrl, apiKey) {
  // ⚠️ baseUrl 已含 path（parseSafeBaseUrl 保留 /v1）；直接拼接 /models，不重复 strip
  const url = baseUrl + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: ctrl.signal,
      // ⚠️ 关键：不跟随重定向，避免 base_url 设成外网跳转到内网
      redirect: 'manual'
    });
    const lat = Date.now() - t0;
    // redirect 类响应（3xx）一律按可疑处理：标记 degraded 并显式记录原因
    if (r.status >= 300 && r.status < 400) {
      return { status: 'degraded', latency: lat, http: r.status, err: 'redirect blocked' };
    }
    if (r.status === 200) return { status: 'healthy', latency: lat, http: r.status };
    if (r.status === 401 || r.status === 403) return { status: 'down', latency: lat, http: r.status, err: 'auth failed' };
    return { status: 'degraded', latency: lat, http: r.status, err: 'http ' + r.status };
  } catch (e) {
    return { status: 'degraded', latency: Date.now() - t0, http: null, err: String(e && e.name === 'AbortError' ? 'timeout' : e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const keys = await sbGet('/rest/v1/llm_keys?select=id,base_url,fail_streak,health_status&deleted_at=is.null');
console.log(new Date().toISOString(), 'checking', keys.length, 'keys');

// ⚠️ 白名单加载失败时：本轮全部跳过探测与 DB 同步 + 进程非零退出
// 原因：在未知允许列表的情况下探测任何 Key 都可能导致 API Key 被发送给未授权主机；
// 同时也不批量把 key / contribution 设为 'unknown'，避免凭空覆盖上一次合法探测结果。
let allowedHosts = new Set();
let allowlistLoadFailed = false;
let allowlistLoadError = '';
try { allowedHosts = await loadAllowedHosts(); }
catch (e) {
  allowlistLoadFailed = true;
  allowlistLoadError = String(e && e.message || e).slice(0, 200);
  console.error(new Date().toISOString(), 'loadAllowedHosts FAILED, abort this round:', allowlistLoadError);
}

if (allowlistLoadFailed) {
  // 不发任何探测、不改 key / contribution 状态；为让 cron 能感知失败，返回非零退出
  process.exitCode = 11;
  console.error(new Date().toISOString(), 'healthcheck aborted due to allowlist load failure (exit=11)');
} else {
  // 收集 key 健康结果，后面同步到贡献
  const keyHealth = {};
  for (const k of keys) {
    // 1) URL 合法性
    const parsed = parseSafeBaseUrl(k.base_url || '');
    if (!parsed.ok) {
      // ⚠️ 不泄露内部资源 / 内部网络细节，只标记 custom url 待人工核验
      keyHealth[k.id] = 'unknown';
      try {
        await sbPatch('llm_keys', 'id=eq.' + k.id, { health_status: 'unknown', last_check_at: new Date().toISOString(), last_latency_ms: null, last_error: 'custom url pending review' });
      } catch {}
      console.log(' ', k.id.slice(0, 8), 'skipped(custom url:', parsed.reason + ')');
      continue;
    }
    // 2) 主机白名单
    if (!hostAllowed(parsed.host, allowedHosts)) {
      keyHealth[k.id] = 'unknown';
      try {
        await sbPatch('llm_keys', 'id=eq.' + k.id, { health_status: 'unknown', last_check_at: new Date().toISOString(), last_latency_ms: null, last_error: 'host not in enabled allowlist' });
      } catch {}
      console.log(' ', k.id.slice(0, 8), 'skipped(host not allowed)');
      continue;
    }
    // 3) 白名单内 → 走真实探测
    try {
      const apiKey = await sbRpc('reveal_llm_key_service', { p_key_id: k.id });
      const p = await probe(parsed.url, apiKey);
      const fs = p.status === 'healthy' ? 0 : (k.fail_streak || 0) + 1;
      const fin = (p.status !== 'healthy' && fs >= 3) || p.status === 'down' ? 'down' : p.status;
      await sbPatch('llm_keys', 'id=eq.' + k.id, { health_status: fin, last_check_at: new Date().toISOString(), last_latency_ms: p.latency, last_error: p.err || null, fail_streak: fs });
      await sbPost('health_checks', { key_id: k.id, status: fin, latency_ms: p.latency, http_code: p.http, error_msg: p.err || null });
      keyHealth[k.id] = fin;
      console.log(' ', k.id.slice(0, 8), fin, p.latency + 'ms');
    } catch (e) {
      console.error(' ', k.id.slice(0, 8), 'ERROR', String(e).slice(0, 200));
      keyHealth[k.id] = 'unknown';
    }
  }
  // 同步贡献状态
  const contribs = await sbGet('/rest/v1/pool_contributions?select=id,key_id,health_status,status');
  for (const c of contribs) {
    const kh = keyHealth[c.key_id] || 'unknown';
    let newHealth = kh, newStatus = c.status;
    if (kh === 'down') { newHealth = 'down'; newStatus = c.status === 'active' ? 'throttled' : c.status; }
    else if (kh === 'healthy') { newHealth = 'healthy'; if (c.status === 'throttled') newStatus = 'active'; }
    else if (kh === 'degraded') { newHealth = 'degraded'; }
    if (newHealth !== c.health_status || newStatus !== c.status) {
      await sbPatch('pool_contributions', 'id=eq.' + c.id, { health_status: newHealth, status: newStatus, updated_at: new Date().toISOString() });
      console.log(' contrib', c.id.slice(0, 8), c.health_status + '->' + newHealth, c.status + '->' + newStatus);
    }
  }
  console.log(new Date().toISOString(), 'done');
}

// 顶层容错：单轮检查整体失败（如 Supabase 抖动）只记错误，不让 cron 进程崩溃