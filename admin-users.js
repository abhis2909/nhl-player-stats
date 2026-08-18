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

  // ---- Manage-user modal (avatar override, credit adjustment, history) ----
  const umRoot = document.getElementById('userManageModalRoot');
  const umOverlay = document.getElementById('userManageModalOverlay');
  const umClose = document.getElementById('userManageModalClose');
  const umHeading = document.getElementById('umHeading');
  const umLoading = document.getElementById('umLoading');
  const umErrorEl = document.getElementById('umError');
  const umBody = document.getElementById('umBody');
  const umAvatarPreview = document.getElementById('umAvatarPreview');
  const umAvatarFile = document.getElementById('umAvatarFile');
  const umAvatarSaveBtn = document.getElementById('umAvatarSaveBtn');
  const umAvatarStatus = document.getElementById('umAvatarStatus');
  const umPendingRequest = document.getElementById('umPendingRequest');
  const umCreditBalanceEl = document.getElementById('umCreditBalance');
  const umCreditAmount = document.getElementById('umCreditAmount');
  const umCreditNote = document.getElementById('umCreditNote');
  const umCreditApplyBtn = document.getElementById('umCreditApplyBtn');
  const umCreditStatus = document.getElementById('umCreditStatus');
  const umHistoryList = document.getElementById('umHistoryList');
  const umHistoryEmpty = document.getElementById('umHistoryEmpty');

  let umUsername = null;
  let umPendingAvatarDataUrl = null;

  // Same resize-before-send shape as fantasy-hub.js's manager-facing
  // upload (max 640px longer side, JPEG q0.82, no upload infra needed —
  // it's just stored as a data: URI). Small enough to duplicate here
  // rather than pull in the whole of fantasy-hub.js (page-specific,
  // Trade Analyzer/etc) just for this one helper.
  const UM_AVATAR_MAX_DIM = 640;
  const UM_AVATAR_JPEG_QUALITY = 0.82;
  function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That doesn't look like a valid image."));
        img.onload = () => {
          const scale = Math.min(1, UM_AVATAR_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.round(img.naturalWidth * scale);
          const h = Math.round(img.naturalHeight * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', UM_AVATAR_JPEG_QUALITY));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function reasonLabel(reason) {
    return {
      daily_reward: '🎯 Daily guesser',
      admin_adjustment: '🛠 Admin adjustment',
      season_seed: '🌱 Season seed',
      bet_stake: '🎲 Bet stake',
      bet_payout: '🎲 Bet payout',
      faceoff_stake: '⚔ Faceoff stake',
      faceoff_payout: '⚔ Faceoff payout',
      grid_reward: '🧩 Grid reward',
    }[reason] || reason;
  }

  function renderManageAvatar(user) {
    umAvatarPreview.innerHTML = buildAvatarImg(user.avatarUrl, 96);
    if (user.avatarRequestedAt) {
      umPendingRequest.hidden = false;
      umPendingRequest.innerHTML = `
        <div class="fh-transaction-row">
          ${buildAvatarImg(user.avatarRequestUrl, 40)}
          <div class="fh-tx-body">
            <div class="fh-tx-user">Pending request</div>
            <div class="fh-tx-sides">${user.avatarRequestNote ? escapeHtmlLocal(user.avatarRequestNote) : 'No note.'} — ${fmtDate(user.avatarRequestedAt)}</div>
          </div>
          <div class="fh-tx-meta" style="flex-direction: row; gap: 8px;">
            <button type="button" class="ghost-btn" id="umApproveRequestBtn">Approve</button>
            <button type="button" class="ghost-btn" id="umRejectRequestBtn">Reject</button>
          </div>
        </div>
      `;
      document.getElementById('umApproveRequestBtn').addEventListener('click', () => reviewFromModal('approveAvatar'));
      document.getElementById('umRejectRequestBtn').addEventListener('click', () => reviewFromModal('rejectAvatar'));
    } else {
      umPendingRequest.hidden = true;
      umPendingRequest.innerHTML = '';
    }
  }

  async function reviewFromModal(action) {
    try {
      const res = await fetch('/api/fantasy/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: umUsername, action }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      loadManageModal(umUsername);
      load(); // keep the table's own request badge/avatar in sync too
    } catch (err) {
      window.alert(`Couldn't review that request (${err.message}).`);
    }
  }

  function renderManageHistory(transactions) {
    if (!transactions.length) {
      umHistoryList.hidden = true;
      umHistoryEmpty.hidden = false;
      umHistoryList.innerHTML = '';
      return;
    }
    umHistoryList.hidden = false;
    umHistoryEmpty.hidden = true;
    umHistoryList.innerHTML = transactions.map((t) => `
      <div class="fh-transaction-row">
        <div class="fh-tx-body">
          <div class="fh-tx-user">${reasonLabel(t.reason)}</div>
          <div class="fh-tx-sides">${t.note ? escapeHtmlLocal(t.note) : fmtDate(t.createdAt)}</div>
        </div>
        <div class="fh-tx-meta">
          <span class="fh-tx-winner" style="color: ${t.amount >= 0 ? '#59d97c' : 'var(--accent-2, #ff8b96)'};">${t.amount >= 0 ? '+' : ''}${t.amount}</span>
        </div>
      </div>
    `).join('');
  }

  async function loadManageModal(username) {
    umLoading.hidden = false;
    umErrorEl.hidden = true;
    umBody.hidden = true;
    try {
      const res = await fetch(`/api/fantasy/admin-users?username=${encodeURIComponent(username)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);

      umHeading.textContent = `Manage — ${data.user.displayName || data.user.username}`;
      renderManageAvatar(data.user);
      umCreditBalanceEl.textContent = data.user.creditBalance ?? 0;
      renderManageHistory(data.transactions || []);
      umBody.hidden = false;
    } catch (err) {
      umErrorEl.textContent = `Couldn't load this user (${err.message}).`;
      umErrorEl.hidden = false;
    } finally {
      umLoading.hidden = true;
    }
  }

  function openManageModal(username) {
    umUsername = username;
    umPendingAvatarDataUrl = null;
    umAvatarFile.value = '';
    umAvatarSaveBtn.disabled = true;
    umAvatarStatus.textContent = '';
    umCreditAmount.value = '';
    umCreditNote.value = '';
    umCreditStatus.textContent = '';
    umRoot.hidden = false;
    loadManageModal(username);
  }

  function closeManageModal() {
    umRoot.hidden = true;
  }

  umClose.addEventListener('click', closeManageModal);
  umOverlay.addEventListener('click', closeManageModal);

  umAvatarFile.addEventListener('change', async () => {
    const file = umAvatarFile.files[0];
    umAvatarSaveBtn.disabled = true;
    umAvatarStatus.textContent = '';
    if (!file) return;
    try {
      umPendingAvatarDataUrl = await resizeImageFile(file);
      umAvatarPreview.innerHTML = buildAvatarImg(umPendingAvatarDataUrl, 96);
      umAvatarSaveBtn.disabled = false;
    } catch (err) {
      umAvatarStatus.textContent = err.message;
      umAvatarStatus.style.color = 'var(--accent-2, #ff8b96)';
    }
  });

  umAvatarSaveBtn.addEventListener('click', async () => {
    if (!umPendingAvatarDataUrl) return;
    umAvatarSaveBtn.disabled = true;
    umAvatarStatus.textContent = 'Saving…';
    umAvatarStatus.style.color = '';
    try {
      const res = await fetch('/api/fantasy/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: umUsername, action: 'setAvatar', avatarUrl: umPendingAvatarDataUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      umAvatarStatus.textContent = 'Saved ✓';
      umAvatarStatus.style.color = '#59d97c';
      umPendingAvatarDataUrl = null;
      umAvatarFile.value = '';
      loadManageModal(umUsername);
      load(); // table row's avatar thumbnail should update too
    } catch (err) {
      umAvatarStatus.textContent = `Couldn't save (${err.message}).`;
      umAvatarStatus.style.color = 'var(--accent-2, #ff8b96)';
      umAvatarSaveBtn.disabled = false;
    }
  });

  umCreditApplyBtn.addEventListener('click', async () => {
    const amount = Number(umCreditAmount.value);
    if (!Number.isInteger(amount) || amount === 0) {
      umCreditStatus.textContent = 'Enter a non-zero whole number (negative to deduct).';
      umCreditStatus.style.color = 'var(--accent-2, #ff8b96)';
      return;
    }
    umCreditApplyBtn.disabled = true;
    umCreditStatus.textContent = 'Applying…';
    umCreditStatus.style.color = '';
    try {
      const res = await fetch('/api/fantasy/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: umUsername, action: 'adjustCredits', amount, note: umCreditNote.value }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      umCreditStatus.textContent = 'Applied ✓';
      umCreditStatus.style.color = '#59d97c';
      umCreditAmount.value = '';
      umCreditNote.value = '';
      loadManageModal(umUsername);
      load(); // table row's balance should update too
    } catch (err) {
      umCreditStatus.textContent = `Couldn't apply (${err.message}).`;
      umCreditStatus.style.color = 'var(--accent-2, #ff8b96)';
    } finally {
      umCreditApplyBtn.disabled = false;
    }
  });

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
            <td>
              <button type="button" class="link-btn user-manage-btn">Manage</button>
              <button type="button" class="link-btn user-reset-btn">Reset</button>
            </td>
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
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.classList.contains('user-reset-btn')) {
      resetUsername(tr.dataset.username, e.target);
    } else if (e.target.classList.contains('user-manage-btn')) {
      openManageModal(tr.dataset.username);
    }
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
