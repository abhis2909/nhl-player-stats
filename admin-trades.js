'use strict';

/* Admin page — Trades sub-tab: moderation view over the Fantasy Hub's
   Trade Analyzer log (api/fantasy/trades.js) — same GET the Recent
   Transactions panel on fantasy-hub.html uses, just a higher limit and
   a Delete button per row. GET itself is public/no-auth (the data's
   already visible there); DELETE is admin-gated server-side, so the
   button here is really the only place that action exists. Lazy-loaded
   the same way as the other sub-tabs — admin.js calls
   window.__adminTradesTab.ensureLoaded() on switch. */
(function () {
  const loadingEl = document.getElementById('tradesLoading');
  const errorEl = document.getElementById('tradesError');
  const emptyEl = document.getElementById('tradesEmpty');
  const listEl = document.getElementById('tradesList');
  const refreshBtn = document.getElementById('refreshTradesBtn');

  const LIST_LIMIT = 50;
  let loaded = false;

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function relativeTime(iso) {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function render(trades) {
    if (!trades.length) {
      emptyEl.hidden = false;
      listEl.innerHTML = '';
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = trades.map((t) => {
      const who = escapeHtmlLocal(t.user?.displayName || t.user?.username || 'Someone');
      const sideANames = (t.sideA || []).map((p) => p.name).join(', ');
      const sideBNames = (t.sideB || []).map((p) => p.name).join(', ');
      const winnerLabel = t.winner === 'even' ? 'Even trade' : `Side ${escapeHtmlLocal(t.winner)} wins`;
      // buildAvatarImg comes from avatar.js, already loaded before this
      // script (see admin.html's script order) — same helper every
      // other avatar-rendering spot on the site uses.
      const avatar = typeof buildAvatarImg === 'function' ? buildAvatarImg(t.user?.avatarUrl, 32, 'bust') : '';
      return `
        <div class="fh-transaction-row" data-id="${escapeHtmlLocal(t.id)}">
          ${avatar}
          <div class="fh-tx-body">
            <div class="fh-tx-user">${who}</div>
            <div class="fh-tx-sides">${escapeHtmlLocal(sideANames)} ⇄ ${escapeHtmlLocal(sideBNames)}</div>
          </div>
          <div class="fh-tx-meta">
            <span class="fh-tx-winner">${winnerLabel}</span>
            <span class="fh-tx-time">${relativeTime(t.createdAt)}</span>
          </div>
          <button type="button" class="link-btn trade-delete-btn" title="Delete this trade">🗑</button>
        </div>
      `;
    }).join('');
  }

  async function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    emptyEl.hidden = true;
    refreshBtn.disabled = true;
    try {
      const res = await fetch(`/api/fantasy/trades?limit=${LIST_LIMIT}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      render(data.trades || []);
    } catch (err) {
      errorEl.textContent = `Couldn't load trades (${err.message}).`;
      errorEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', load);

  async function deleteTrade(id, row) {
    if (!window.confirm('Delete this trade? This removes it from Recent Transactions everywhere — cannot be undone.')) return;
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(`/api/fantasy/trades?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      row.remove();
      if (!listEl.children.length) emptyEl.hidden = false;
    } catch (err) {
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      window.alert(`Couldn't delete that trade (${err.message}).`);
    }
  }

  listEl.addEventListener('click', (e) => {
    if (!e.target.classList.contains('trade-delete-btn')) return;
    const row = e.target.closest('.fh-transaction-row');
    if (row) deleteTrade(row.dataset.id, row);
  });

  window.__adminTradesTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      load();
    },
    refresh: load,
  };
})();
