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
  const issueInput = document.getElementById('issueUsernameInput');
  const issueBtn = document.getElementById('issueUsernameBtn');
  const issueStatus = document.getElementById('issueUsernameStatus');
  const requestsWrap = document.getElementById('avatarRequestsWrap');
  const requestsList = document.getElementById('avatarRequestsList');
  const activityWrap = document.getElementById('dailyActivityWrap');
  const activityList = document.getElementById('dailyActivityList');

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
          <tr data-username="${escapeHtmlLocal(u.username)}">
            <td>${buildAvatarImg(u.avatarUrl, 28, 'bust')}</td>
            <td>${escapeHtmlLocal(u.username)}</td>
            <td>${escapeHtmlLocal(u.displayName || '—')}</td>
            <td>${fmtDate(u.createdAt)}</td>
            <td>${fmtDate(u.lastLoginAt)}</td>
            <td>💰 ${u.creditBalance ?? 0}</td>
            <td>${statusFor(u)}</td>
            <td><button type="button" class="link-btn user-reset-btn">Reset</button></td>
          </tr>
        `).join('');
        wrapEl.hidden = false;
      }

      renderAvatarRequests(data.users.filter((u) => u.avatarRequestedAt));
      renderDailyActivity(data.dailyActivity || []);
    } catch (err) {
      errorEl.textContent = `Couldn't load users (${err.message}).`;
      errorEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', load);

  async function issueUsername() {
    const username = issueInput.value.trim();
    if (!username) {
      issueStatus.textContent = 'Enter a username first.';
      issueStatus.style.color = 'var(--accent-2, #ff8b96)';
      return;
    }
    issueBtn.disabled = true;
    issueStatus.textContent = 'Issuing…';
    issueStatus.style.color = '';
    try {
      const res = await fetch('/api/fantasy/admin-create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, action: 'create' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      issueStatus.textContent = `Issued "${data.user.username}" ✓ — hand it to them out-of-band.`;
      issueStatus.style.color = '#59d97c';
      issueInput.value = '';
      load();
    } catch (err) {
      issueStatus.textContent = `Couldn't issue username (${err.message}).`;
      issueStatus.style.color = 'var(--accent-2, #ff8b96)';
    } finally {
      issueBtn.disabled = false;
    }
  }

  issueBtn.addEventListener('click', issueUsername);
  issueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); issueUsername(); }
  });

  async function resetUsername(username, btn) {
    if (!window.confirm(`Reset "${username}"'s password? Their old password stops working immediately — next login asks them to set a new one.`)) return;
    btn.disabled = true;
    btn.textContent = 'Resetting…';
    try {
      const res = await fetch('/api/fantasy/admin-create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, action: 'reset' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      load();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Reset';
      window.alert(`Couldn't reset (${err.message}).`);
    }
  }

  tbody.addEventListener('click', (e) => {
    if (!e.target.classList.contains('user-reset-btn')) return;
    const tr = e.target.closest('tr');
    resetUsername(tr.dataset.username, e.target);
  });

  function renderAvatarRequests(pending) {
    if (!pending.length) {
      requestsWrap.hidden = true;
      requestsList.innerHTML = '';
      return;
    }
    requestsWrap.hidden = false;
    requestsList.innerHTML = pending.map((u) => `
      <div class="fh-transaction-row" data-username="${escapeHtmlLocal(u.username)}">
        ${buildAvatarImg(u.avatarRequestUrl, 48)}
        <div class="fh-tx-body">
          <div class="fh-tx-user">${escapeHtmlLocal(u.displayName || u.username)}</div>
          <div class="fh-tx-sides">${u.avatarRequestNote ? escapeHtmlLocal(u.avatarRequestNote) : 'No note.'} — requested ${fmtDate(u.avatarRequestedAt)}</div>
        </div>
        <div class="fh-tx-meta" style="flex-direction: row; gap: 8px;">
          <button type="button" class="ghost-btn avatar-request-approve">Approve</button>
          <button type="button" class="ghost-btn avatar-request-reject">Reject</button>
        </div>
      </div>
    `).join('');
  }

  function renderDailyActivity(entries) {
    if (!entries.length) {
      activityWrap.hidden = true;
      activityList.innerHTML = '';
      return;
    }
    activityWrap.hidden = false;
    activityList.innerHTML = entries.map((g) => `
      <div class="fh-transaction-row">
        <div class="fh-tx-body">
          <div class="fh-tx-user">${escapeHtmlLocal(g.displayName || g.username)}</div>
          <div class="fh-tx-sides">${g.date} — ${g.attempts} guess${g.attempts === 1 ? '' : 'es'}</div>
        </div>
        <div class="fh-tx-meta">
          <span class="fh-tx-winner">${g.solved ? '✅ Solved (+25)' : '❌ Not solved'}</span>
        </div>
      </div>
    `).join('');
  }

  async function reviewAvatarRequest(username, action, row) {
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch('/api/fantasy/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, action }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      load(); // refreshes both the table (new avatarUrl if approved) and the request list
    } catch (err) {
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      window.alert(`Couldn't review that request (${err.message}).`);
    }
  }

  requestsList.addEventListener('click', (e) => {
    const row = e.target.closest('.fh-transaction-row');
    if (!row) return;
    if (e.target.classList.contains('avatar-request-approve')) {
      reviewAvatarRequest(row.dataset.username, 'approveAvatar', row);
    } else if (e.target.classList.contains('avatar-request-reject')) {
      reviewAvatarRequest(row.dataset.username, 'rejectAvatar', row);
    }
  });

  window.__adminUsersTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      load();
    },
  };
})();
