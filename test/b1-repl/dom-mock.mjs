// Minimal DOM mock for testing index.html auth behavior.
// Focused on the surface area the auth/turnstile/recovery code touches.
// NOT a full DOM — only what the auth flow needs.
export class FakeElement {
  constructor(tagName) {
    this.tagName = (tagName || 'div').toUpperCase();
    this.children = [];
    this.parent = null;
    this.style = { display: '', background: '', color: '' };
    this.dataset = {};
    this.attrs = {};
    this.classList = {
      _set: (this._classes = this._classes || new Set()),
      add: (...cls) => { cls.forEach((c) => this._classes.add(c)); this.attrs.class = Array.from(this._classes).join(' '); },
      remove: (...cls) => { cls.forEach((c) => this._classes.delete(c)); this.attrs.class = Array.from(this._classes).join(' '); },
      contains: (c) => this._classes.has(c),
      toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); }
    };
    this._listeners = {};
    this._text = '';
    this._disabled = false;
    this._value = '';
    this._id = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get id() { return this._id; }
  set id(v) { this._id = v; if (v) this.attrs.id = v; }
  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = !!v; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] != null ? String(this.attrs[k]) : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { c.parent = null; this.children = this.children.filter(x => x !== c); return c; }
  querySelector(sel) {
    const target = sel.replace(/^[#.]/, '');
    if (sel.startsWith('#')) return this._findById(target);
    if (sel.startsWith('.')) return this._findByClass(target);
    return this._findByTag(target);
  }
  querySelectorAll(sel) {
    const target = sel.replace(/^[#.]/, '');
    if (sel.startsWith('#')) return this._findAllById(target);
    if (sel.startsWith('.')) return this._findAllByClass(target);
    return this._findAllByTag(target);
  }
  _findById(id) {
    if (this.attrs.id === id) return this;
    for (const c of this.children) { const r = c._findById(id); if (r) return r; }
    return null;
  }
  _findAllById(id) {
    const out = [];
    if (this.attrs.id === id) out.push(this);
    for (const c of this.children) out.push(...c._findAllById(id));
    return out;
  }
  _findByClass(cls) {
    const set = (this.attrs.class || '').split(/\s+/);
    if (set.includes(cls)) return this;
    for (const c of this.children) { const r = c._findByClass(cls); if (r) return r; }
    return null;
  }
  _findAllByClass(cls) {
    const out = [];
    const set = (this.attrs.class || '').split(/\s+/);
    if (set.includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c._findAllByClass(cls));
    return out;
  }
  _findByTag(tag) {
    if (this.tagName === tag.toUpperCase()) return this;
    for (const c of this.children) { const r = c._findByTag(tag); if (r) return r; }
    return null;
  }
  _findAllByTag(tag) {
    const out = [];
    if (this.tagName === tag.toUpperCase()) out.push(this);
    for (const c of this.children) out.push(...c._findAllByTag(tag));
    return out;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).filter(f => f !== fn); }
  click() { (this._listeners.click || []).forEach(f => f()); }
  focus() { (this._listeners.focus || []).forEach(f => f()); }
  destroy() {}
}

export class FakeDocument {
  constructor() {
    this._byId = new Map();
    this._head = new FakeElement('head');
    this._body = new FakeElement('body');
    this._listeners = {};
    this.visibilityState = 'visible';
  }
  get head() { return this._head; }
  get body() { return this._body; }
  get defaultView() { return globalThis; }
  createElement(tag) { return new FakeElement(tag); }
  createTextNode(text) { const t = new FakeElement('text'); t._text = String(text); return t; }
  register(id, el) { this._byId.set(id, el); }
  getElementById(id) { return this._byId.get(id) || null; }
  querySelectorAll(sel) { return this._body._findAllByClass(sel.replace(/^\./, '')); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(type) { (this._listeners[type] || []).forEach(f => f({ type })); }
}

// Build a minimal DOM tree matching the index.html structure we need
export function buildAuthDom() {
  const doc = new FakeDocument();
  // Helper
  const el = (tag, id) => {
    const e = new FakeElement(tag);
    if (id) { e.id = id; doc.register(id, e); }
    return e;
  };
  const bootMsg = el('div', 'bootMsg'); doc.body.appendChild(bootMsg);
  const authView = el('div', 'authView'); doc.body.appendChild(authView);
  const mainView = el('div', 'mainView'); doc.body.appendChild(mainView);
  const emailModeRow = el('div', 'emailModeRow'); authView.appendChild(emailModeRow);
  const email = el('input', 'email'); authView.appendChild(email);
  const password = el('input', 'password'); authView.appendChild(password);
  const turnstileRow = el('div', 'turnstileRow'); authView.appendChild(turnstileRow);
  const turnstileWidget = el('div', 'turnstileWidget'); turnstileRow.appendChild(turnstileWidget);
  const otpRow = el('div', 'otpRow'); authView.appendChild(otpRow);
  const otpCode = el('input', 'otpCode'); otpRow.appendChild(otpCode);
  const otpBtn = el('button', 'otpBtn'); otpRow.appendChild(otpBtn);
  const authBtn = el('button', 'authBtn'); authView.appendChild(authBtn);
  const modeLoginBtn = el('button', 'modeLoginBtn'); emailModeRow.appendChild(modeLoginBtn);
  const modeSignupBtn = el('button', 'modeSignupBtn'); emailModeRow.appendChild(modeSignupBtn);
  const forgotRow = el('div', 'forgotRow'); authView.appendChild(forgotRow);
  // Reset modal
  const resetPwdModal = el('div', 'resetPwdModal'); doc.body.appendChild(resetPwdModal);
  const resetPwdStep1 = el('div', 'resetPwdStep1'); resetPwdModal.appendChild(resetPwdStep1);
  const resetPwdStep2 = el('div', 'resetPwdStep2'); resetPwdModal.appendChild(resetPwdStep2);
  const resetPwdBtn = el('button', 'resetPwdBtn'); resetPwdModal.appendChild(resetPwdBtn);
  const resetPwdHint = el('p', 'resetPwdHint'); resetPwdModal.appendChild(resetPwdHint);
  const resetPwdTurnstileRow = el('div', 'resetPwdTurnstileRow'); resetPwdModal.appendChild(resetPwdTurnstileRow);
  const resetPwdTurnstileWidget = el('div', 'resetPwdTurnstileWidget'); resetPwdTurnstileRow.appendChild(resetPwdTurnstileWidget);
  const newPassword = el('input', 'newPassword'); resetPwdStep2.appendChild(newPassword);
  const newPassword2 = el('input', 'newPassword2'); resetPwdStep2.appendChild(newPassword2);
  const resetPwdTitle = el('h3', 'resetPwdTitle'); resetPwdModal.appendChild(resetPwdTitle);
  // Topbar (main view) elements
  const userEmail = el('span', 'userEmail');
  // The real HTML has mainView containing topbar with userEmail, but the script only
  // uses getElementById which scans our Map. We register userEmail as a child of
  // mainView for structural fidelity.
  mainView.appendChild(userEmail);
  // Toast
  const toast = el('div', 'toast'); doc.body.appendChild(toast);
  return doc;
}
