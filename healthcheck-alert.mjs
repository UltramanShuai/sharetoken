// TokenPool 健康告警 - cron 每5分钟
// 检查：网关端口 / Supabase REST / 本机网关健康；异常 → Bark 通知（30分钟冷却，恢复再报一次）
// 注：公网域名探测不可用（v2rayA 回环劫持 TLS），仅探测 127.0.0.1:20140
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const BARK_KEY = env.BARK_KEY || process.env.BARK_Key || '';
const STATE_FILE = '/tmp/tokenpool-alert-state';
const SB_URL = env.SUPABASE_URL || '__SUPABASE_URL__';
const PUBLIC_URL = env.PUBLIC_URL || 'https://YOUR-DOMAIN';

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { alerting: false, lastAlert: 0 }; } }
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }

async function bark(title, body) {
  if (!BARK_KEY) { console.error('no BARK_KEY'); return; }
  try {
    const url = 'https://api.day.app/' + BARK_KEY + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    console.log(new Date().toISOString(), 'bark', r.status);
  } catch (e) { console.error('bark fail:', String(e).slice(0, 100)); }
}

async function probe(url, ms, headers) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, headers ? { headers } : {}));
  return r;
}

(async () => {
  const problems = [];
  // 1. 网关端口
  try { execSync('ss -tln | grep -q 20140', { timeout: 5000 }); } catch { problems.push('网关端口20140未监听'); }
  // 2. Supabase REST（401=正常鉴权响应，说明链路通）
  try {
    const r = await probe(SB_URL + '/rest/v1/points_ledger?select=id', 6000, { apikey: 'probe' });
    if (r.status !== 401 && r.status !== 200) problems.push('Supabase REST HTTP ' + r.status);
  } catch (e) { problems.push('Supabase REST 不可达'); }
  // 3. 公网入口（本机直连网关 20140 避开透明代理回环；外部用户访问不受影响）
  try {
    const r = await probe('http://127.0.0.1:20140/v1/models', 8000);
    if (!r.ok) problems.push('网关 HTTP ' + r.status);
  } catch { problems.push('网关不可达'); }

  const state = loadState();
  const now = Date.now();
  if (problems.length) {
    console.log(new Date().toISOString(), '异常:', problems.join(' | '));
    if (!state.alerting || now - state.lastAlert > 30 * 60 * 1000) {
      await bark('TokenPool 异常', problems.join(' | '));
      state.alerting = true; state.lastAlert = now; saveState(state);
    }
  } else {
    console.log(new Date().toISOString(), 'OK');
    if (state.alerting) {
      await bark('TokenPool 已恢复', '所有检查通过');
      state.alerting = false; saveState(state);
    }
  }
})();
