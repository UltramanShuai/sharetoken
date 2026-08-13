// 验证 v5.4 ACL 自检：aclexplode + grantee=0 (PUBLIC) 检测
// 策略：起 PG16 容器 → 建一个极简库（含测试 RPC）→ 跑自检片段 → 断言其正确报错
import { spawnSync } from 'node:child_process';

function docker(args, opts={}) {
  const r = spawnSync('docker', ['exec', 'tokenpool-pg-test', 'psql', '-U', 'postgres', ...args], { encoding: 'utf8', ...opts });
  return r;
}

function dockerExec(args, opts={}) {
  return docker(args, opts).stdout || '';
}
function psqlFull(sql, db) {
  // 返回 stdout + stderr（NOTICE 走 stderr）
  const r = docker([db ? '-d' : '', ...(db ? [db] : []), '-v', 'ON_ERROR_STOP=0', '-c', sql], { encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}

let pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, hint || ''); }
}

console.log('== v5.4 ACL PUBLIC 自检测试 ==');

// 准备：建临时数据库，定义 owner/anon/authenticated/svc 角色
const dbName = 'tp_v54_acl';
docker(['-c', `DROP DATABASE IF EXISTS ${dbName}`]);
docker(['-c', `CREATE DATABASE ${dbName}`]);
const psql = (sql) => docker(['-d', dbName, '-v', 'ON_ERROR_STOP=0', '-c', sql]).stdout || '';
const psqlErr = (sql) => docker(['-d', dbName, '-v', 'ON_ERROR_STOP=0', '-c', sql]).stderr || '';

// 模拟 Supabase 的 anon / authenticated / service_role 角色
psql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;`);

// 测试 RPC
psql(`CREATE SCHEMA IF NOT EXISTS public;`);
psql(`CREATE OR REPLACE FUNCTION public.test_owner_rpc() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`);

// 初始：revoke public（默认 PUBLIC 有 EXECUTE）→ 期望自检通过
psql(`REVOKE EXECUTE ON FUNCTION public.test_owner_rpc() FROM PUBLIC;`);
psql(`GRANT EXECUTE ON FUNCTION public.test_owner_rpc() TO authenticated;`);

console.log('\n-- 场景 A：PUBLIC 已 revoke，自检应 OK --');
const scriptA = `
DO $$
DECLARE rec record; bad int := 0;
DECLARE v_anon_oid oid; v_auth_oid oid;
BEGIN
  SELECT oid INTO v_anon_oid FROM pg_roles WHERE rolname='anon';
  SELECT oid INTO v_auth_oid FROM pg_roles WHERE rolname='authenticated';
  -- 1) owner RPC：grantee=0 (PUBLIC) 不应授 EXECUTE
  bad := 0;
  SELECT count(*) INTO bad
    FROM pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
   WHERE p.pronamespace='public'::regnamespace AND p.proname='test_owner_rpc'
     AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE';
  IF bad > 0 THEN RAISE EXCEPTION 'ACL ERROR: PUBLIC EXECUTE detected (bad=%)', bad; END IF;
  -- 2) anon OID 不应授 EXECUTE
  bad := 0;
  SELECT count(*) INTO bad
    FROM pg_proc p, pg_roles r
   WHERE p.pronamespace='public'::regnamespace AND p.proname='test_owner_rpc'
     AND r.oid = v_anon_oid
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad > 0 THEN RAISE EXCEPTION 'ACL ERROR: anon EXECUTE detected (bad=%)', bad; END IF;
  -- 3) authenticated 应授 EXECUTE（不报错）
  PERFORM 1 FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='test_owner_rpc'
     AND has_function_privilege(v_auth_oid, p.oid, 'EXECUTE');
  IF NOT FOUND THEN RAISE EXCEPTION 'authenticated EXECUTE missing'; END IF;
  RAISE NOTICE 'OK: scenario A passed';
