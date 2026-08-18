'use strict';

/* ======================================================================
   Fantasy Hub — client-side login/account UI. Self-contained: include
   this script on any page and it renders a login/account control
   wherever it finds `#fhAuthSlot`, owns its own modal, and exposes a
   small public surface other page scripts can use without a hard
   dependency:

     window.fantasyAuth.ready          — Promise, resolves once the
                                          initial login-state check
                                          (GET /api/fantasy/session) completes
     window.fantasyAuth.getUser()      — the current user object (with
                                          .username/.displayName) or
                                          null if logged out
     window.fantasyAuth.onChange(fn)   — fn(user) called whenever login
                                          state changes (login/logout)

   TO ADD THIS TO ANOTHER PAGE: add `<script src="fantasy-auth.js" defer></script>`
   and `<div id="fhAuthSlot"></div>` somewhere in the header. That's it —
   the modal markup is created dynamically here, nothing else to copy.
   ====================================================================== */

(function () {
  const state = {
    user: null,
    listeners: [],
  };

  function notify() {
    for (const fn of state.listeners) {
      try { fn(state.user); } catch { /* a listener's own problem, not ours */ }
    }
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- Modal (built once, lazily, on first open) ----

  let modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    const root = document.createElement('div');
    root.className = 'modal-root';
    root.id = 'fhAuthModalRoot';
    root.hidden = true;
    root.innerHTML = `
      <div class="modal-overlay" id="fhAuthModalOverlay"></div>
      <div class="modal-panel fh-auth-modal-panel" role="dialog" aria-modal="true" aria-label="Log in">
        <button class="modal-close" id="fhAuthModalClose" aria-label="Close">✕</button>
        <h2 id="fhModalHeading">Log in</h2>
        <p class="fh-login-sub" id="fhModalSub">Use the username your commissioner gave you.</p>
        <div class="fh-field">
          <label for="fhUsername">Username</label>
          <input id="fhUsername" type="text" autocomplete="username">
        </div>
        <div class="fh-field">
          <label for="fhPassword">Password</label>
          <input id="fhPassword" type="password" autocomplete="current-password">
        </div>
        <div class="fh-field" id="fhNameField" hidden>
          <label for="fhDisplayName">Your name</label>
          <input id="fhDisplayName" type="text" autocomplete="name">
        </div>
        <p class="fh-login-error" id="fhLoginError" hidden></p>
        <button type="button" id="fhLoginSubmit" class="primary-btn">Log in</button>
        <button type="button" id="fhModalSwitchLink" class="link-btn fh-modal-switch">First time? Sign up instead</button>
      </div>
    `;
    document.body.appendChild(root);
    modalEl = root;

    root.querySelector('#fhAuthModalClose').addEventListener('click', closeModal);
    root.querySelector('#fhAuthModalOverlay').addEventListener('click', closeModal);
    root.querySelector('#fhLoginSubmit').addEventListener('click', submitLogin);
    root.querySelector('#fhModalSwitchLink').addEventListener('click', () => {
      setModalMode(modalMode === 'signup' ? 'login' : 'signup');
    });
    root.querySelectorAll('input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
      });
    });

    return root;
  }

  let modalMode = 'login';

  /** Switches the modal between "Log in" and "Sign up" presentation.
   *  Both submit to the exact same POST /api/fantasy/session endpoint — it
   *  already handles either case correctly based on whether the account
   *  is unclaimed and whether a name was sent (a name sent for an
   *  already-claimed account is just ignored server-side). This is
   *  purely about which fields/copy show up FIRST, so a first-time
   *  visitor doesn't have to fail a login attempt before seeing the
   *  name field — same underlying flow either way. */
  function setModalMode(mode) {
    modalMode = mode;
    const isSignup = mode === 'signup';
    document.getElementById('fhModalHeading').textContent = isSignup ? 'Sign Up' : 'Log in';
    document.getElementById('fhModalSub').textContent = isSignup
      ? "First time here? Enter the username your commissioner gave you, choose a password, and tell us your name."
      : 'Use the username your commissioner gave you.';
    document.getElementById('fhNameField').hidden = !isSignup;
    document.getElementById('fhLoginSubmit').textContent = isSignup ? 'Sign up' : 'Log in';
    document.getElementById('fhModalSwitchLink').textContent = isSignup
      ? 'Already set up? Log in instead'
      : 'First time? Sign up instead';
    document.getElementById('fhLoginError').hidden = true;
  }

  function openModal(mode) {
    ensureModal().hidden = false;
    setModalMode(mode || 'login');
    document.getElementById('fhUsername').focus();
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.getElementById('fhLoginError').hidden = true;
    document.getElementById('fhUsername').value = '';
    document.getElementById('fhPassword').value = '';
    document.getElementById('fhDisplayName').value = '';
    setModalMode('login');
  }

  function showError(message) {
    const el = document.getElementById('fhLoginError');
    el.textContent = message;
    el.hidden = false;
  }

  async function submitLogin() {
    const username = document.getElementById('fhUsername').value.trim();
    const password = document.getElementById('fhPassword').value;
    const nameField = document.getElementById('fhNameField');
    const displayName = nameField.hidden ? undefined : document.getElementById('fhDisplayName').value.trim();

    if (!username || !password) {
      showError('Enter a username and password.');
      return;
    }
    if (!nameField.hidden && !displayName) {
      showError('Enter your name.');
      return;
    }

    try {
      const res = await fetch('/api/fantasy/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName }),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        state.user = data.user;
        notify();
        closeModal();
        render();
        return;
      }

      if (data.error === 'needs_name') {
        nameField.hidden = false;
        document.getElementById('fhDisplayName').focus();
        showError(data.message || "First time logging in — what's your name?");
        return;
      }

      showError(data.message || 'Login failed — check your username and password.');
    } catch {
      showError('Could not reach the server — try again.');
    }
  }

  // ---- Auth slot (in the page header) ----

  function render() {
    const slot = document.getElementById('fhAuthSlot');
    if (!slot) return;
    if (state.user) {
      const name = escapeHtml(state.user.displayName || state.user.username);
      // buildAvatarImg() comes from avatar.js — loaded before this
      // script on every page (see each page's <script> order). Falls
      // back to the plain 👤 glyph if it's missing for any reason
      // rather than erroring the whole header.
      const avatar = typeof buildAvatarImg === 'function' ? buildAvatarImg(state.user.avatarUrl, 22, 'bust') : '👤';
      slot.innerHTML = `
        <span class="fh-auth-name">${avatar} ${name}</span>
        <button type="button" class="ghost-btn" id="fhLogoutBtn">Log out</button>
      `;
      slot.querySelector('#fhLogoutBtn').addEventListener('click', logout);
    } else {
      slot.innerHTML = `
        <button type="button" class="ghost-btn" id="fhLoginBtn">Log in</button>
        <button type="button" class="ghost-btn" id="fhSignupBtn">Sign up</button>
      `;
      slot.querySelector('#fhLoginBtn').addEventListener('click', () => openModal('login'));
      slot.querySelector('#fhSignupBtn').addEventListener('click', () => openModal('signup'));
    }
  }

  async function logout() {
    try {
      await fetch('/api/fantasy/session', { method: 'DELETE' });
    } catch {
      // Non-fatal — clear local state either way.
    }
    state.user = null;
    notify();
    render();
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/fantasy/session');
      const data = await res.json();
      state.user = (data.ok && data.user) || null;
    } catch {
      state.user = null;
    }
    notify();
    render();
  }

  const ready = checkSession();

  window.fantasyAuth = {
    ready,
    getUser: () => state.user,
    // Lets another page script (e.g. fantasy-hub.js, after a successful
    // PATCH /api/fantasy/session) update the cached user in place —
    // triggers the same onChange listeners + header re-render as a
    // real login would, without a full page reload.
    setUser: (user) => { state.user = user; notify(); render(); },
    onChange: (fn) => { state.listeners.push(fn); },
  };
})();
