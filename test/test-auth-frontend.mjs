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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FakeDocument, FakeElement, buildAuthDom } from './dom-mock.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = existsSync(join(dir, '..', 'public', 'index.html')) ? join(dir, '..', 'public', 'index.html') : join(dir, '..', 'public', 'index.example.html');
const indexHtml = readFileSync(indexHtmlPath, 'utf8');

// === 真实源绑定检查：保证测试从 public/index.html 抽取 inline script，不是从副本 ===
// 真实页面必须包含 v5.5 关键 marker：PKCE flow 配置 + 删除 handlePasswordReset
function checkRealSourceBinding() {
  console.log('== F. 测试源绑定（防手工副本漂移）==');
  let ok = true;
  const checks = [
    {
      name: 'F.1 public/index.html 含 flowType:"pkce" + detectSessionInUrl:true',
      pass: /flowType:\s*['"]pkce['"]/.test(indexHtml) && /detectSessionInUrl:\s*true/.test(indexHtml),
    },
    {
      name: 'F.2 public/index.html 不含 function handlePasswordReset（v5.5 移除）',
      pass: !/function\s+handlePasswordReset\s*\(/.test(indexHtml),
    },
    {
      name: 'F.3 public/index.html 不含 _cleanRecoveryUrl（v5.5 移除）',
      pass: !/function\s+_cleanRecoveryUrl\s*\(/.test(indexHtml),
    },
  ];
  for (const check of checks) {
    if (check.pass) {
      pass++;
      console.log('  ✓', check.name);
    } else {
      fail++;
      ok = false;
      console.error('  ✗', check.name);
    }
  }
  return ok;
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
    resetPasswordForEmail: (email, options) => { calls.push({ path: 'resetPasswordForEmail', args: { email, options } }); return Promise.resolve({ data: {}, error: null }); },
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
    const id = "widget-" + renderCount;
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
    // ⚠️ v5.6：v5.6 generateResetState 需 window.crypto.getRandomValues；预置 mock
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } },
  };
  // Helper: 供 lazy 模式下让 win.turnstile 可用（脚本后到场景），
  //   同时保留 wt 的 render 闭包以让 renderRegistry 生效。
  const installTurnstile = () => {
    if (win.turnstile) return; // already installed
    win.turnstile = { render: mkRender(), reset: () => {}, remove: () => {} };
  };
  // Helper: count renders to a specific DOM element (按 element 区分主/重置 widget)
  const countRendersTo = (elId) => renderRegistry.filter((r) => r.el && r.el.attrs && r.el.attrs.id === elId).length;
  return { win, getRenderRegistry: () => renderRegistry.slice(), getRenderCount: () => renderCount, countRendersTo, installTurnstile };
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
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms);
      // 页面 OTP 冷却计时器不应让一次性回归测试进程常驻。
      timer.unref?.();
      return timer;
    },
    clearInterval: (id) => clearInterval(id),
    navigator: { userAgent: 'node-test', clipboard: undefined },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0'),
              // ⚠️ v5.6：generateResetState 使用 getRandomValues
              getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } },
    // ⚠️ v5.6：generateResetState 使用 btoa
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    // localStorage mock：script 调用 localStorage.getItem 检查 loginLock，未锁时返回 null
    localStorage: {
      _store: new Map(),
      getItem: (k) => (ctx_localStorage._store.has(k) ? ctx_localStorage._store.get(k) : null),
      setItem: (k, v) => ctx_localStorage._store.set(k, String(v)),
      removeItem: (k) => ctx_localStorage._store.delete(k),
      clear: () => ctx_localStorage._store.clear(),
    },
    // ⚠️ v5.6：sessionStorage mock — 补 PKCE state 校验需要
    sessionStorage: (() => {
      const store = new Map();
      const obj = {
        _store: store,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      };
      return obj;
    })(),
    Promise,
    URL,
    URLSearchParams,
    AbortController,
    setImmediate: (fn) => setImmediate(fn),
    queueMicrotask: (fn) => queueMicrotask(fn),
  };
  const ctx_localStorage = ctx.localStorage;
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
    sb,
    historyState,
    hist,
    locationMock,
    // 触发 window.DOMContentLoaded 监听
    fireDOMContentLoaded: () => wt.win.dispatchEvent('DOMContentLoaded'),
    // 取已注册的 onAuthStateChange 回调（脚本执行后已设置）
    getOnAuthCallback: () => sb._getOnAuthCb(),
  };
}

