import { buildAuthDom, FakeElement, FakeDocument } from '/root/project/llm-key-manager/test/dom-mock.mjs';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync('/root/project/llm-key-manager/public/index.html', 'utf8');
const scriptRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const inlineScripts = [...indexHtml.matchAll(scriptRe)].map((m) => m[1]);

function mkSb() {
  const calls = [];
  let onAuthCb = null;
  const builder = { select: function () { return this; }, eq: function () { return this; }, maybeSingle: function () { return Promise.resolve({ data: null, error: null }); }, then: function (resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } };
  const sbAuth = { signInWithOtp: () => Promise.resolve({ data: {}, error: null }), signInWithPassword: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }), verifyOtp: () => Promise.resolve({ data: {}, error: null }), updateUser: () => Promise.resolve({ data: {}, error: null }), resetPasswordForEmail: () => Promise.resolve({ data: {}, error: null }), setSession: () => Promise.resolve({ data: {}, error: null }), exchangeCodeForSession: () => Promise.resolve({ data: {}, error: null }), signOut: () => Promise.resolve({ error: null }), getSession: () => Promise.resolve({ data: { session: null }, error: null }), onAuthStateChange: (cb) => { onAuthCb = cb; return { data: { subscription: { unsubscribe: () => {} } } }; } };
  return { auth: sbAuth, from: () => builder, rpc: () => Promise.resolve({ data: 0, error: null }), _calls: calls, _getOnAuthCb: () => onAuthCb };
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
    addEventListener: () => {},
  };
  return { win, getRenderRegistry: () => renderRegistry, getRenderCount: () => renderCount, countRendersTo: (id) => renderRegistry.filter(r => r.el?.attrs?.id === id).length };
}

function loadRealPage({ turnstileState = 'eager', sbOverride = null, location: loc = { search: '', hash: '', origin: 'http://localhost', href: 'http://localhost/' } } = {}) {
  const doc = buildAuthDom();
  const wt = mkWindowTurnstile(turnstileState);
  const sb = sbOverride || mkSb();
  wt.win.supabase = { createClient: () => sb };

  const historyState = [];
  const hist = { replaceState: () => {}, pushState: () => {} };
  const locationMock = { get search() { return loc.search || ''; }, get hash() { return loc.hash || ''; }, get origin() { return loc.origin || 'http://localhost'; }, get href() { return (loc.origin || 'http://localhost') + (loc.search || '') + (loc.hash || ''); } };

  const ctx = { window: wt.win, document: doc, location: locationMock, history: hist, console, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout, setInterval: (fn, ms) => setInterval(fn, ms), clearInterval, navigator: { userAgent: 'node-test' }, crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000001' }, Promise, URL, URLSearchParams, AbortController, setImmediate, queueMicrotask };
  const vmCtx = vm.createContext(ctx);
  for (let i = 0; i < inlineScripts.length; i++) {
    vm.runInContext(inlineScripts[i], vmCtx, { filename: `inline-script-${i+1}.js` });
  }
  return { ctx: vmCtx, doc, wt, sb };
}

const env = loadRealPage({ turnstileState: 'eager' });
console.log('script done');
env.ctx.openResetPwdModal(1);
await new Promise(r => setTimeout(r, 100));
const r1 = env.wt.getRenderRegistry();
console.log('r1:', r1.length, r1.map(r => r.el?.attrs?.id));
env.ctx.closeResetPwdModal();
env.ctx.openResetPwdModal(1);
await new Promise(r => setTimeout(r, 100));
const r2 = env.wt.getRenderRegistry();
console.log('r2:', r2.length, r2.map(r => r.el?.attrs?.id));