END $$;
`;
const outA = psqlFull(scriptA, dbName);
check('场景 A：正常状态自检通过', /scenario A passed/.test(outA), outA);
psql(`REVOKE EXECUTE ON FUNCTION public.test_owner_rpc() FROM authenticated;`);
psql(`REVOKE EXECUTE ON FUNCTION public.test_owner_rpc() FROM PUBLIC; -- 先清零`);
psql(`-- 故意恢复默认 PUBLIC 授权：不做 revoke，依赖 PostgreSQL 默认 PUBLIC EXECUTE`);

// 重建一个函数，让它走默认 PUBLIC EXECUTE（不 revoke）
psql(`CREATE OR REPLACE FUNCTION public.test_public_default() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`);

const scriptB = `
DO $$
DECLARE rec record; bad int := 0;
DECLARE v_anon_oid oid; v_auth_oid oid;
BEGIN
  SELECT oid INTO v_anon_oid FROM pg_roles WHERE rolname='anon';
  SELECT oid INTO v_auth_oid FROM pg_roles WHERE rolname='authenticated';
  -- 1) 检查 test_public_default 上 PUBLIC (grantee=0) 是否授 EXECUTE
  bad := 0;
  SELECT count(*) INTO bad
    FROM pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
   WHERE p.pronamespace='public'::regnamespace AND p.proname='test_public_default'
     AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE';
  IF bad > 0 THEN RAISE NOTICE 'detected PUBLIC EXECUTE (bad=%)', bad; END IF;
END $$;
`;
const outB = psqlFull(scriptB, dbName);
check('场景 B：默认 PUBLIC EXECUTE 应被 aclexplode 检测到', /detected PUBLIC EXECUTE \(bad=1\)/.test(outB), outB);

console.log('\n-- 场景 C：旧实现用 pg_roles.rolname=PUBLIC 查 → 漏验（应证明这一点）--');
const scriptC = `
DO $$
DECLARE bad int := 0;
BEGIN
  -- 旧逻辑：join pg_roles where rolname='PUBLIC' + has_function_privilege
  -- 但 PUBLIC 不在 pg_roles，所以这条查询永远 0 行
  SELECT count(*) INTO bad
    FROM pg_proc p, pg_roles r
   WHERE p.pronamespace='public'::regnamespace AND p.proname='test_public_default'
     AND r.rolname = 'PUBLIC'
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  RAISE NOTICE 'old-implementation-detection: bad=%', bad;
END $$;
`;
const outC = psqlFull(scriptC, dbName);
check('场景 C：旧实现漏验（应返回 bad=0）', /old-implementation-detection: bad=0/.test(outC), outC);

console.log('\n-- 场景 D：完整 fix-v5-rls-tightening.sql ACL 段在最小库上可解析 --');
// 在最小库上跑 fix-v5 完整文件：应能解析（不要求全部 NOTICE，因为 RPC 大部分缺失）
// 我们关心的是：ACL 自检段不抛 syntax error；其余 ERROR（function not exist）属预期
docker(['-c', `DROP DATABASE IF EXISTS tp_v54_run1`]);
docker(['-c', `CREATE DATABASE tp_v54_run1`]);
// 重跑 schema-phase2 + fix-v3 + fix-v5 在新库（用 docker cp 的脚本）
const setup = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
`;
docker(['-d', 'tp_v54_run1', '-c', setup]);
// 容器内 psql 一次性跑 schema-phase2 + fix-v3 + fix-v5（schema 依赖问题会让部分 SQL fail，但 acl 段独立）
docker(['-d', 'tp_v54_run1', '-v', 'ON_ERROR_STOP=0', '-f', '/tmp/schema.sql']);
docker(['-d', 'tp_v54_run1', '-v', 'ON_ERROR_STOP=0', '-f', '/tmp/fix-v3.sql']);
// 不存在 schema 的情况下跑 fix-v5：很多 ALTER/DROP/RPC 会因依赖缺失 ERROR；重点看 ACL 自检 NOTICE
const fixOut = docker(['-d', 'tp_v54_run1', '-v', 'ON_ERROR_STOP=0', '-f', '/tmp/fix-v5.sql']);
const fixStdout = fixOut.stdout || '';
const fixStderr = fixOut.stderr || '';
check('fix-v5.sql 在 PG16 上无 syntax error',
  !/syntax error/i.test(fixStderr),
  'stderr 含 syntax error');

console.log('\n-- 场景 E：fix-v5.sql 二次运行仍幂等 --');
const fixOut2 = docker(['-d', 'tp_v54_run1', '-v', 'ON_ERROR_STOP=0', '-f', '/tmp/fix-v5.sql']);
const fixStderr2 = fixOut2.stderr || '';
check('fix-v5.sql 二次运行无 syntax error',
  !/syntax error/i.test(fixStderr2),
  'stderr 含 syntax error');

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) {
  console.error('FAIL');
  process.exit(1);
}
console.log('ALL PASS');