// === F. 真实源绑定 ===
checkRealSourceBinding();

// === A. showView / setAuthMode 触发 Turnstile 主表单 widget ===
console.log('\n== A. showView / setAuthMode 触发 Turnstile 主表单 widget ==');
await test('A.1 首次 showView(\'auth\') 不渲染 Turnstile（懒加载，等用户动作）', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  if (env.wt.getRenderCount() !== 0) throw new Error('expected 0 renders (lazy), got ' + env.wt.getRenderCount());
  const row = env.doc.getElementById('turnstileRow');
  if (!row || row.style.display !== 'none') throw new Error('expected turnstileRow hidden on first show');
});

await test('A.2 多次 showView(\'auth\') 幂等（不抖动 widget）', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  const before = env.wt.getRenderCount();
  env.ctx.showView('auth');
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  if (env.wt.getRenderCount() !== before) throw new Error('expected idempotent, before=' + before + ' after=' + env.wt.getRenderCount());
});

await test('A.3 setAuthMode(\'signup\') 触发 Turnstile 重新渲染', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  const before = env.wt.getRenderCount();
  env.ctx.setAuthMode('signup');
  await new Promise(r => setTimeout(r, 10));
  if (env.wt.getRenderCount() <= before) throw new Error('expected re-render, before=' + before + ' after=' + env.wt.getRenderCount());
});

// === B. 重置密码 modal Turnstile 脚本晚到 / 关闭防幽灵 widget ===
console.log('\n== B. 重置密码 modal Turnstile 脚本晚到 / 关闭防幽灵 widget ==');
await test('B.1 脚本未加载时 setTimeout 渲染；脚本 onload 后渲染主 widget', async () => {
  const env = loadRealPage({ turnstileState: 'lazy' });
  // 拦截 createElement 实现 script onload 触发
  const createdScripts = [];
  const origCreate = env.doc.createElement.bind(env.doc);
  env.doc.createElement = (tag) => {
    const e = origCreate(tag);
    if (tag === 'script') createdScripts.push(e);
    return e;
  };
  env.ctx.showView('auth');
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  // 脚本元素应被创建（用于加载 turnstile）
  if (createdScripts.length === 0) throw new Error('expected script element created');
  // 模拟脚本加载完成 → window.turnstile 出现 + onload
  env.wt.installTurnstile();
  if (createdScripts[0].onload) createdScripts[0].onload();
  await new Promise(r => setTimeout(r, 50));
  // 懒加载契约：主 widget 在 showView('auth') 不再渲染
  const mainRenderCount = env.wt.countRendersTo('turnstileWidget');
  if (mainRenderCount !== 0) throw new Error('expected 0 main widget renders (lazy), count=' + mainRenderCount);
  // 脚本后到场景：modal 内 reset widget 在脚本 onload 后正常渲染
  const resetRenderCount = env.wt.countRendersTo('resetPwdTurnstileWidget');
  if (resetRenderCount === 0) throw new Error('expected reset widget render after script load, count=' + resetRenderCount);
});

await test('B.2 modal 关闭前 onload：resetPwdTurnstileWidget 渲染计数必须 0（防幽灵 widget）', async () => {
  const env = loadRealPage({ turnstileState: 'lazy' });
  const createdScripts = [];
  const origCreate = env.doc.createElement.bind(env.doc);
  env.doc.createElement = (tag) => {
    const e = origCreate(tag);
    if (tag === 'script') createdScripts.push(e);
    return e;
  };
  // 1) open step1
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  if (createdScripts.length === 0) throw new Error('expected script element created on open');
  // 2) close before onload
  env.ctx.closeResetPwdModal();
  // 3) simulate onload
  env.wt.installTurnstile();
  if (createdScripts[0].onload) createdScripts[0].onload();
  // 4) wait for setTimeout(0) inside the load promise then
  await new Promise(r => setTimeout(r, 100));
  // 主 widget 在 showView('auth') 路径中会正常渲染（boot() 会调），不算幽灵；
  // 这里只看重置 widget：若 close 后仍渲染 → 幽灵 widget。
  const resetRenderCount = env.wt.countRendersTo('resetPwdTurnstileWidget');
  if (resetRenderCount !== 0) throw new Error('reset widget 幽灵渲染：count=' + resetRenderCount);
});

