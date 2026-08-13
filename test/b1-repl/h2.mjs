// 前端 auth 回归测试（无 jsdom）— 直接执行真实 public/index.html inline scripts。
//
// v5.5 review fix: 父级验收要求 auth 回归测试从真实 public/index.html 提取并执行，
// 不得依赖手工副本（test/auth-extracted.mjs 已证明会漂移）。
// 本测试从 public/index.html 抽取所有 <script>...</script> 块（非 external），
// 用 node:vm + 最小 DOM/Supabase mock 执行真实 inline JS，验证：
//
//   A. showView / setAuthMode / Turnstile 主表单 widget
//   B. 重置密码 modal Turnstile 脚本晚到 / 关闭防幽灵 widget
//      （close 后 onload → 渲染计数必须 0；不只测 widget id 清空）
//   C. captchaToken 透传：signInWithPassword / signInWithOtp / verifyOtp / resetPasswordForEmail
//   D. Recovery 单一处理源：
//      - 真实 page 必须以 flowType:'pkce' + detectSessionInUrl:true 创建 SDK
//      - 不手动调用 sb.auth.exchangeCodeForSession / sb.auth.setSession
//      - PASSWORD_RECOVERY 事件 → reset modal
//      - 普通 SIGNED_IN / INITIAL_SESSION 不误弹
//      - 回调 URL 下（同用户 PASSWORD_RECOVERY）也触发弹窗
//   E. submitAuth 输入校验
//   F. 测试本身使用真实源（删除/重命名 auth-extracted.mjs 不影响本测试）
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FakeDocument, FakeElement, buildAuthDom } from './dom-mock.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = '/root/project/llm-key-manager/public/index.html';
const indexHtml = readFileSync(indexHtmlPath, 'utf8');

