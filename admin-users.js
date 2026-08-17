'use strict';

/* Admin page — Users sub-tab: lists every league-member account
   (api/fantasy/admin-users.js). Lazy-loaded — only fetches the first
   time this sub-tab is actually opened (admin.js calls
   window.__adminUsersTab.ensureLoaded() on switch), not on every
   admin.html page load, since it's a DB-backed admin-only call. */
(function () {
  const loadingEl = document.getElementById('usersLoading');
  const errorEl = document.getElementById('usersError');
  const wrapEl = document.getElementById('usersTableWrap');
  const tbody = document.getElementById('usersTbody');
  const emptyEl = document.getElementById('usersEmpty');
  const refreshBtn = document.getElementById('refreshUsersBtn');

  let loaded = false;

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function statusFor(u) {
    if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) return '🔒 Locked';
    if (!u.setUp) return '⏳ Not set up yet';
    return '✅ Active';
  }

  async function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    wrapEl.hidden = true;
    emptyEl.hidden = true;
    refreshBtn.disabled = true;
    try {
      const res = await fetch('/api/fantasy/admin-users');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);

      if (data.users.length === 0) {
        emptyEl.hidden = false;
      } else {
        tbody.innerHTML = data.users.map((u) => `
          <tr>
            <td>${escapeHtmlLocal(u.username)}</td>
            <td>${escapeHtmlLocal(u.displayName || '—')}</td>
            <td>${fmtDate(u.createdAt)}</td>
            <td>${fmtDate(u.lastLoginAt)}</td>
            <td>${statusFor(u)}</td>
          </tr>
        `).join('');
        wrapEl.hidden = false;
      }
    } catch (err) {
      errorEl.textContent = `Couldn't load users (${err.message}).`;
      errorEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', load);

  window.__adminUsersTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      load();
    },
  };
})();