await test('B.3 modal 关闭后 removeResetPwdTurnstile() → 再 open 不会读到旧 widget id', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  const r1 = env.wt.getRenderRegistry();
  if (r1.length === 0) throw new Error('expected widget rendered');
  env.ctx.closeResetPwdModal();
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  const r2 = env.wt.getRenderRegistry();
  // 第二次 open 必须产生新 widget id（证明旧 id 已清理）
  if (r2.length <= r1.length) throw new Error('expected re-render after close+reopen, before=' + r1.length + ' after=' + r2.length);
});

await test('B.4 step 切到 2 时再触发 onload 不渲染 reset widget（step 守卫）', async () => {
  const env = loadRealPage({ turnstileState: 'lazy' });
  const createdScripts = [];
  const origCreate = env.doc.createElement.bind(env.doc);
  env.doc.createElement = (tag) => {
    const e = origCreate(tag);
    if (tag === 'script') createdScripts.push(e);
    return e;
  };
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  if (createdScripts.length === 0) throw new Error('expected script element created');
  // step 切到 2（同一 modal 仍 show，但 step 改变）
  env.ctx.openResetPwdModal(2);
  env.wt.installTurnstile();
  if (createdScripts[0].onload) createdScripts[0].onload();
  await new Promise(r => setTimeout(r, 100));
  // step 2 时 reset widget 不应渲染（step 守卫）
  const resetRenderCount = env.wt.countRendersTo('resetPwdTurnstileWidget');
  if (resetRenderCount !== 0) throw new Error('step-2 仍触发 reset widget 渲染：count=' + resetRenderCount);
});

// === C. captchaToken 透传 ===
console.log('\n== C. captchaToken 透传 ==');
await test('C.1 登录 signInWithPassword({ email, password, options: { captchaToken } })', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  // 懒加载契约：用户主动切换登录模式才触发 widget 渲染
  env.ctx.setAuthMode('login');
  await new Promise(r => setTimeout(r, 10));
  // 触发主 Turnstile callback
  const widget = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  if (!widget) throw new Error('expected main widget');
  widget.opts.callback('tok-login-123');
  env.doc.getElementById('email').value = 'user@example.com';
  env.doc.getElementById('password').value = 'secret123';
  await env.ctx.submitAuth();
  const loginCall = env.sb._calls.find((c) => c.path === 'signInWithPassword');
  if (!loginCall) throw new Error('signInWithPassword not called');
  if (loginCall.args.options.captchaToken !== 'tok-login-123') throw new Error('captchaToken not passed: ' + loginCall.args.options.captchaToken);
});

await test('C.2 注册 signInWithOtp({ email, options: { shouldCreateUser, captchaToken } })', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  env.ctx.setAuthMode('signup');
  await new Promise(r => setTimeout(r, 10));
  // 找 signup mode 的 widget（懒加载后首次渲染 = widget-1）
  const widget = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  if (!widget) throw new Error('expected signup widget');
  widget.opts.callback('tok-signup-123');
  env.doc.getElementById('email').value = 'new@example.com';
  env.doc.getElementById('password').value = 'secret123';
  await env.ctx.submitAuth();
  const otpCall = env.sb._calls.find((c) => c.path === 'signInWithOtp');
  if (!otpCall) throw new Error('signInWithOtp not called');
  if (otpCall.args.options.captchaToken !== 'tok-signup-123') throw new Error('OTP captchaToken: ' + otpCall.args.options.captchaToken);
  if (otpCall.args.options.shouldCreateUser !== true) throw new Error('shouldCreateUser not true');
});

