// TokenPool 每日重置 - 2026-08-12
// 职责：清零昨日池额度（pool_contributions.used_today / pool_keys.used_today）+ 软撤回过期贡献
// 时机：Asia/Shanghai 00:05（每日 5 分钟预留缓冲，避免卡在 00:00:00 边界）
// 设计原则：
//   - 等待并汇总所有 PATCH，单一错误即非零退出
//   - 进程内同步完成所有写；不依赖 cron 多并发（cron 用 flock -n 防并发）
//   - 通过 service_role 旁路 RLS 写服务端字段
//   - 不接 .env 外的文本输入；不接受参数
//   - 输出结构化日志，便于 cron / healthcheck 抓取
//   - 使用 process.exitCode 而非 process.exit：保证 console 输出被 flush，避免日志截断
// cron 等价：
//   5 0 * * * root /usr/bin/flock -n /var/run/tokenpool-reset.lock /usr/bin/node /root/project/llm-key-manager/scripts/reset-daily.mjs >> /var/log/tokenpool-reset.log 2>&1
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(dir, '..');
// ⚠️ 兜底最先注册：避免顶层 await 失败时 handler 未注册
process.on('uncaughtException', (e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'uncaughtException', err: String(e && e.message || e).slice(0, 300) }));
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'unhandledRejection', err: String(e && e.message || e).slice(0, 300) }));
  process.exitCode = 1;
});

const env = {};
for (const line of readFileSync(join(PROJECT_DIR, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const SB_URL = env.SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env' }));
  process.exitCode = 2;
} else {
  const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const T = 15000; // 15s 单次请求超时

  async function jf(url, opt) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), T);
    try {
      return await fetch(url, Object.assign({ signal: c.signal }, opt));
    } catch (e) {
      throw new Error('fetch failed: ' + (e && e.name === 'AbortError' ? 'timeout>' + T + 'ms' : String(e && e.message || e)).slice(0, 200));
    } finally {
      clearTimeout(t);
    }
  }

  async function sbPatch(t, q, p) {
    const r = await jf(SB_URL + '/rest/v1/' + t + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify(p) });
    if (!r.ok) throw new Error('PATCH ' + t + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }

  (async () => {
    const t0 = Date.now();
    const ts = new Date().toISOString();
    console.log(JSON.stringify({ ts, level: 'info', msg: 'reset-daily start', tz: 'Asia/Shanghai', project: PROJECT_DIR }));

    // 1) 清零 pool_keys.used_today（所有平台 key，含 active 与 disabled）
    //    reset 语义即"日志意义上的昨日用量"，统一清零；保留历史积分 / status
    try {
      const r = await sbPatch('pool_keys', 'used_today=gt.0', { used_today: 0 });
      console.log(JSON.stringify({ ts, level: 'info', msg: 'pool_keys.used_today reset', rows: Array.isArray(r) ? r.length : null }));
    } catch (e) {
      console.error(JSON.stringify({ ts, level: 'error', msg: 'pool_keys reset failed', err: String(e && e.message || e).slice(0, 300) }));
      process.exitCode = 3;
      return;
    }

    // 2) 清零 pool_contributions.used_today
    //    used_five_hour / five_hour_window_start 在 update_usage_counters 触发器内已按需滚动；
    //    此处不重复操作，避免误重置仍在飞的 5 小时窗口
    try {
      const r = await sbPatch('pool_contributions', 'used_today=gt.0', { used_today: 0 });
      console.log(JSON.stringify({ ts, level: 'info', msg: 'pool_contributions.used_today reset', rows: Array.isArray(r) ? r.length : null }));
    } catch (e) {
      console.error(JSON.stringify({ ts, level: 'error', msg: 'pool_contributions reset failed', err: String(e && e.message || e).slice(0, 300) }));
      process.exitCode = 4;
      return;
    }

    // 3) 把超期贡献 soft-withdraw（expires_at < now 且 active）
    try {
      const r = await sbPatch('pool_contributions', 'status=eq.active&expires_at=lt.' + encodeURIComponent(ts), { status: 'withdrawn', updated_at: ts });
      console.log(JSON.stringify({ ts, level: 'info', msg: 'expired contributions withdrawn', rows: Array.isArray(r) ? r.length : null }));
    } catch (e) {
      console.error(JSON.stringify({ ts, level: 'error', msg: 'expired-withdraw failed', err: String(e && e.message || e).slice(0, 300) }));
      process.exitCode = 5;
      return;
    }

    console.log(JSON.stringify({ ts, level: 'info', msg: 'reset-daily done', elapsed_ms: Date.now() - t0 }));
  })();
}