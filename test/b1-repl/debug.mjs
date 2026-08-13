// Replicate the test more exactly
import { buildAuthDom, FakeElement } from '../dom-mock.mjs';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync('/root/project/llm-key-manager/public/index.html', 'utf8');
const scriptRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const inlineScripts = [...indexHtml.matchAll(scriptRe)].map((m) => m[1]);

function mkSb() {
  const calls = [];
  let onAuthCb = null;
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
    then: function (resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
  };
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
  return {
    auth: sbAuth,
    from: (table) => { calls.push({ path: 'from', args: table }); return builder; },
    rpc: (name, args) => { calls.push({ path: 'rpc', args: { name, args } }); return Promise.resolve({ data: 0, error: null }); },
    _calls: calls,
    _setOnAuthCb: (cb) => { onAuthCb = cb; },
    _getOnAuthCb: () => onAuthCb,
  };
}

function mkWindowTurnstile(turnstileState = 'eager') {
  const renderRegistry = [];
  let renderCount = 0;
  const win = {
    turnstile: turnstileState === 'eager' ? {
      render: (el, opts) => {
        renderCount++;
        const id = 'widget-' + renderCount;
        renderRegistry.push({ id, el, opts });
        return id;
      },
      reset: (id) => {},
      remove: (id) => {}
    } : null,
    supabase: null,
    addEventListener: (type, fn) => { (win._listeners = win._listeners || {})[type] = (win._listeners[type] || []).concat([fn]); },
    dispatchEvent: (type) => { (win._listeners || {})[type]?.forEach(fn => fn({ type })); },
  };
  const countRendersTo = (elId) => renderRegistry.filter((r) => r.el && r.el.attrs && r.el.attrs.id === elId).length;
  return { win, getRenderRegistry: () => renderRegistry, getRenderCount: () => renderCount, countRendersTo };
}

function loadRealPage({ turnstileState = 'eager', sbOverride = null, location: loc = { search: '', hash: '', origin: 'http://localhost', href: 'http://localhost/' } } = {}) {
  const doc = buildAuthDom();
  const wt = mkWindowTurnstile(turnstileState);
  const sb = sbOverride || mkSb();
  wt.win.supabase = { createClient: (url, key, opts) => {
    sb._calls.push({ path: 'createClient', args: { url, key, opts } });
    return sb;
  } };

  const historyState = [];
  const hist = { replaceState: (s, t, u) => { historyState.push(u); }, pushState: () => {} };
  const locationMock = {
    get search() { return loc.search || ''; },
    get hash() { return loc.hash || ''; },
    get origin() { return loc.origin || 'http://localhost'; },
    get href() { return (loc.origin || 'http://localhost') + (loc.search || '') + (loc.hash || ''); },
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

  for (let i = 0; i < inlineScripts.length; i++) {
    try {
      vm.runInContext(inlineScripts[i], vmCtx, { filename: `inline-script-${i + 1}.js` });
    } catch (e) {
      throw new Error(`Script ${i + 1} execution failed: ${e.message}`);
    }
  }

  return { ctx: vmCtx, doc, wt, sb, historyState, hist, locationMock, getOnAuthCallback: () => sb._getOnAuthCb() };
}

const env = loadRealPage({ turnstileState: 'lazy' });
const createdScripts = [];
const origCreate = env.doc.createElement.bind(env.doc);
env.doc.createElement = (tag) => {
  const e = origCreate(tag);
  if (tag === 'script') { createdScripts.push(e); console.log('script created'); }
  return e;
};

env.ctx.showView('auth');
env.ctx.openResetPwdModal(1);
await new Promise(r => setTimeout(r, 100));
console.log('scripts:', createdScripts.length);

env.wt.win.turnstile = { render: (el, opts) => { console.log('RENDER called for', el?.attrs?.id); return 'w-late'; }, reset: () => {}, remove: () => {} };
if (createdScripts[0]?.onload) { console.log('onload called'); createdScripts[0].onload(); }
await new Promise(r => setTimeout(r, 50));
console.log('renders:', env.wt.getRenderCount());
console.log('registry:', env.wt.getRenderRegistry().length);
