/**
 * Script injected (context.addInitScript) in every page and frame of the recorded browser.
 * Plain JavaScript in a string on purpose: a compiled TS function could carry bundler helpers
 * (`__name`…) that do not exist inside the page.
 *
 * It only observes: collects facts about the element the user acted on (locator candidates with
 * how many elements each one matches *right now*, before a navigation removes it), and reports
 * through the `__tfRecord` binding. The top frame also shows the floating toolbar (shadow DOM).
 */
export const RECORDER_BINDING = '__tfRecord';
export const TOOLBAR_HOST_ID = '__thinkflow_recorder_toolbar';

/** Applied while taking screenshots so the toolbar never shows up in evidence. */
export const SCREENSHOT_STYLE = `#${TOOLBAR_HOST_ID}{display:none!important}`;

export const RECORDER_SCRIPT = String.raw`(() => {
  if (window.__tfRecorderInstalled) return;
  window.__tfRecorderInstalled = true;
  const BINDING = '${RECORDER_BINDING}';
  const HOST_ID = '${TOOLBAR_HOST_ID}';
  const isTop = window === window.top;
  const state = { paused: false, mode: 'record' };

  // -------- "has the screen settled?": DOM changes of this document (read by the server) --------
  let lastMutation = performance.now();
  try {
    new MutationObserver(() => { lastMutation = performance.now(); }).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  } catch (e) { /* no document yet: the page is still being created */ }
  window.__tfSettle = () => ({
    complete: document.readyState === 'complete',
    quietMs: Math.round(performance.now() - lastMutation),
  });

  const send = (msg) => {
    const fn = window[BINDING];
    if (typeof fn !== 'function') return Promise.resolve(null);
    try { return Promise.resolve(fn(msg)).catch(() => null); } catch (e) { return Promise.resolve(null); }
  };

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

  const TEXT_INPUTS = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week']);
  const isTextField = (el) =>
    (el.tagName === 'INPUT' && TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase())) ||
    el.tagName === 'TEXTAREA';
  const isToggle = (el) =>
    el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase());
  const fromToolbar = (e) => e.composedPath().some((n) => n && n.id === HOST_ID);

  const ROLE_SELECTORS = {
    button: 'button,input[type=button],input[type=submit],input[type=reset],input[type=image],summary,[role=button]',
    link: 'a[href],area[href],[role=link]',
    textbox: 'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],textarea,[role=textbox]',
    searchbox: 'input[type=search],[role=searchbox]',
    spinbutton: 'input[type=number],[role=spinbutton]',
    checkbox: 'input[type=checkbox],[role=checkbox]',
    radio: 'input[type=radio],[role=radio]',
    combobox: 'select:not([multiple]):not([size]),[role=combobox]',
    listbox: 'select[multiple],select[size],[role=listbox]',
    option: '[role=option]',
    tab: '[role=tab]',
    menuitem: '[role=menuitem]',
    switch: '[role=switch]',
    heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
    img: 'img[alt]:not([alt=""]),[role=img]',
    status: '[role=status],output',
    alert: '[role=alert]',
    dialog: 'dialog,[role=dialog]',
  };

  function roleOf(el) {
    const explicit = norm(el.getAttribute('role')).split(' ')[0];
    if (explicit) return ROLE_SELECTORS[explicit] ? explicit : null;
    for (const role in ROLE_SELECTORS) {
      try { if (el.matches(ROLE_SELECTORS[role])) return role; } catch (e) {}
    }
    return null;
  }

  function textOf(el) {
    return norm(el.innerText !== undefined ? el.innerText : el.textContent);
  }

  function labelText(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = norm(by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? textOf(n) : ''; }).join(' '));
      if (t) return t;
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      const t = norm(Array.from(el.labels).map((l) => {
        const clone = l.cloneNode(true);
        clone.querySelectorAll('input,select,textarea').forEach((c) => c.remove());
        return clone.textContent;
      }).join(' '));
      if (t) return t;
    }
    return '';
  }

  /** Approximation of the accessible name (enough to build getByRole(..., { exact: true })). */
  function accName(el, role) {
    const label = labelText(el);
    if (label) return label;
    const tag = el.tagName;
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return norm(el.value || (el.type === 'submit' ? 'Submit' : ''));
    if (tag === 'IMG' || (tag === 'INPUT' && el.type === 'image')) return norm(el.getAttribute('alt'));
    if (['button', 'link', 'tab', 'option', 'menuitem', 'heading', 'checkbox', 'radio', 'switch'].includes(role) && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
      const t = textOf(el);
      if (t) return t;
    }
    const title = norm(el.getAttribute('title'));
    if (title) return title;
    return norm(el.getAttribute('placeholder'));
  }

  function countRole(role, name) {
    let n = 0;
    try {
      document.querySelectorAll(ROLE_SELECTORS[role]).forEach((e) => {
        if (roleOf(e) === role && accName(e, role) === name) n++;
      });
    } catch (e) { return 0; }
    return n;
  }

  function countBy(selector, test) {
    let n = 0;
    try { document.querySelectorAll(selector).forEach((e) => { if (test(e)) n++; }); } catch (e) { return 0; }
    return n;
  }

  function cssCount(sel) {
    try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
  }

  const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

  function cssPath(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 7; depth++) {
      if (node.id && depth > 0 && cssCount('#' + CSS.escape(node.id)) === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') { parts.unshift(tag); break; }
      const parent = node.parentElement;
      let part = tag;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function facts(el) {
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    const name = clip(role ? accName(el, role) : '', 300);
    const label = clip(labelText(el) || norm(el.getAttribute('placeholder')) || name || norm(el.getAttribute('title')), 300);
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const secret = type === 'password' || /^(cc-number|cc-csc|cc-exp|one-time-code|current-password|new-password)$/.test(autocomplete);
    const candidates = [];
    const add = (locator, count) => candidates.push({ locator, count });

    const testid = el.getAttribute('data-testid');
    if (testid) add({ kind: 'testid', value: clip(testid, 300) }, cssCount('[data-testid=' + q(testid) + ']'));
    if (role && name) add({ kind: 'role', role, name }, countRole(role, name));
    const own = labelText(el);
    if (own && ['input', 'select', 'textarea'].includes(tag))
      add({ kind: 'label', text: clip(own, 300) }, countBy('input,select,textarea,[aria-label],[aria-labelledby]', (e) => labelText(e) === own));
    const ph = norm(el.getAttribute('placeholder'));
    if (ph) add({ kind: 'placeholder', text: clip(ph, 300) }, countBy('[placeholder]', (e) => norm(e.getAttribute('placeholder')) === ph));
    const alt = norm(el.getAttribute('alt'));
    if (alt) add({ kind: 'alt', text: clip(alt, 300) }, countBy('[alt]', (e) => norm(e.getAttribute('alt')) === alt));
    const title = norm(el.getAttribute('title'));
    if (title) add({ kind: 'title', text: clip(title, 300) }, countBy('[title]', (e) => norm(e.getAttribute('title')) === title));
    if (!['input', 'select', 'textarea'].includes(tag)) {
      const text = textOf(el);
      if (text && text.length <= 80)
        add({ kind: 'text', text }, countBy('body *', (e) => textOf(e) === text && !Array.from(e.children).some((c) => textOf(c) === text)));
    }
    if (el.id) add({ kind: 'css', selector: '#' + CSS.escape(el.id) }, cssCount('#' + CSS.escape(el.id)));
    const nameAttr = el.getAttribute('name');
    if (nameAttr && ['input', 'select', 'textarea', 'button'].includes(tag)) {
      const sel = tag + '[name=' + q(nameAttr) + ']';
      add({ kind: 'css', selector: sel }, cssCount(sel));
    }
    for (const attr of ['data-test', 'data-test-id', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) { const sel = '[' + attr + '=' + q(v) + ']'; add({ kind: 'css', selector: sel }, cssCount(sel)); }
    }
    const path = cssPath(el);
    add({ kind: 'css', selector: path }, cssCount(path));

    let bbox = null;
    if (isTop) {
      const r = el.getBoundingClientRect();
      const w = window.innerWidth || 1, h = window.innerHeight || 1;
      const cl = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
      bbox = {
        x: cl(r.left / w, -1, 2), y: cl(r.top / h, -1, 2),
        w: cl(r.width / w, 0, 2), h: cl(r.height / h, 0, 2),
      };
    }
    return {
      tag, inputType: type, role, name, label,
      fieldName: el.getAttribute('name') || el.id || null,
      candidates, secret, bbox,
      frameUrl: isTop ? null : location.href,
    };
  }

  const lastSent = new WeakMap();
  // paused or "Só prints": nothing done in the page becomes a step
  const post = (e) => { if (!state.paused && state.mode !== 'capture') send({ kind: 'event', event: e }); };

  function flushFill(el) {
    if (!el || el.nodeType !== 1 || !isTextField(el)) return;
    const value = el.value;
    if (lastSent.get(el) === value) return;
    lastSent.set(el, value);
    post({ type: 'fill', facts: facts(el), value });
  }

  /** Typing still pending in the focused field is recorded before any other action. */
  const event = (e) => {
    if (e.type !== 'fill') flushFill(document.activeElement); // idempotent per value
    post(e);
  };
  window.addEventListener('pagehide', () => flushFill(document.activeElement), true);

  // which frame the person is working in: the server captures the "current screen" from it
  // (the toolbar itself does not count). Clicks always report; typing at most once a second.
  let lastKeyReport = 0;
  const activity = (e) => {
    if (!e.isTrusted || fromToolbar(e)) return;
    if (e.type === 'keydown') {
      const now = Date.now();
      if (now - lastKeyReport < 1000) return;
      lastKeyReport = now;
    }
    send({ kind: 'activity' });
  };
  document.addEventListener('pointerdown', activity, true);
  document.addEventListener('keydown', activity, true);

  const CLICKABLE = 'button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=switch],input,summary,label,select';

  /** A click on the page background (html/body): focusing the window, not an action to replay. */
  const isEmptySpace = (el) => el === document.documentElement || el === document.body;

  document.addEventListener('click', (e) => {
    if (fromToolbar(e) || !e.isTrusted) return;
    const raw = e.composedPath()[0];
    if (!raw || raw.nodeType !== 1) return;
    const el = raw.closest(CLICKABLE) || raw;
    if (isEmptySpace(el)) return;
    if (isTextField(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION' || isToggle(el)) return;
    if (el.tagName === 'LABEL' && el.control && (isToggle(el.control) || isTextField(el.control))) return;
    if (e.detail > 1) return; // the dblclick listener reports it
    event({ type: 'click', facts: facts(el) });
  }, true);

  document.addEventListener('dblclick', (e) => {
    if (fromToolbar(e) || !e.isTrusted) return;
    const raw = e.composedPath()[0];
    if (!raw || raw.nodeType !== 1) return;
    const el = raw.closest(CLICKABLE) || raw;
    if (isEmptySpace(el) || isTextField(el)) return;
    event({ type: 'dblclick', facts: facts(el) });
  }, true);

  document.addEventListener('change', (e) => {
    if (fromToolbar(e)) return;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1) return;
    // page scripts fire synthetic changes; a <select> may also be changed by automation tools
    if (!e.isTrusted && el.tagName !== 'SELECT') return;
    if (isToggle(el)) {
      event({ type: el.checked || el.type === 'radio' ? 'check' : 'uncheck', facts: facts(el) });
    } else if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      event({ type: 'select', facts: facts(el), value: opt ? norm(opt.label || opt.textContent) : el.value });
    } else {
      flushFill(el);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (fromToolbar(e)) return;
    // manual prints exist only in "Só prints"; recording steps prints by itself
    if (state.mode === 'capture' && e.ctrlKey && e.shiftKey && (e.code === 'KeyS' || e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      e.stopPropagation();
      send({ kind: 'capture' });
      return;
    }
    if (!e.isTrusted) return;
    const el = e.composedPath()[0];
    const target = el && el.nodeType === 1 && el !== document.body ? el : null;
    if (e.key === 'Enter' && target && target.tagName !== 'TEXTAREA') {
      flushFill(target);
      event({ type: 'press', facts: facts(target), key: 'Enter' });
    } else if (e.key === 'Escape') {
      event({ type: 'press', facts: target ? facts(target) : null, key: 'Escape' });
    }
  }, true);

  // -------- floating toolbar (top frame only) --------
  let toolbar = null;
  function renderToolbar() {
    if (!toolbar) return;
    const dot = toolbar.querySelector('.dot');
    const status = toolbar.querySelector('.status');
    const pause = toolbar.querySelector('[data-action=pause]');
    const verify = toolbar.querySelector('[data-action=verify]');
    const captureBtn = toolbar.querySelector('[data-action=capture]');
    const prototypeBtn = toolbar.querySelector('[data-action=prototype]');
    const capturing = state.mode === 'capture';
    dot.className = 'dot' + (capturing ? ' capture' : state.paused ? ' paused' : '');
    status.textContent = capturing ? 'Só prints' : state.paused ? 'Pausado' : 'Gravando';
    pause.textContent = state.paused ? 'Retomar' : 'Pausar';
    // the mode is fixed per session: "Só prints" only captures; recording steps has no manual print
    captureBtn.style.display = capturing ? '' : 'none';
    // a prototype is a screen for the document: only "Só prints" captures screens
    prototypeBtn.style.display = capturing ? '' : 'none';
    pause.style.display = capturing ? 'none' : '';
    verify.style.display = capturing ? 'none' : '';
  }
  function mountToolbar() {
    if (!isTop || document.getElementById(HOST_ID) || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' +
      '.bar{position:fixed;right:16px;bottom:16px;display:flex;gap:6px;align-items:center;font:13px system-ui,sans-serif;background:#1e1b2e;color:#fff;padding:6px 8px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}' +
      '.dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:p 1.2s infinite}.dot.paused{background:#f59e0b;animation:none}.dot.capture{background:#3b82f6;animation:none}' +
      '@keyframes p{50%{opacity:.35}}.status{margin:0 4px;min-width:64px}' +
      'button{font:inherit;color:#fff;background:#3b3355;border:0;border-radius:8px;padding:5px 9px;cursor:pointer}button:hover{background:#56487d}' +
      'button.stop{background:#b91c1c}button.stop:hover{background:#dc2626}' +
      '</style><div class="bar" role="toolbar" aria-label="Gravação do Thinkflow"><span class="dot"></span><span class="status"></span>' +
      '<button data-action="capture" title="Capturar tela (Ctrl+Shift+S)">Capturar</button>' +
      '<button data-action="verify" title="Tirar um print da tela inteira como verificação">Verificar</button>' +
      '<button data-action="prototype" title="Salvar a tela atual como protótipo editável">Protótipo</button>' +
      '<button data-action="pause"></button>' +
      '<button data-action="stop" class="stop" title="Encerrar a gravação e fechar o navegador">Parar</button></div>';
    root.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('button');
      if (!btn) return;
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      if (action === 'capture') send({ kind: 'capture' });
      if (action === 'pause') { state.paused = !state.paused; renderToolbar(); send({ kind: 'pause', paused: state.paused }); }
      if (action === 'verify') send({ kind: 'checkpoint' });
      if (action === 'prototype') {
        send({ kind: 'prototype' });
        const label = btn.textContent;
        btn.textContent = 'Capturando…';
        setTimeout(() => { btn.textContent = label; }, 1500);
      }
      if (action === 'stop') { btn.disabled = true; btn.textContent = 'Encerrando…'; send({ kind: 'stop' }); }
    });
    document.documentElement.appendChild(host);
    toolbar = root;
    renderToolbar();
  }

  // the server pushes state changes (pause from the Thinkflow screen, session mode)
  window.__tfSetState = (next) => {
    if (next && typeof next.paused === 'boolean') state.paused = next.paused;
    if (next && typeof next.mode === 'string') state.mode = next.mode;
    renderToolbar();
    if (window.__tfOnState) window.__tfOnState(state);
  };

  send({ kind: 'hello' }).then((s) => { if (s) window.__tfSetState(s); });
  if (isTop) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountToolbar);
    else mountToolbar();
  }
  window.__tfFacts = facts;
})();`;
