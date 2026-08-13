// 提取自 public/index.html 的可测试 auth/turnstile/recovery 函数族。
// 注入 sb (mock supabase) + window/document + location/history。
// 行为与 index.html 严格一致；只去除 DOM 强耦合。
//
// 导出：showView, setAuthMode, scheduleTurnstileRender, renderTurnstile,
//       renderResetPwdTurnstile, handlePasswordReset, submitAuth, openResetPwdModal,
//       doResetPwd, forgotPassword, loadTurnstile, resetTurnstile, resetResetPwdTurnstile,
//       removeResetPwdTurnstile, applySession, resetAllForTest
//
// 注入：通过 setEnv({ sb, window, document, location, history, setTimeout, console, toast, openResetPwdModal, applySession, ... }) 注入
export function createAuth(env) {
  env = env || {};
  const sb = env.sb;
  const window_ = env.window || globalThis;
  const document_ = env.document || (window_.document);
  const location_ = env.location || window_.location;
  const history_ = env.history || window_.history;
  const console_ = env.console || console;
  const setTimeout_ = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const toast = env.toast || ((m, t) => { /* noop */ });
  const applySessionFn = env.applySession || (async () => {});

  // capture: 让注入的 location 变更能被测试看到
  let lastLocation = typeof location_ === 'string' ? new URL(location_) : (location_.href ? new URL(location_.href) : new URL('http://localhost/'));

  let authMode = 'login';
  let otpPendingEmail = null;
  let turnstileToken = null;
  let turnstileWidgetId = null;
  let resetPwdTurnstileToken = null;
  let resetPwdTurnstileWidgetId = null;
  let passwordRecoveryPending = false;
  let passwordRecoveryHandled = false;
  let currentUserId = null;
  let turnstileScriptPromise = null;
  let turnstileScriptLoadError = false;
  let TURNSTILE_SITEKEY = '__TURNSTILE_SITEKEY__';

  function showView(n) {
    if (document_.getElementById('bootMsg')) document_.getElementById('bootMsg').style.display = 'none';
    if (document_.getElementById('authView')) document_.getElementById('authView').style.display = n === 'auth' ? 'block' : 'none';
    if (document_.getElementById('mainView')) document_.getElementById('mainView').style.display = n === 'main' ? 'block' : 'none';
    if (n === 'auth') {
      const mr = document_.getElementById('emailModeRow');
      if (mr) mr.style.display = 'block';
      const tr = document_.getElementById('turnstileRow');
      if (tr) tr.style.display = 'block';
      scheduleTurnstileRender();
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    // 仅更新样式（mock 保证 btn 存在）
    const lb = document_.getElementById('modeLoginBtn'); if (lb) { lb.style.background = isLogin ? 'primary' : 'gray'; lb.style.color = isLogin ? 'white' : 'text'; }
    const sb2 = document_.getElementById('modeSignupBtn'); if (sb2) { sb2.style.background = isLogin ? 'gray' : 'primary'; sb2.style.color = isLogin ? 'text' : 'white'; }
    const ab = document_.getElementById('authBtn'); if (ab) ab.textContent = isLogin ? 'login' : 'signup';
    const ot = document_.getElementById('otpRow'); if (ot) ot.style.display = 'none';
    otpPendingEmail = null;
    if (turnstileWidgetId !== null && window_.turnstile) { try { window_.turnstile.remove(turnstileWidgetId); } catch (e) {} turnstileWidgetId = null; }
    turnstileToken = null;
    const tr = document_.getElementById('turnstileRow'); if (tr) tr.style.display = 'block';
    scheduleTurnstileRender();
  }

  function loadTurnstile() {
    if (window_.turnstile) return Promise.resolve();
    if (turnstileScriptPromise) return turnstileScriptPromise;
    if (turnstileScriptLoadError) return Promise.reject(new Error('turnstile-load-failed'));
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const s = document_.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true; s.defer = true;
      s.onload = () => { resolve(); };
      s.onerror = () => { turnstileScriptLoadError = true; turnstileScriptPromise = null; toast('turnstile 加载失败', 'error'); reject(new Error('turnstile-load-failed')); };
      document_.head.appendChild(s);
    });
    return turnstileScriptPromise;
  }

  function renderTurnstileWidget() {
    if (turnstileWidgetId !== null) return;
    const el = document_.getElementById('turnstileWidget');
    if (!el || !window_.turnstile) return;
    try {
      turnstileWidgetId = window_.turnstile.render(el, {
        sitekey: TURNSTILE_SITEKEY,
        callback: (token) => { turnstileToken = token; },
        'error-callback': () => { turnstileToken = null; toast('turnstile error', 'error'); },
        'expired-callback': () => { turnstileToken = null; }
      });
    } catch (e) { console_.error('turnstile render:', e); }
  }

  function scheduleTurnstileRender() {
    if (turnstileWidgetId !== null) return;
    if (document_.getElementById('turnstallowed') && !document_.getElementById('turnstileWidget')) return;
    const el = document_.getElementById('turnstileWidget');
    if (!el) return;
    if (turnstileScriptLoadError) return;
    if (!window_.turnstile) {
      loadTurnstile().then(() => { setTimeout_(renderTurnstileWidget, 0); }).catch(() => {});
      return;
    }
    setTimeout_(renderTurnstileWidget, 0);
  }

  function renderTurnstile() { scheduleTurnstileRender(); }

  function resetTurnstile() {
    turnstileToken = null;
    try { if (window_.turnstile && turnstileWidgetId !== null) window_.turnstile.reset(turnstileWidgetId); } catch (e) {}
  }

  function renderResetPwdTurnstile() {
    if (resetPwdTurnstileWidgetId !== null) return;
    const el = document_.getElementById('resetPwdTurnstileWidget');
    if (!el) return;
    if (turnstileScriptLoadError) { toast('人机验证服务加载失败', 'error'); return; }
    if (!window_.turnstile) {
      loadTurnstile().then(() => { setTimeout_(renderResetPwdTurnstile, 0); }).catch(() => {});
      return;
    }
    try {
      resetPwdTurnstileWidgetId = window_.turnstile.render(el, {
        sitekey: TURNSTILE_SITEKEY,
        callback: (token) => { resetPwdTurnstileToken = token; },
        'error-callback': () => { resetPwdTurnstileToken = null; },
        'expired-callback': () => { resetPwdTurnstileToken = null; }
      });
    } catch (e) { console_.error('resetPwd turnstile render:', e); }
  }

  function resetResetPwdTurnstile() {
    resetPwdTurnstileToken = null;
    try { if (window_.turnstile && resetPwdTurnstileWidgetId !== null) window_.turnstile.reset(resetPwdTurnstileWidgetId); } catch (e) {}
  }

  function removeResetPwdTurnstile() {
    try { if (window_.turnstile && resetPwdTurnstileWidgetId !== null) window_.turnstile.remove(resetPwdTurnstileWidgetId); } catch (e) {}
    resetPwdTurnstileWidgetId = null;
    resetPwdTurnstileToken = null;
  }

  function _cleanRecoveryUrl() {
    try {
      // 真实环境 location_ 是Location对象，有 .href；测试环境则可能仅有 .search / .hash
      let href;
      if (typeof location_ === 'object') {
        href = location_.href || (location_.origin ? (location_.origin + (location_.search || '') + (location_.hash || '')) : null);
      } else if (typeof location_ === 'string') {
        href = location_;
      }
      if (!href) return;
      const real = new URL(href);
      real.searchParams.delete('access_token');
      real.searchParams.delete('refresh_token');
      real.searchParams.delete('type');
      real.searchParams.delete('expires_in');
      real.searchParams.delete('token_type');
      real.searchParams.delete('code');
      if (real.hash) real.hash = '';
      history_.replaceState(null, '', real.pathname + (real.search || '') + real.hash);
      lastLocation = real;
    } catch (e) {}
  }

  function handlePasswordReset() {
    if (passwordRecoveryHandled) return;
    const qp = new URLSearchParams((typeof location_ === 'object' ? location_.search : '') || '');
    const hashStr = (typeof location_ === 'object' ? (location_.hash || '') : '').replace(/^#/, '');
    const hp = new URLSearchParams(hashStr);
    const type = qp.get('type') || hp.get('type');
    if (type !== 'recovery') return;
    const code = qp.get('code');
    if (code) {
      passwordRecoveryHandled = true;
      passwordRecoveryPending = true;
      sb.auth.exchangeCodeForSession(code).then((r) => {
        if (r.error) {
          console_.error('reset: exchangeCodeForSession failed:', r.error);
          passwordRecoveryPending = false;
          _cleanRecoveryUrl();
          return;
        }
        _cleanRecoveryUrl();
      }).catch((e) => {
        console_.error('reset:', e);
        passwordRecoveryPending = false;
        _cleanRecoveryUrl();
      });
      return;
    }
    const at = qp.get('access_token') || hp.get('access_token');
    const rt = qp.get('refresh_token') || hp.get('refresh_token');
    if (at) {
      passwordRecoveryHandled = true;
      passwordRecoveryPending = true;
      sb.auth.setSession({ access_token: at, refresh_token: rt || '' }).then((r) => {
        if (r.error) { console_.error('reset:', r.error); passwordRecoveryPending = false; _cleanRecoveryUrl(); return; }
        _cleanRecoveryUrl();
      }).catch((e) => { console_.error('reset:', e); passwordRecoveryPending = false; _cleanRecoveryUrl(); });
    }
  }

  async function submitAuth() {
    const e = document_.getElementById('email').value.trim();
    const p = document_.getElementById('password').value;
    if (!e || !p) return toast('请填写邮箱和密码', 'error');
    if (p.length < 6) return toast('密码至少6位', 'error');
    if (!/^\S+@\S+\.\S+$/.test(e)) return toast('邮箱格式不正确', 'error');
    const b = document_.getElementById('authBtn'); b.disabled = true;
    try {
      if (authMode === 'signup') {
        if (!otpPendingEmail || otpPendingEmail !== e) {
          if (!turnstileToken) {
            document_.getElementById('turnstileRow').style.display = 'block';
            renderTurnstile();
            toast('请先完成人机验证', 'info');
            b.disabled = false; return;
          }
          const { data, error } = await sb.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true, captchaToken: turnstileToken } });
          resetTurnstile();
          if (error) throw error;
          otpPendingEmail = e;
          document_.getElementById('otpRow').style.display = 'block';
          document_.getElementById('otpCode').value = '';
          document_.getElementById('otpCode').focus();
          document_.getElementById('authBtn').textContent = '确认注册';
          return;
        }
        const code = document_.getElementById('otpCode').value.trim();
        if (!code || code.length !== 6) return toast('请输入6位验证码', 'error');
        if (!turnstileToken) { toast('请重新完成人机验证', 'error'); document_.getElementById('turnstileRow').style.display = 'block'; renderTurnstile(); return; }
        const { data: vData, error: vError } = await sb.auth.verifyOtp({ email: e, token: code, type: 'signup', options: { captchaToken: turnstileToken } });
        resetTurnstile();
        if (vError) throw vError;
        try { const { error: pwdErr } = await sb.auth.updateUser({ password: p }); if (pwdErr) throw pwdErr; } catch (e) { throw e; }
        return;
      } else {
        if (!turnstileToken) {
          document_.getElementById('turnstileRow').style.display = 'block';
          renderTurnstile();
          toast('请先完成人机验证', 'error');
          b.disabled = false; return;
        }
        const r = await sb.auth.signInWithPassword({ email: e, password: p, options: { captchaToken: turnstileToken } });
        resetTurnstile();
        if (r.error) throw r.error;
        return;
      }
    } catch (e) { toast(e.message || '操作失败', 'error'); }
    finally { b.disabled = false; }
  }

  function openResetPwdModal(step) {
    const step1 = document_.getElementById('resetPwdStep1');
    const step2 = document_.getElementById('resetPwdStep2');
    const btn = document_.getElementById('resetPwdBtn');
    const hint = document_.getElementById('resetPwdHint');
    const m = document_.getElementById('resetPwdModal');
    if (step === 1) {
      if (step1) step1.style.display = 'block';
      if (step2) step2.style.display = 'none';
      if (btn) btn.textContent = 'send';
      if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
      const tr = document_.getElementById('resetPwdTurnstileRow'); if (tr) tr.style.display = 'block';
      setTimeout_(renderResetPwdTurnstile, 50);
    } else {
      if (step1) step1.style.display = 'none';
      if (step2) step2.style.display = 'block';
      if (btn) btn.textContent = 'save';
      if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
    }
    if (m) m.classList.add('show');
  }

  function closeResetPwdModal() {
    const m = document_.getElementById('resetPwdModal'); if (m) m.classList.remove('show');
    const np = document_.getElementById('newPassword'); if (np) np.value = '';
    const np2 = document_.getElementById('newPassword2'); if (np2) np2.value = '';
    const hint = document_.getElementById('resetPwdHint'); if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
    removeResetPwdTurnstile();
    const tr = document_.getElementById('resetPwdTurnstileRow'); if (tr) tr.style.display = 'none';
  }

  async function doResetPwd() {
    const btn = document_.getElementById('resetPwdBtn');
    const hint = document_.getElementById('resetPwdHint');
    const step1 = document_.getElementById('resetPwdStep1');
    const step2 = document_.getElementById('resetPwdStep2');
    const isStep1 = step1 && step1.style.display !== 'none';
    if (isStep1) {
      const e = document_.getElementById('email').value.trim();
      if (!e) return toast('请先填写邮箱', 'error');
      if (!/^\S+@\S+\.\S+$/.test(e)) return toast('邮箱格式不正确', 'error');
      if (!resetPwdTurnstileToken) { toast('请先完成人机验证', 'error'); renderResetPwdTurnstile(); return; }
      btn.disabled = true;
      try {
        const { error } = await sb.auth.resetPasswordForEmail(e, { redirectTo: location_ && location_.origin ? location_.origin : 'http://localhost', captchaToken: resetPwdTurnstileToken });
        resetResetPwdTurnstile();
        if (error) throw error;
        if (hint) { hint.style.display = 'block'; hint.textContent = 'sent to ' + e; }
        toast('sent', 'success');
      } catch (err) {
        resetResetPwdTurnstile();
        if (hint) { hint.style.display = 'block'; hint.textContent = err.message || 'failed'; }
        toast(err.message || 'failed', 'error');
      } finally { btn.disabled = false; }
    } else {
      const np = document_.getElementById('newPassword').value;
      const np2 = document_.getElementById('newPassword2').value;
      if (!np || np.length < 6) return;
      if (np !== np2) return;
      btn.disabled = true;
      try {
        const { error } = await sb.auth.updateUser({ password: np });
        if (error) throw error;
        closeResetPwdModal();
      } catch (err) { /* */ }
      finally { btn.disabled = false; }
    }
  }

  function forgotPassword() {
    const e = document_.getElementById('email').value.trim();
    if (!e) return toast('请先填写邮箱', 'error');
    if (!/^\S+@\S+\.\S+$/.test(e)) return toast('邮箱格式不正确', 'error');
    openResetPwdModal(1);
  }

  return {
    showView,
    setAuthMode,
    scheduleTurnstileRender,
    renderTurnstile,
    renderTurnstileWidget,
    renderResetPwdTurnstile,
    resetTurnstile,
    resetResetPwdTurnstile,
    removeResetPwdTurnstile,
    loadTurnstile,
    handlePasswordReset,
    submitAuth,
    openResetPwdModal,
    closeResetPwdModal,
    doResetPwd,
    forgotPassword,
    // 测试钩子
    _getState: () => ({
      authMode, otpPendingEmail, turnstileToken, turnstileWidgetId,
      resetPwdTurnstileToken, resetPwdTurnstileWidgetId,
      passwordRecoveryPending, passwordRecoveryHandled,
      turnstileScriptLoadError, turnstileScriptPromise,
      currentUserId
    })
  };
}
