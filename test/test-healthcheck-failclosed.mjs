// 静态分析 + 动态验证：healthcheck.mjs 在白名单加载失败时必须非零退出 + 不批量改 key/contribution 状态。
// 策略：使用 node --check + 静态扫描 + mock 一个失败环境跑 healthcheck 入口（需小幅 hack：临时替换全局 fetch）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '..', 'healthcheck.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, hint || ''); }
}

console.log('== healthcheck fail-closed 静态扫描 ==');

// 1) 必须有 try/catch 包住 loadAllowedHosts
check('loadAllowedHosts 在 try/catch 中', /try\s*\{\s*allowedHosts\s*=\s*await\s+loadAllowedHosts/.test(src),
  '应捕获加载异常');
// 2) 加载失败必须设 process.exitCode 非零
check('加载失败设置 process.exitCode', /allowlistLoadFailed[\s\S]{0,300}?process\.exitCode\s*=\s*\d+/.test(src),
  '必须 exitCode 非零');
// 3) 加载失败时必须不发探测、不批量改 key / contribution
check('加载失败时跳过主循环', /if\s*\(\s*allowlistLoadFailed\s*\)\s*\{[\s\S]{0,400}?\}\s*else\s*\{[\s\S]{0,200}?for\s*\(\s*const\s+k\s+of\s+keys\s*\)/.test(src),
  '主 for 循环应被 else 包住');
// 4) 加载失败时不应有任何 sbPatch（key 状态批量写）
//    抽取出 if (allowlistLoadFailed) { ... } 块主体，检查内部不出现 sbPatch / sbGet pool_contributions
const failBlockMatch = src.match(/if\s*\(\s*allowlistLoadFailed\s*\)\s*\{[\s\S]+?\n\}/);
const failBlock = failBlockMatch ? failBlockMatch[0] : '';
check('加载失败分支无 sbPatch 调用',
  failBlock && !/sbPatch/.test(failBlock),
  'fail-closed 分支不能改 key');
// 5) 加载失败时不应有 sbGet('/pool_contributions)（贡献状态同步）
const failBranch = src.match(/if\s*\(\s*allowlistLoadFailed\s*\)\s*\{[\s\S]+?\}/);
check('加载失败分支不查 pool_contributions',
  failBranch && !/sbGet.*pool_contributions/.test(failBranch[0]),
  'fail-closed 分支不能查 contributions');

console.log('\n== 动态验证：mock Supabase 500 让 loadAllowedHosts 抛错 ==');

// 起一个 mock Supabase：llm_keys 返回成功（让脚本走到 loadAllowedHosts），
// allowed_models 返回 500（触发 loadAllowedHosts 抛错）
const mockServer = http.createServer((req, res) => {
  const url = req.url || '';
  if (url.includes('/rest/v1/llm_keys')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end('[]'); // empty keys
    return;
  }
  if (url.includes('/rest/v1/allowed_models')) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end('{"message":"forced failure"}');
    return;
  }
  if (url.includes('/rest/v1/pool_contributions')) {
    // fail-closed 分支不应走到这里；返回 500 让任何意外调用报错
    res.writeHead(500); res.end('{}'); return;
  }
  // 默认 500
  res.writeHead(500); res.end('{}');
});
const mockPort = await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port)));

// ⚠️ 直接 child_process 执行 healthcheck.mjs：健康检查脚本从脚本同目录读 .env，
//   所以需复制脚本到临时目录、在临时目录里写 .env，然后从临时目录执行。
//   这样不修改项目 .env；测试结束 rmSync 清理。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const tmpDir = mkdtempSync(join(tmpdir(), 'hc-test-'));
copyFileSync(join(dir, '..', 'healthcheck.mjs'), join(tmpDir, 'healthcheck.mjs'));
writeFileSync(join(tmpDir, '.env'), 'SUPABASE_URL=http://127.0.0.1:' + mockPort + '\nSUPABASE_SERVICE_KEY=dummy\n');

const child = spawn(process.execPath, ['healthcheck.mjs'], {
  cwd: tmpDir,
  stdio: 'pipe'
});

let stdout = '', stderr = '';
child.stdout.on('data', d => stdout += d);
child.stderr.on('data', d => stderr += d);

const exitCode = await new Promise((r) => child.on('exit', r));

check('child 退出码非零 (allowlist 加载失败)', exitCode !== 0,
  'exit code was ' + exitCode);
check('stderr 含 FAILED 日志', /FAILED/.test(stderr),
  '应记录失败原因');
check('stderr 含 allowlist 字样', /allowlist/i.test(stderr),
  '应说明是 allowlist 加载失败');

// 关闭 mock + 清理临时目录
await new Promise(r => mockServer.close(() => r()));
rmSync(tmpDir, { recursive: true, force: true });

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) {
  console.error('FAIL');
  console.error('--- stderr ---\n' + stderr);
  console.error('--- stdout ---\n' + stdout);
  process.exit(1);
}
console.log('ALL PASS');
