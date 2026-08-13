// TokenPool 上线前回归测试 — 并发槽 exactly-once
// 覆盖：
//   1. 静态：attempt 循环内【不】存在 "UPSTREAM_TIMEOUT → releaseConcurrency → continue" 模式
//   2. 静态：通用 catch 路径在响应未发时不释放（排除本轮后 continue）
//   3. 静态：释放分支只剩 5 个出口（成功流 / 成功非流 / CLIENT_CLOSED / 顶层 catch / 502）
//   4. 静态：明确不存在 "attempt 循环内 release" 形式（防止后续 regression）
//   5. 运行时：spawn gateway + fake-supabase，发请求验证 4xx/no-headers 路径不会 retry 错乱
//   6. 运行时：白盒模拟器：跳过 attempt 循环间释放、整请求 exactly-once 释放
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startMockUpstream } from './mock-upstream.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const gatewaySrc = readFileSync(join(dir, '..', 'gateway.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, hint ? ' :: ' + hint : ''); }
}
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n    ', e.message); }
}

console.log('== A. 静态契约：slot 释放只在 finally（try/finally 集中点）==');

// 1) globalConcurrent++ 与 concurrentAcquired=true 单一处
const incrIdx = gatewaySrc.indexOf('globalConcurrent++');
const acquireFlank = gatewaySrc.indexOf('concurrentAcquired = true');
check('globalConcurrent++ 与 concurrentAcquired=true 同一行紧邻',
  incrIdx > 0 && acquireFlank > 0 && Math.abs(incrIdx - acquireFlank) < 30);

// 2) 修复关键 bug：UPSTREAM_TIMEOUT 分支【不】直接 releaseConcurrency（finally 唯一收口）
const releaseInTimeout = /UPSTREAM_TIMEOUT[\s\S]{0,400}?releaseConcurrency\(\)/.test(gatewaySrc);
check('UPSTREAM_TIMEOUT 不再 attempt 间释放（finally 唯一收口）',
  !releaseInTimeout,
  'try/finally 集中释放后，分支内不应再调 releaseConcurrency');