// === 真实源绑定检查：保证测试从 public/index.html 抽取 inline script，不是从副本 ===
// 真实页面必须包含 v5.5 关键 marker：PKCE flow 配置 + 删除 handlePasswordReset
function checkRealSourceBinding(pass, fail) {
  console.log('== F. 测试源绑定（防手工副本漂移）==');
  const hasPkceConfig = /flowType:\s*['"]pkce['"]/.test(indexHtml) && /detectSessionInUrl:\s*true/.test(indexHtml);
  if (!hasPkceConfig) {
    fail++;
    console.error('  ✗ F.1 public/index.html 含 flowType:"pkce" + detectSessionInUrl:true');
    console.error('    真实页未配置 PKCE flow，无法成为 SDK 单一处理源');
    return false;
  }
  pass++;
  console.log('  ✓ F.1 public/index.html 含 flowType:"pkce" + detectSessionInUrl:true');
  const noHandlePwdReset = !/function\s+handlePasswordReset\s*\(/.test(indexHtml);
  if (!noHandlePwdReset) {
    fail++;
    console.error('  ✗ F.2 public/index.html 不含 function handlePasswordReset（v5.5 移除）');
    return false;
  }
  pass++;
  console.log('  ✓ F.2 public/index.html 不含 function handlePasswordReset（v5.5 移除）');
  const noCleanUrl = !/function\s+_cleanRecoveryUrl\s*\(/.test(indexHtml);
  if (!noCleanUrl) {
    fail++;
    console.error('  ✗ F.3 public/index.html 不含 _cleanRecoveryUrl（v5.5 移除）');
    return false;
  }
  pass++;
  console.log('  ✓ F.3 public/index.html 不含 _cleanRecoveryUrl（v5.5 移除）');
  return true;
}

// === 抽取 inline scripts（跳过 <script src="...">）===
const scriptRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const inlineScripts = [...indexHtml.matchAll(scriptRe)].map((m) => m[1]);
if (inlineScripts.length === 0) {
  console.error('FATAL: no inline scripts found in public/index.html');
  process.exit(2);
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n    ', e.message); if (e.stack) console.error(e.stack.split('\n').slice(0, 3).join('\n')); }
}

// === 环境构造 ===
function mkSb() {
  const calls = [];
  let onAuthCb = null;
  // 链式 query builder: 所有链式方法返回同一个 builder；末尾 await 时返回 { data: [], error: null }
  const builder = {
    select: function () { return this; },
    eq: function () { return this; },
    neq: function () { return this; },
    in: function () { return this; },
    order: function () { return this; },
    limit: function () { return this; },
    range: function () { return this; },
    maybeSingle: function () { return Promise.resolve({ data: null, error: null }); },
    single: function () { return Promise.resolve({ data: null, error: null }); },
    then: function (resolve, reject) {
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    },
  };
  const stub = (path) => (args) => { calls.push({ path, args }); return Promise.resolve({ data: { user: { id: 'u1' }, session: { access_token: 't' } }, error: null }); };
  const sbAuth = {
    signInWithOtp: (a) => { calls.push({ path: 'signInWithOtp', args: a }); return Promise.resolve({ data: {}, error: null }); },
    signInWithPassword: (a) => { calls.push({ path: 'signInWithPassword', args: a }); return Promise.resolve({ data: { user: { id: 'u1' }, session: { access_token: 't' } }, error: null }); },
    verifyOtp: (a) => { calls.push({ path: 'verifyOtp', args: a }); return Promise.resolve({ data: {}, error: null }); },
    updateUser: (a) => { calls.push({ path: 'updateUser', args: a }); return Promise.resolve({ data: {}, error: null }); },
    resetPasswordForEmail: (a) => { calls.push({ path: 'resetPasswordForEmail', args: a }); return Promise.resolve({ data: {}, error: null }); },
    setSession: (a) => { calls.push({ path: 'setSession', args: a }); return Promise.resolve({ data: { session: { access_token: 't' } }, error: null }); },
    exchangeCodeForSession: (a) => { calls.push({ path: 'exchangeCodeForSession', args: a }); return Promise.resolve({ data: { session: { access_token: 't' } }, error: null }); },
    signOut: () => { calls.push({ path: 'signOut' }); return Promise.resolve({ error: null }); },
    getSession: () => { calls.push({ path: 'getSession' }); return Promise.resolve({ data: { session: null }, error: null }); },
    onAuthStateChange: (cb) => { calls.push({ path: 'onAuthStateChange' }); onAuthCb = cb; return { data: { subscription: { unsubscribe: () => {} } } }; },
  };
  const sb = {
    auth: sbAuth,
    from: (table) => { calls.push({ path: 'from', args: table }); return builder; },
    rpc: (name, args) => { calls.push({ path: 'rpc', args: { name, args } }); return Promise.resolve({ data: 0, error: null }); },
    _calls: calls,
    _setOnAuthCb: (cb) => { onAuthCb = cb; },
    _getOnAuthCb: () => onAuthCb,
  };
  return sb;
}

function mkWindowTurnstile(turnstileState = 'eager') {
  // turnstileState: 'eager' = window.turnstile 已可用；'lazy' = 初始 null
  // 注意：始终创建 turnstile 对象（但 turnstileState='lazy' 时不设 .render / .reset / .remove，
  //   这样测试可以“脚本后到”场景。在 lazy 下，测试需要手动调用 env.wt.win.turnstile = {...}
  //   并保留 wt 注册的 render 闭包，或使用 installRender(...) hook。
  const renderRegistry = [];
  let renderCount = 0;
  const mkRender = () => (el, opts) => {
    renderCount++;
    const id = 'widget-' + renderCount;
    renderRegistry.push({ id, el, opts });
    return id;
  };
  const win = {
    turnstile: turnstileState === 'eager' ? {
      render: mkRender(),
      reset: (id) => {},
      remove: (id) => {}
    } : null,
    supabase: null, // set later
    addEventListener: (type, fn) => { (win._listeners = win._listeners || {})[type] = (win._listeners[type] || []).concat([fn]); },
    dispatchEvent: (type) => { (win._listeners || {})[type]?.forEach(fn => fn({ type })); },
  };
  // Helper: 供 lazy 模式下让 win.turnstile 可用（脚本后到场景），
  //   同时保留 wt 的 render 闭包以让 renderRegistry 生效。
  const installTurnstile = () => {
    if (win.turnstile) return; // already installed
    win.turnstile = { render: mkRender(), reset: () => {}, remove: () => {} };
  };
  // Helper: count renders to a specific DOM element (按 element 区分主/重置 widget)
  const countRendersTo = (elId) => renderRegistry.filter((r) => r.el && r.el.attrs && r.el.attrs.id === elId).length;
  return { win, getRenderRegistry: () => renderRegistry, getRenderCount: () => renderCount, countRendersTo, installTurnstile };
}

// 构造 vm context 并执行真实 inline scripts
function loadRealPage({ turnstileState = 'eager', sbOverride = null, location: loc = { search: '', hash: '', origin: 'http://localhost', href: 'http://localhost/' } } = {}) {
  const doc = buildAuthDom();
  const wt = mkWindowTurnstile(turnstileState);
  const sb = sbOverride || mkSb();
  // Set up the circular reference: window.supabase.createClient returns sb
  wt.win.supabase = { createClient: (url, key, opts) => {
    sb._calls.push({ path: 'createClient', args: { url, key, opts } });
    return sb;
  } };

  const historyState = [];
  const hist = { replaceState: (s, t, u) => { historyState.push(u); }, pushState: () => {} };
  // 镜像 location
  const locationMock = {
    get search() { return loc.search || ''; },
    get hash() { return loc.hash || ''; },
    get origin() { return loc.origin || 'http://localhost'; },
    get href() {
      return (loc.origin || 'http://localhost') + (loc.search || '') + (loc.hash || '');
    },
    set href(v) { /* not used in tests */ }
  };

  const ctx = {
    window: wt.win,
    document: doc,
    location: locationMock,
    history: hist,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    navigator: { userAgent: 'node-test', clipboard: undefined },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0') },
    Promise,
    URL,
    URLSearchParams,
    AbortController,
    setImmediate: (fn) => setImmediate(fn),
    queueMicrotask: (fn) => queueMicrotask(fn),
  };
  const vmCtx = vm.createContext(ctx);

  // Execute all inline scripts in order
  for (let i = 0; i < inlineScripts.length; i++) {
    try {
      vm.runInContext(inlineScripts[i], vmCtx, { filename: `inline-script-${i + 1}.js` });
    } catch (e) {
      throw new Error(`Script ${i + 1} execution failed: ${e.message}`);
    }
  }

  return {
    ctx: vmCtx,
    doc,
    wt,


await test('B.3 REPL', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  const r1 = env.wt.getRenderRegistry();
  console.log('r1:', r1.length, r1.map(r => r.el?.attrs?.id));
  env.ctx.closeResetPwdModal();
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  const r2 = env.wt.getRenderRegistry();
  console.log('r2:', r2.length, r2.map(r => r.el?.attrs?.id));
});
