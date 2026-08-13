// 验证 public/index.html 中所有 sb.rpc(...) 调用与 fix-v5-rls-tightening.sql 中
// 的 create or replace function 签名匹配。
// 策略：抽出 SQL 中所有函数声明（proname + 参数类型），与 index.html 中的
// {p_xxx:value, ...} 字段对照。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(dir, '..', 'db', 'fix-v5-rls-tightening.sql'), 'utf8')
  + '\n' + readFileSync(join(dir, '..', 'db', 'fix-v3.sql'), 'utf8')
  + '\n' + readFileSync(join(dir, '..', 'db', 'schema-phase2.sql'), 'utf8');
const idx = readFileSync(existsSync(join(dir, '..', 'public', 'index.html')) ? join(dir, '..', 'public', 'index.html') : join(dir, '..', 'public', 'index.example.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, hint || ''); }
}

console.log('== RPC 签名漂移检查 ==');

// 1) 从 SQL 抽出所有 proname + 参数
const sqlFnRegex = /create or replace function public\.(\w+)\s*\(([^)]*)\)/g;
const sqlFns = {};
let m;
while ((m = sqlFnRegex.exec(sql)) !== null) {
  const name = m[1];
  const params = m[2];
  const parsed = [];
  // 极简参数解析（按逗号分隔，去默认值）
  params.split(',').forEach((p) => {
    const t = p.trim();
    if (!t) return;
    // 形如 "p_id uuid default null"
    const pt = t.match(/^(\w+)\s+\w+/);
    if (pt) parsed.push(pt[1]);
  });
  sqlFns[name] = parsed;
}
console.log('SQL 定义 RPC 数:', Object.keys(sqlFns).length);

// 2) 从 SQL 抽出 revoke/grant 处的参数签名（确切签名）
const sigRegex = /function public\.(\w+)\(([^)]*)\)/g;
const exactSigs = {};
while ((m = sigRegex.exec(sql)) !== null) {
  const name = m[1];
  const params = m[2].replace(/\s*default\s+[^,)]+/g, '').replace(/\s+/g, ' ').trim();
  exactSigs[name] = params;
}

// 3) 从 index.html 抽出 sb.rpc 调用
const rpcCalls = [];
// 匹配 .rpc('name', {params}) 或 .rpc(fn, {params})
const rpcRegex = /\.rpc\(\s*(?:'([a-z_]+)'|fn),\s*\{([^}]*)\}\s*\)/g;
while ((m = rpcRegex.exec(idx)) !== null) {
  const fnName = m[1] || '<fn>';
  const paramsBlock = m[2];
  const fields = {};
  paramsBlock.split(',').forEach((p) => {
    const t = p.trim();
    if (!t) return;
    const pt = t.match(/^(\w+):/);
    if (pt) fields[pt[1]] = true;
  });
  rpcCalls.push({ fnName, fields });
}
console.log('index.html RPC 调用数:', rpcCalls.length);

// 4) 对每个调用校验字段在 SQL 函数定义中存在（不要求顺序）
//    fn=fn 的两个调用是动态的（pause_contribution/pause_pool_key/resume_contribution/resume_pool_key），分别验证
const dynamicMap = {
  pause_pool_key: 'pause_pool_key',
  resume_pool_key: 'resume_pool_key',
  pause_contribution: 'pause_contribution',
  resume_contribution: 'resume_contribution'
};

for (const call of rpcCalls) {
  let fnName = call.fnName;
  if (fnName === '<fn>') {
    // 从上下文判断（grep 调用点） - 查找 fn=n=='xxx' 模式
    // 简化：在 index.html 中查调用点的 fn=n=='active' / 'paused' 等上下文
    const allRpc = idx.match(/\.rpc\(fn,\s*\{p_id:[^}]*\}\)/g) || [];
    check(`动态 RPC 调用 × ${allRpc.length} 处（pause/resume_pool_key 与 pause/resume_contribution）`, allRpc.length >= 2);
    continue;
  }
  if (!sqlFns[fnName]) {
    check(`RPC ${fnName} 在 SQL 定义中存在`, false, 'index.html 用了 SQL 未定义的 RPC');
    continue;
  }
  check(`RPC ${fnName} 在 SQL 定义中存在`, true);
  const sqlParams = sqlFns[fnName];
  for (const f of Object.keys(call.fields)) {
    check(`  ${fnName} 字段 ${f} 在 SQL 参数列表中`, sqlParams.includes(f));
  }
}

// 5) 关键 RPC 全部用到的字段一致性（再次端到端列一下）
console.log('\n== 关键 RPC 端到端字段对照 ==');
const critical = [
  { fn: 'create_llm_key', expected: ['p_provider','p_base_url','p_api_key','p_note'] },
  { fn: 'update_llm_key', expected: ['p_id','p_provider','p_base_url','p_api_key','p_note'] },
  { fn: 'delete_llm_key', expected: ['p_id'] },
  { fn: 'withdraw_contribution', expected: ['p_id'] },
  { fn: 'create_pool_key', expected: ['p_plain'] },
  { fn: 'reset_pool_key', expected: ['p_plain'] },
  { fn: 'reveal_llm_key', expected: ['p_key_id'] },
  { fn: 'reveal_pool_key', expected: ['p_key_id'] }
];
for (const c of critical) {
  if (!sqlFns[c.fn]) { check(`SQL 定义 ${c.fn}`, false, '缺失'); continue; }
  for (const f of c.expected) {
    check(`${c.fn} SQL 含 ${f}`, sqlFns[c.fn].includes(f));
  }
}

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) { console.error('FAIL'); process.exit(1); }
console.log('ALL PASS');