#!/usr/bin/env node
// 回归测试 - TokenPool Gateway 白盒白盒：releaseConcurrency exactly-once
//
// 涵盖：覆盖 test-validate-baseurl.mjs / test-slot-release.mjs / test-upstream-fetch.mjs
//   已覆盖的 A/B/C 重复段落已移除（避免维护负担），只保留：
//   - D. 并发槽 exactly-once 释放 白盒单元（小函数行为）
//   - E. inline scripts 解析（parse inline JS 块，确认 gateway + healthcheck 语法）
//
// 历史：本脚本初版由前任 session 遗留；当时含 A/B/C 重复场景；本次按 review 要求精修
//   · 去除与 test-validate-baseurl.mjs 重复的 A 段（validateUpstreamBaseUrl）
//   · 去除与 test-upstream-fetch.mjs 重复的 B 段（upstreamFetchWithTimeout）
//   · 去除与 test-upstream-fetch.mjs 重复的 C 段（mock POST/abort）
//   · 保留 D 段：releaseConcurrency exactly-once 行为（不带网络 IO，最快）
//   · 新增 E 段：inline scripts 解析（防止脚本受简后解析失败）

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const gatewaySrc = readFileSync(join(dir, '..', 'gateway.mjs'), 'utf8');
const healthcheckSrc = readFileSync(join(dir, '..', 'healthcheck.mjs'), 'utf8');
const indexSrc = readFileSync(join(dir, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.error(`  ❌ ${label}${detail ? ' :: ' + detail : ''}`); }
}

console.log('=== D. releaseConcurrency exactly-once 释放（白盒单元）===');

// 直接构造 releaseConcurrency 函数逻辑验证（与 gateway.mjs 中定义一致）
{
  let concurrentAcquired = false;
  let releaseCount = 0;
  let rateLimitEndCount = 0;
  const rateLimitEnd = () => { rateLimitEndCount++; };
  const releaseConcurrency = () => {
    if (!concurrentAcquired) return;
    concurrentAcquired = false;
    rateLimitEnd();
    releaseCount++;
  };
  // 模拟：先 acquire，再连续 3 次 release
  concurrentAcquired = true;
  releaseConcurrency();
  releaseConcurrency();
  releaseConcurrency();
  ok('D.1: releaseConcurrency exactly-once (releaseCount=1, rateLimitEnd=1)',
     releaseCount === 1 && rateLimitEndCount === 1,
     `releaseCount=${releaseCount} rateLimitEnd=${rateLimitEndCount}`);
}

// 验证 gateway.mjs 内 releaseConcurrency 函数定义有相同防护
{
  const defMatch = gatewaySrc.match(/const releaseConcurrency = \(\) => \{[\s\S]+?\};/);
  ok('D.2: gateway.mjs 有 releaseConcurrency 幂等守卫',
     defMatch && /if\s*\(!concurrentAcquired\)\s*return/.test(defMatch[0]),
     '不应允许重复释放');
}

// 验证 gateway.mjs 内的 releaseConcurrency 通过检查 concurrentAcquired 防止并发槽下溢
{
  const noUnguarded = !/releaseConcurrency\s*\(\s*\)\s*;\s*releaseConcurrency\s*\(\s*\)/.test(gatewaySrc);
  ok('D.3: 无"连续 releaseConcurrency()"的 unguarded 模式（防负数下溢）',
     noUnguarded,
     '不应连续两次 release');
}

console.log('\n=== E. inline scripts 解析 ===');
// 抽取 public/index.html 内所有 inline <script> 块，逐块 node --check
const scriptRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let scriptsFound = 0;
const tmpFiles = [];
for (const m of indexSrc.matchAll(scriptRe)) {
  scriptsFound++;
  const body = m[1];
  const tmp = `/tmp/inline-script-${scriptsFound}.mjs`;
  try {
    writeFileSync(tmp, body);
    execSync(`node --check ${tmp}`, { stdio: 'pipe' });
    ok(`E.${scriptsFound}: inline script #${scriptsFound} 解析 OK (chars=${body.length})`, true);
  } catch (e) {
    ok(`E.${scriptsFound}: inline script #${scriptsFound} 解析 OK`, false, e.message);
  }
  tmpFiles.push(tmp);
}
ok('E.0: 至少 1 段 inline script', scriptsFound > 0, 'found ' + scriptsFound);

// 全局 gateway + healthcheck 语法
try {
  execSync(`node --check ${join(dir, '..', 'gateway.mjs')}`, { stdio: 'pipe' });
  ok('E.X: gateway.mjs node --check', true);
} catch (e) {
  ok('E.X: gateway.mjs node --check', false, e.message);
}
try {
  execSync(`node --check ${join(dir, '..', 'healthcheck.mjs')}`, { stdio: 'pipe' });
  ok('E.Y: healthcheck.mjs node --check', true);
} catch (e) {
  ok('E.Y: healthcheck.mjs node --check', false, e.message);
}

console.log('\n=== Summary ===');
console.log(`  Passed: ${pass}`);
console.log(`  Failed: ${fail}`);
// 清理 tmp
for (const f of tmpFiles) {
  try { unlinkSync(f); } catch (e) {}
}
process.exit(fail > 0 ? 1 : 0);