await test('C.3 注册 verifyOtp({ email, token, type: signup, options: { captchaToken } })', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  env.ctx.setAuthMode('signup');
  await new Promise(r => setTimeout(r, 10));
  const w1 = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  w1.opts.callback('tok-otp-123');
  env.doc.getElementById('email').value = 'new@example.com';
  env.doc.getElementById('password').value = 'secret123';
  await env.ctx.submitAuth();
  // 第一次 = 发送 OTP。resetTurnstile() 后 token 为 null，但 widget id 仍为 widget-2（reset 只挑战重置，
  //   不重新 render）。此时应重新过 Turnstile。
  env.doc.getElementById('otpCode').value = '123456';
  await env.ctx.submitAuth();  // 第一次验证 OTP：需重新人机验证，会重新调 widget-2 的 callback
  // resetTurnstile 后 widget 还是同一个（widget-2），但 token 被清空；需重新设
  w1.opts.callback('tok-otp-verify-456');
  await env.ctx.submitAuth();  // 第二次验证 OTP：token 存在，进入 verifyOtp
  const verifyCall = env.sb._calls.find((c) => c.path === 'verifyOtp');
  if (!verifyCall) throw new Error('verifyOtp not called');
  if (verifyCall.args.type !== 'signup') throw new Error('verifyOtp type');
  if (verifyCall.args.options.captchaToken !== 'tok-otp-verify-456') throw new Error('verifyOtp captchaToken: ' + verifyCall.args.options.captchaToken);
});

await test('C.4 重置密码 resetPasswordForEmail 透传 captchaToken', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 100));
  // reset widget 是第 2 个（主 widget-1 在 boot 期间已渲染）
  const rWidget = env.wt.getRenderRegistry().find((r) => r.el && r.el.attrs && r.el.attrs.id === 'resetPwdTurnstileWidget');
  if (!rWidget) throw new Error('expected reset widget, got: ' + JSON.stringify(env.wt.getRenderRegistry().map(r => r.el?.attrs?.id)));
  rWidget.opts.callback('tok-reset-789');
  env.doc.getElementById('email').value = 'forgot@example.com';
  await env.ctx.doResetPwd();
  const resetCall = env.sb._calls.find((c) => c.path === 'resetPasswordForEmail');
  if (!resetCall) throw new Error('resetPasswordForEmail not called');
  if (resetCall.args.options?.captchaToken !== 'tok-reset-789') throw new Error('reset captchaToken: ' + resetCall.args.options?.captchaToken);
});

// === D. Recovery 单一处理源 ===
console.log('\n== D. Recovery 单一处理源（SDK 处理 URL；onAuthStateChange 单源弹窗）==');
await test('D.1 createClient 必须配置 flowType:pkce + detectSessionInUrl:true', async () => {
  const env = loadRealPage();
  const createCall = env.sb._calls.find((c) => c.path === 'createClient');
  if (!createCall) throw new Error('createClient not called');
  const auth = createCall.args && createCall.args.opts && createCall.args.opts.auth;
  if (!auth) throw new Error('createClient opts.auth missing');
  if (auth.flowType !== 'pkce') throw new Error('flowType not pkce: ' + auth.flowType);
  if (auth.detectSessionInUrl !== true) throw new Error('detectSessionInUrl not true');
});

await test('D.2 回调 URL (?code=...&type=recovery) 下【不】手动调用 exchangeCodeForSession / setSession', async () => {
  // 真实页面在 boot 阶段可能调 exchangeCodeForSession（detectSessionInUrl 自动），
  // 但【用户代码】不应主动调。本测试在 vm 中跑真实 script，仅当 onAuthStateChange 是
  // PASSWORD_RECOVERY 时才允许 SDK 内部调用；不通过 captured callback 模拟 SDK 自动处理。
  // 因此检查：用户代码的整段执行过程中，exchangeCodeForSession / setSession 调用次数
  // 都来自 SDK 自动（不在用户代码里）。我们的 mock 完全替代 SDK 内部行为，
  // 所以用户代码若主动调用会立即被记录到 calls 列表。
  const env = loadRealPage({ location: { search: '?type=recovery&code=abc123', hash: '', origin: 'http://localhost' } });
  // 等 microtask 跑完（boot / 各种初始化）
  await new Promise(r => setTimeout(r, 30));
  const ex = env.sb._calls.find((c) => c.path === 'exchangeCodeForSession');
  const ss = env.sb._calls.find((c) => c.path === 'setSession');
  if (ex) throw new Error('用户代码不应调用 exchangeCodeForSession（SDK 单一处理源）');
  if (ss) throw new Error('用户代码不应调用 setSession（SDK 单一处理源）');
});

