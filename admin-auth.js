'use strict';

/* ======================================================================
   Gates admin.html behind the single Admin account (see
   api/fantasy/admin-login.js, prisma/schema.prisma's Admin model).
   Shows a login form (#adminLoginGate) until authenticated, then
   reveals the real page content (#adminGatedContent) plus a small "Log
   out" control. Unlike fantasy-auth.js, this isn't meant to be dropped
   into other pages — admin.html is the one dedicated admin surface (at
   least for now); if that changes, generalize this then.
   ====================================================================== */

(function () {
  const gate = document.getElementById('adminLoginGate');
  const content = document.getElementById('adminGatedContent');
  const emailInput = document.getElementById('adminEmail');
  const passwordInput = document.getElementById('adminPassword');
  const submitBtn = document.getElementById('adminLoginSubmit');
  const errorEl = document.getElementById('adminLoginError');
  const logoutBtn = document.getElementById('adminLogoutBtn');
  const whoEl = document.getElementById('adminWho');

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function showLoggedIn(admin) {
    gate.hidden = true;
    content.hidden = false;
    if (whoEl) whoEl.textContent = `Logged in as ${admin.email}`;
  }

  function showLoggedOut() {
    gate.hidden = false;
    content.hidden = true;
    passwordInput.value = '';
  }

  async function submitLogin() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError('Enter your email and password.');
      return;
    }
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/fantasy/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        errorEl.hidden = true;
        showLoggedIn(data.admin);
        return;
      }
      showError(data.message || 'Login failed.');
    } catch {
      showError('Could not reach the server — try again.');
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function logout() {
    try {
      await fetch('/api/fantasy/admin-logout', { method: 'POST' });
    } catch {
      // Non-fatal — show logged-out either way.
    }
    showLoggedOut();
  }

  submitBtn.addEventListener('click', submitLogin);
  [emailInput, passwordInput].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
    });
  });
  logoutBtn.addEventListener('click', logout);

  (async () => {
    try {
      const res = await fetch('/api/fantasy/admin-me');
      const data = await res.json();
      if (data.ok && data.admin) {
        showLoggedIn(data.admin);
      } else {
        showLoggedOut();
      }
    } catch {
      showLoggedOut();
    }
  })();
})();
