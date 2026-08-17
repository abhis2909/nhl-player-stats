'use strict';

/* ======================================================================
   Fantasy Hub — client-side login/account UI. Self-contained: include
   this script on any page and it renders a login/account control
   wherever it finds `#fhAuthSlot`, owns its own modal, and exposes a
   small public surface other page scripts can use without a hard
   dependency:

     window.fantasyAuth.ready          — Promise, resolves once the
                                          initial login-state check
                                          (GET /api/fantasy/me) completes
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
        <h2>Log in</h2>
        <p class="fh-login-sub">Use the username your commissioner gave you.</p>
        <div class="fh-field">
          <label for="fhUsername">Username</label>
          <input id="fhUsername" type="text" autocomplete="username">
        </div>
        <div class="fh-field">
          <label for="fhPassword">Password</label>
          <input id="fhPassword" type="password" autocomplete="current-password">
        </div>
        <div class="fh-field" id="fhClaimCodeField" hidden>
          <label for="fhClaimCode">Claim code</label>
          <input id="fhClaimCode" type="text" autocomplete="one-time-code">
        </div>
        <p class="fh-login-error" id="fhLoginError" hidden></p>
        <button type="button" id="fhLoginSubmit" class="primary-btn">Log in</button>
      </div>
    `;
    document.body.appendChild(root);
    modalEl = root;

    root.querySelector('#fhAuthModalClose').addEventListener('click', closeModal);
    root.querySelector('#fhAuthModalOverlay').addEventListener('click', closeModal);
    root.querySelector('#fhLoginSubmit').addEventListener('click', submitLogin);
    root.querySelectorAll('input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
      });
    });

    return root;
  }

  function openModal() {
    ensureModal().hidden = false;
    document.getElementById('fhUsername').focus();
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.getElementById('fhLoginError').hidden = true;
    document.getElementById('fhClaimCodeField').hidden = true;
    document.getElementById('fhUsername').value = '';
    document.getElementById('fhPassword').value = '';
    document.getElementById('fhClaimCode').value = '';
  }

  function showError(message) {
    const el = document.getElementById('fhLoginError');
    el.textContent = message;
    el.hidden = false;
  }

  async function submitLogin() {
    const username = document.getElementById('fhUsername').value.trim();
    const password = document.getElementById('fhPassword').value;
    const claimCodeField = document.getElementById('fhClaimCodeField');
    const claimCode = claimCodeField.hidden ? undefined : document.getElementById('fhClaimCode').value.trim();

    if (!username || !password) {
      showError('Enter a username and password.');
      return;
    }

    try {
      const res = await fetch('/api/fantasy/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, claimCode }),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        state.user = data.user;
        notify();
        closeModal();
        render();
        return;
      }

      if (data.error === 'needs_claim_code') {
        claimCodeField.hidden = false;
        document.getElementById('fhClaimCode').focus();
        showError(data.message || 'Enter the claim code your commissioner gave you.');
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
      slot.innerHTML = `
        <span class="fh-auth-name">👤 ${name}</span>
        <button type="button" class="ghost-btn" id="fhLogoutBtn">Log out</button>
      `;
      slot.querySelector('#fhLogoutBtn').addEventListener('click', logout);
    } else {
      slot.innerHTML = `<button type="button" class="ghost-btn" id="fhLoginBtn">Log in</button>`;
      slot.querySelector('#fhLoginBtn').addEventListener('click', openModal);
    }
  }

  async function logout() {
    try {
      await fetch('/api/fantasy/logout', { method: 'POST' });
    } catch {
      // Non-fatal — clear local state either way.
    }
    state.user = null;
    notify();
    render();
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/fantasy/me');
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
    onChange: (fn) => { state.listeners.push(fn); },
  };
})();