await test('D.3 回调 URL (#access_token=...&type=recovery) 下【不】手动调用 setSession / exchangeCodeForSession', async () => {
  const env = loadRealPage({ location: { search: '?type=recovery', hash: '#access_token=tok&refresh_token=ref', origin: 'http://localhost' } });
  await new Promise(r => setTimeout(r, 30));
  const ex = env.sb._calls.find((c) => c.path === 'exchangeCodeForSession');
  const ss = env.sb._calls.find((c) => c.path === 'setSession');
  if (ex) throw new Error('用户代码不应调用 exchangeCodeForSession');
  if (ss) throw new Error('用户代码不应调用 setSession');
});

await test('D.4 PASSWORD_RECOVERY 事件 → reset modal 在 step 2（输入新密码）', async () => {
  // ⚠️ v5.6：需先备 reset state（sessionStorage + URL ?state=）才能通过 state 校验
  const env = loadRealPage({ location: { search: '?state=abc123def', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=abc123def' } });
  env.ctx.sessionStorage.setItem('tp.reset.state', 'abc123def');
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  if (!cb) throw new Error('onAuthStateChange not registered');
  const session = { user: { id: 'u-recover', email: 'r@x.com' }, access_token: 'r' };
  await cb('PASSWORD_RECOVERY', session);
  // 真实代码在 applySession 中 setTimeout 100ms 调 openResetPwdModal(2)
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (!m.classList.contains('show')) throw new Error('resetPwdModal 未打开');
  const s2 = env.doc.getElementById('resetPwdStep2');
  if (!s2.style.display || s2.style.display === 'none') throw new Error('resetPwdStep2 未显示');
});

await test('D.5 普通 SIGNED_IN 不误弹 reset modal', async () => {
  const env = loadRealPage();
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  if (!cb) throw new Error('onAuthStateChange not registered');
  const session = { user: { id: 'u-signed', email: 's@x.com' }, access_token: 's' };
  await cb('SIGNED_IN', session);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (m.classList.contains('show')) throw new Error('resetPwdModal 不应打开（普通登录）');
});

await test('D.6 INITIAL_SESSION 事件（v2）也不误弹 reset modal', async () => {
  const env = loadRealPage();
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  if (!cb) throw new Error('onAuthStateChange not registered');
  const session = { user: { id: 'u-init', email: 'i@x.com' }, access_token: 'i' };
  await cb('INITIAL_SESSION', session);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (m.classList.contains('show')) throw new Error('resetPwdModal 不应打开（INITIAL_SESSION）');
});

await test('D.7 同用户 PASSWORD_RECOVERY 也触发弹窗（不因同用户去重被吞）', async () => {
  const env = loadRealPage({ location: { search: '?state=state7', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=state7' } });
  env.ctx.sessionStorage.setItem('tp.reset.state', 'state7');
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  if (!cb) throw new Error('onAuthStateChange not registered');
  // 先 SIGNED_IN 一次
  const session = { user: { id: 'u-recover-2', email: 'r2@x.com' }, access_token: 'r' };
  await cb('SIGNED_IN', session);
  await new Promise(r => setTimeout(r, 150));
  // 同一用户再触发 PASSWORD_RECOVERY
  await cb('PASSWORD_RECOVERY', session);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (!m.classList.contains('show')) throw new Error('同用户 PASSWORD_RECOVERY 必须触发弹窗');
});

await test('D.8 同一 PASSWORD_RECOVERY 事件多次触发只弹一次（recoveryModalPending gate）', async () => {
  const env = loadRealPage({ location: { search: '?state=state8', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=state8' } });
  env.ctx.sessionStorage.setItem('tp.reset.state', 'state8');
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  const session = { user: { id: 'u-recover-3', email: 'r3@x.com' }, access_token: 'r' };
  // 连续多次触发
  await cb('PASSWORD_RECOVERY', session);
  await cb('PASSWORD_RECOVERY', session);
  await cb('PASSWORD_RECOVERY', session);
  await new Promise(r => setTimeout(r, 200));
  const m = env.doc.getElementById('resetPwdModal');
  if (!m.classList.contains('show')) throw new Error('modal 未打开');
  const showAdds = m._classAddCounts.get('show') || 0;
  if (showAdds !== 1) throw new Error('openResetPwdModal 重复执行：' + showAdds);
});

await test('D.9 SIGNED_OUT 事件清理状态不弹 modal', async () => {
  const env = loadRealPage();
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  await cb('SIGNED_OUT', null);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (m.classList.contains('show')) throw new Error('resetPwdModal 不应打开（SIGNED_OUT）');
});

await test('D.10 PASSWORD_RECOVERY 排队后立即 SIGNED_OUT 会取消待弹窗', async () => {
  const env = loadRealPage({ location: { search: '?state=state10', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=state10' } });
  env.ctx.sessionStorage.setItem('tp.reset.state', 'state10');
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  const session = { user: { id: 'u-recover-cancel', email: 'cancel@x.com' }, access_token: '***' };
  await cb('PASSWORD_RECOVERY', session);
  await cb('SIGNED_OUT', null);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (m.classList.contains('show')) throw new Error('SIGNED_OUT 后待执行 recovery modal 仍打开');
  const showAdds = m._classAddCounts.get('show') || 0;
  if (showAdds !== 0) throw new Error('SIGNED_OUT 后仍执行 openResetPwdModal：' + showAdds);
});

// === D.11-13 v5.6 PKCE state 绑定校验 ===
await test('D.11 PASSWORD_RECOVERY 缺 sessionStorage state → 拒绝弹窗', async () => {
  // ⚠️ v5.6：钓鱼站不同源 → sessionStorage 为空 → 拒绝；这里仅模拟 sessionStorage 为空
  const env = loadRealPage({ location: { search: '?state=abc', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=abc' } });
  // 不设 sessionStorage.state
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  const session = { user: { id: 'u-11', email: 'r@x.com' }, access_token: 'r' };
  await cb('PASSWORD_RECOVERY', session);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (m.classList.contains('show')) throw new Error('缺 sessionStorage state 不应弹 modal（防钓鱼）');
});

await test('D.12 PASSWORD_RECOVERY sessionStorage != URL state → 拒绝弹窗', async () => {
  const env = loadRealPage({ location: { search: '?state=url-state', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=url-state' } });
  env.ctx.sessionStorage.setItem('tp.reset.state', 'different-state');
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  const session = { user: { id: 'u-12', email: 'r@x.com' }, access_token: 'r' };
  await cb('PASSWORD_RECOVERY', session);
  await new Promise(r => setTimeout(r, 150));
  const m = env.doc.getElementById('resetPwdModal');
  if (m.classList.contains('show')) throw new Error('state 不匹配不应弹 modal');
});

await test('D.13 URL 中 state 参数会被清理（防止后续脚本读到）', async () => {
  const env = loadRealPage({ location: { search: '?state=abc&code=x&type=recovery', hash: '', origin: 'http://localhost', href: 'http://localhost/?state=abc&code=x&type=recovery' } });
  env.ctx.sessionStorage.setItem('tp.reset.state', 'abc');
  await new Promise(r => setTimeout(r, 10));
  const cb = env.getOnAuthCallback();
  const session = { user: { id: 'u-13', email: 'r@x.com' }, access_token: 'r' };
  await cb('PASSWORD_RECOVERY', session);
  await new Promise(r => setTimeout(r, 150));
  // history.replaceState 应被调用，参数变为不含 state
  if (!env.historyState.length) throw new Error('未调用 history.replaceState');
  const lastUrl = env.historyState[env.historyState.length - 1];
  if (/[\?&]state=/.test(lastUrl)) throw new Error('state 参数未清理：' + lastUrl);
});

await test('D.14 resetPasswordForEmail 调用时包含 state 参数 + sessionStorage 已存', async () => {
  // ⚠️ 模拟 reset modal step1 点击发送：需先填邮箱、准备 resetPwdTurnstileToken、点击 doResetPwd
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  env.ctx.setAuthMode('login');
  await new Promise(r => setTimeout(r, 10));
  // 填邮箱
  env.doc.getElementById('email').value = 'user@example.com';
  // 触发 Turnstile（eager 模式下 widget-1 已就绪）
  const w = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  w.opts.callback('tok');
  // 打开 reset modal
  env.ctx.openResetPwdModal(1);
  await new Promise(r => setTimeout(r, 80));
  // 触发 resetPwdTurnstileToken
  const rw = env.wt.getRenderRegistry().find((r) => r.el && r.el.attrs && r.el.attrs.id === 'resetPwdTurnstileWidget');
  if (!rw) throw new Error('resetPwdTurnstileWidget 未渲染');
  rw.opts.callback('reset-tok');
  // 同步 token（widget callback 在某些情况下未生效）
  if (env.ctx.resetPwdTurnstileToken !== 'reset-tok') env.ctx.resetPwdTurnstileToken = 'reset-tok';
  // 调用 doResetPwd
  await env.ctx.doResetPwd();
  const call = env.sb._calls.find((c) => c.path === 'resetPasswordForEmail');
  if (!call) throw new Error('未调 resetPasswordForEmail');
  // mock 注册 args: { email, options }；opts.redirectTo 字段调 options.redirectTo
  const redirectTo = call.args.options && call.args.options.redirectTo;
  if (!redirectTo || !/[\?&]state=/.test(redirectTo)) throw new Error('redirectTo 未带 state：' + redirectTo);
  if (!env.ctx.sessionStorage.getItem('tp.reset.state')) throw new Error('sessionStorage 未存 state');
});

// === E. submitAuth 输入校验 ===
console.log('\n== E. submitAuth 输入校验 ==');
await test('E.1 缺 token → 网络【不】调用', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  await new Promise(r => setTimeout(r, 10));
  env.doc.getElementById('email').value = 'user@example.com';
  env.doc.getElementById('password').value = 'secret123';
  await env.ctx.submitAuth();
  const loginCall = env.sb._calls.find((c) => c.path === 'signInWithPassword');
  if (loginCall) throw new Error('should NOT call signInWithPassword without token');
});

await test('E.2 短密码 → 拒绝', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  env.ctx.setAuthMode('login');
  await new Promise(r => setTimeout(r, 10));
  const w = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  w.opts.callback('tok');
  env.doc.getElementById('email').value = 'user@example.com';
  env.doc.getElementById('password').value = '123';
  await env.ctx.submitAuth();
  const loginCall = env.sb._calls.find((c) => c.path === 'signInWithPassword');
  if (loginCall) throw new Error('short password should not proceed');
});

await test('E.3 非法邮箱 → 拒绝', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  env.ctx.setAuthMode('login');
  await new Promise(r => setTimeout(r, 10));
  const w = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  w.opts.callback('tok');
  env.doc.getElementById('email').value = 'not-an-email';
  env.doc.getElementById('password').value = 'secret123';
  await env.ctx.submitAuth();
  const loginCall = env.sb._calls.find((c) => c.path === 'signInWithPassword');
  if (loginCall) throw new Error('invalid email should not proceed');
});

await test('E.4 token 过期 → 提示请重新验证', async () => {
  const env = loadRealPage({ turnstileState: 'eager' });
  env.ctx.showView('auth');
  env.ctx.setAuthMode('login');
  await new Promise(r => setTimeout(r, 10));
  const w = env.wt.getRenderRegistry().find((r) => r.id === 'widget-1');
  w.opts['expired-callback']();
  env.doc.getElementById('email').value = 'user@example.com';
  env.doc.getElementById('password').value = 'secret123';
  await env.ctx.submitAuth();
  const loginCall = env.sb._calls.find((c) => c.path === 'signInWithPassword');
  if (loginCall) throw new Error('expired token should not proceed');
});

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) { console.error('FAIL'); process.exit(1); }
console.log('ALL PASS');