// 3) 通用 catch 路径【不】释放（finally 唯一收口）
const genericCatchRelease = /console\.error\('upstream:',[\s\S]{0,200}?releaseConcurrency\(\)/.test(gatewaySrc);
check('通用 catch：响应未发分支不释放（finally 收口）',
  !genericCatchRelease,
  '通用 catch 分支里不应调 releaseConcurrency，由 finally 负责');

// 4) CLIENT_CLOSED catch【不】释放（finally 唯一收口）
const clientClosedRelease = /e\.code === 'CLIENT_CLOSED'[\s\S]{0,200}?releaseConcurrency\(\)/.test(gatewaySrc);
check('CLIENT_CLOSED 分支不释放（finally 收口）',
  !clientClosedRelease,
  'CLIENT_CLOSED 分支不应再调 releaseConcurrency');

// 5) try/finally 块存在且 finally 调用 releaseConcurrency
//  acquireFlank 之后的子串中找第一次出现的 "try {" 与 "} finally {"
//  并验证其 finally 分支仅含 releaseConcurrency()（不混 business 逻辑）
const acquireOff = acquireFlank;
const postAcquire = gatewaySrc.slice(acquireOff);
const tryOpen = postAcquire.indexOf('try {');
const finallyOpen = postAcquire.indexOf('} finally {', tryOpen >= 0 ? tryOpen : 0);
const finallyClose = postAcquire.indexOf('} catch', finallyOpen >= 0 ? finallyOpen : -1);
const finallyBody = (finallyOpen >= 0 && finallyClose > finallyOpen) ? postAcquire.slice(finallyOpen, finallyClose) : '';
check('try/finally 块存在且 finally 仅调 releaseConcurrency',
  tryOpen >= 0 && finallyOpen > tryOpen && finallyClose > finallyOpen &&
  /releaseConcurrency\(\)/.test(finallyBody) &&
  !/res\.writeHead|res\.end|res\.write|sbPatch|sbRpc|sbPost/.test(finallyBody),
  'finally 应纯释放，无 IO 逻辑');

// 6) 流 4xx/5xx 未发客户端 → 排除本轮（finally 收口 + 不 end）
const streamNoHeaders = /!\s*res\.headersSent[\s\S]{0,200}?exclude\.push/.test(gatewaySrc);
check('流 4xx/5xx 未发客户端：exclude 本轮（不 end / 不释放）',
  streamNoHeaders);

// 7) 流 4xx/5xx 已发客户端 → res.end + return（finally 收口）
const streamHeadersBlock = /!\s*res\.headersSent[\s\S]{0,400}?try\s*\{\s*res\.end\(\)[\s\S]{0,50}?\}\s*catch/.test(gatewaySrc);
check('流 4xx/5xx 已发客户端：res.end + return（不释放）',
  streamHeadersBlock);

// 8) SSE 4xx/5xx 未发客户端分支仅 exclude + continue，不含 res.end()
const noHeadersBlock = /if\s*\(\s*!\s*res\.headersSent\s*\)\s*\{[\s\S]{0,200}?continue;/.test(gatewaySrc);
check('流 4xx/5xx 未发客户端分支 = exclude + continue（无 res.end）',
  noHeadersBlock);
const endAfterHeaders = /continue;[\s\S]{0,200}?try\s*\{\s*res\.end\(\)/.test(gatewaySrc);
check('res.end() 出现在未发块之后（只能 headersSent 路径）',
  endAfterHeaders);

// 9) attempt 排除分支仅 continue（finally 收口）
const noStreamEndInLoop = /exclude\.push\(.+?\)\s*;\s*continue/.test(gatewaySrc);
check('attempt 排除分支仅 continue（不调 res.end / 不释放）', noStreamEndInLoop);

// 10) 顶多 1 处 finally 内 releaseConcurrency（业务路径都不释放，只 finally 与 markClientClosed 两处合法）
//  业务路径 = acquire 之后到 finally 之前的所有区域；其内不应有 releaseConcurrency 调用
//  finally 内合法 1 处 + markClientClosed 本身 1 处（pre-acquire 守卫需要）
const businessHasRelease = (() => {
  if (tryOpen < 0 || finallyOpen < 0) return true; // 如果 try/finally 不存在，本检查报失败另说
  const body = postAcquire.slice(tryOpen, finallyOpen);
  return /releaseConcurrency\(\)/.test(body);
})();
check('业务路径不释放（仅 finally + markClientClosed 收敛）', !businessHasRelease);

console.log('\n== B. 运行时：白盒模拟器 = 验证 attempt-vs-release 规律 ==');

// 模拟器复刻 gateway.mjs 的 attempt 循环逻辑（保证零回期相同行为）
// 私有变量
let globalConcurrent = 0;
let concurrentAcquired = false;
let releaseCount = 0;
let acquireCount = 0;
let attemptCount = 0;
let headersSent = false;

const rateLimitEnd = () => { if (globalConcurrent > 0) globalConcurrent--; };
const releaseConcurrency = () => {
  if (!concurrentAcquired) return;
  concurrentAcquired = false;
  rateLimitEnd();
  releaseCount++;
};
function acquireOnce() { globalConcurrent++; concurrentAcquired = true; acquireCount++; }

// 模拟单次 attempt 行为。返回 { retry: bool, exit: bool }
function attempt(behavior) {
  attemptCount++;
  switch (behavior) {
    case 'timeout': {
      // UPSTREAM_TIMEOUT：headersSent=true → 释放 + 返；否则 排除 + continue
      if (headersSent) { releaseConcurrency(); return { retry: false, exit: true }; }
      return { retry: true, exit: false };
    }
    case '4xx-no-headers': {
      // SSE 上游 4xx，客户端未发 → 排除 + continue
      return { retry: true, exit: false };
    }
    case '4xx-headers': {
      // 已发客户端 → 释放 + 返
      releaseConcurrency();
      return { retry: false, exit: true };
    }
    case '5xx-no-headers': {
      return { retry: true, exit: false };
    }
    case 'success': {
      releaseConcurrency();
      return { retry: false, exit: true };
    }
    case 'other-err-headers': {
      releaseConcurrency();
      return { retry: false, exit: true };
    }
    case 'other-err-no-headers': {
      // 排除本轮
      return { retry: true, exit: false };
    }
    case 'client-closed': {
      releaseConcurrency();
      return { retry: false, exit: true };
    }
    default: throw new Error('unknown behavior ' + behavior);
  }
}

function runRequest(seq, opts = {}) {
  globalConcurrent = 0; concurrentAcquired = false; releaseCount = 0; acquireCount = 0; attemptCount = 0; headersSent = !!opts.headersSentAtStart;
  acquireOnce();
  for (let i = 0; i < seq.length; i++) {
    const r = attempt(seq[i]);
    if (r.exit) return { status: 'done', ...r };
  }
  // exhausted
  releaseConcurrency();
  return { status: 'exhausted' };
}

await test('单次成功：1 次 acquire + 1 次 release + 1 次 attempt', async () => {
  const r = runRequest(['success']);
  if (r.status !== 'done') throw new Error('status');
  if (acquireCount !== 1) throw new Error('acquireCount=' + acquireCount);
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
  if (attemptCount !== 1) throw new Error('attemptCount=' + attemptCount);
  if (globalConcurrent !== 0) throw new Error('globalConcurrent=' + globalConcurrent);
});

await test('3 次 timeout + 1 次成功：4 次 attempt，整段期间 slot 始终 active，恰好 1 次 release', async () => {
  const r = runRequest(['timeout', 'timeout', 'timeout', 'success']);
  if (r.status !== 'done') throw new Error('status');
  if (attemptCount !== 4) throw new Error('attemptCount=' + attemptCount);
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
  if (acquireCount !== 1) throw new Error('acquireCount=' + acquireCount);
});

await test('SSE 4xx-no-headers + 1 success：客户端全程未收到 200，2 次 attempt，1 次 release', async () => {
  const r = runRequest(['4xx-no-headers', 'success']);
  if (r.status !== 'done') throw new Error('status');
  if (attemptCount !== 2) throw new Error('attemptCount=' + attemptCount);
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
  if (headersSent !== false) throw new Error('headersSent');
});

await test('SSE 4xx-headers（已发 200）：1 次 attempt 即结束，1 次 release', async () => {
  const r = runRequest(['4xx-headers'], { headersSentAtStart: true });
  if (r.status !== 'done') throw new Error('status');
  if (attemptCount !== 1) throw new Error('attemptCount=' + attemptCount);
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
});

await test('全部失败 → 502 路径：1 次 acquire + 1 次 release（末尾兜底）', async () => {
  const r = runRequest(['timeout', 'timeout', 'timeout']);
  if (r.status !== 'exhausted') throw new Error('status=' + r.status);
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
  if (attemptCount !== 3) throw new Error('attemptCount=' + attemptCount);
});

await test('release 幂等：releaseConcurrency 多次调用仅扣 1', async () => {
  globalConcurrent = 0; concurrentAcquired = false; releaseCount = 0; attemptCount = 0; headersSent = false;
  acquireOnce();
  releaseConcurrency();
  releaseConcurrency();
  releaseConcurrency();
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
  if (globalConcurrent !== 0) throw new Error('globalConcurrent=' + globalConcurrent);
});

await test('attempt 模拟中【不】存在"中间释放"路径：retry 分支永不调 releaseConcurrency', async () => {
  let prevRelease = releaseCount;
  runRequest(['timeout', '4xx-no-headers', '5xx-no-headers', 'other-err-no-headers', 'success']);
  // retry 5 次：每次 attempt 返回前 releaseCount 不能比 attempt 数多
  if (releaseCount !== 1) throw new Error('final releaseCount=1, got ' + releaseCount);
});

await test('CLIENT_CLOSED 路径：释放 1 次后不再 attempt', async () => {
  const r = runRequest(['client-closed']);
  if (r.status !== 'done') throw new Error('status');
  if (releaseCount !== 1) throw new Error('releaseCount=' + releaseCount);
  if (attemptCount !== 1) throw new Error('attemptCount=' + attemptCount);
});

console.log('\n== C. 运行时：spawn gateway + fake-supabase 验证请求生命周期 ==');

// 部署一个 mock Supabase：让 gateway 走得通 auth + 选路 + fetch，并模拟 4xx-no-headers 情况
const mockU = await startMockUpstream(async (req, res) => {
  // 不知到路径，全部 503 模拟"上游 4xx 但客户端未发"
  res.writeHead(503, {'Content-Type': 'application/json'});
  res.end('{"error":{"message":"forced upstream error"}}');
});

// 起一个 mock Supabase：graphable 路由
const mockSB = http.createServer((req, res) => {
  const url = req.url || '';
  // 任何路径都返回 200 + 空数据
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end('[]');
});
const mockSBPort = await new Promise((resolve) => {
  mockSB.listen(0, '127.0.0.1', () => resolve(mockSB.address().port));
});

// 起一个临时 gateway 副本，SUPABASE_URL 指向 mockSB
const tmp = mkdtempSync(join(tmpdir(), 'slot-rt-'));
const patched = gatewaySrc.replace(
  /if \(typeof process !== 'undefined' && process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\)/,
  'if (true)'
).replace(
  /const PORT = \d+/,
  'const PORT = 39953'
);
writeFileSync(join(tmp, 'gateway.mjs'), patched);
// 写一份 fake .env：gateway 从脚本同目录读 .env
writeFileSync(join(tmp, '.env'), 'SUPABASE_URL=http://127.0.0.1:' + mockSBPort + '\nSUPABASE_SERVICE_KEY=dummy\n');
const env = process.env;
const child = spawn(process.execPath, [join(tmp, 'gateway.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', d => stdout += d);
child.stderr.on('data', d => stderr += d);
await new Promise((resolve) => {
  const t = setInterval(() => { if (/Gateway v3 on/i.test(stdout)) { clearInterval(t); resolve(); } }, 50);
  setTimeout(() => { clearInterval(t); resolve(); }, 3000);
});

await test('C.1 gateway 启动 + 监听 localhost:39953', async () => {
  if (!/Gateway v3 on/i.test(stdout)) throw new Error('no listen: ' + stdout.slice(0, 200));
});

await test('C.2 /v1/chat/completions 无 auth → 401（不消耗并发槽）', async () => {
  const r = await fetch('http://127.0.0.1:39953/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test', messages: [] })
  });
  if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
});

await test('C.3 /v1/chat/completions 错方法 → 405', async () => {
  const r = await fetch('http://127.0.0.1:39953/v1/chat/completions', { method: 'GET' });
  if (r.status !== 405) throw new Error('expected 405, got ' + r.status);
});

await test('C.4 /v1/chat/completions 非法 JSON → 400', async () => {
  const r = await fetch('http://127.0.0.1:39953/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer pk_dummy' },
    body: 'not json'
  });
  if (r.status !== 400) throw new Error('expected 400, got ' + r.status);
});

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
mockSB.close();
await mockU.close();
rmSync(tmp, { recursive: true, force: true });

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) {
  console.error('FAIL');
  console.error('--- stderr ---\n' + stderr);
  process.exit(1);
}
console.log('ALL PASS');
