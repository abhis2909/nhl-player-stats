'use strict';

/* Admin page — Yahoo League sub-tab: connects one commissioner-level
   Yahoo account (OAuth 2.0, see api/_lib/yahoo.js + api/fantasy/
   admin-settings.js's yahoo-* dispatch types), picks which Yahoo
   fantasy league to pull from, and triggers a manual sync on top of
   the daily cron (vercel.json). The actual imported data (standings/
   matchups/rosters/transactions/draft) displays on fantasy-hub.html,
   not here — this tab is just connection + sync control.

   "Connect to Yahoo" is a plain <a href> (full browser navigation),
   not a fetch — OAuth has to be a real top-level redirect to Yahoo's
   consent screen and back, not an XHR. Everything else here is a
   normal fetch against admin-settings.js.

   Lazy-loaded (window.__adminYahooTab.ensureLoaded()), same pattern as
   every other admin sub-tab module. */
(function () {
  const el = {
    statusCard: document.getElementById('yahooStatusCard'),
    callbackNote: document.getElementById('yahooCallbackNote'),
    connectBtn: document.getElementById('yahooConnectBtn'),
    discoverBtn: document.getElementById('yahooDiscoverBtn'),
    syncBtn: document.getElementById('yahooSyncBtn'),
    saveStatus: document.getElementById('yahooSaveStatus'),
    leaguePicker: document.getElementById('yahooLeaguePicker'),
    leagueSelect: document.getElementById('yahooLeagueSelect'),
    useLeagueBtn: document.getElementById('yahooUseLeagueBtn'),
  };

  let loaded = false;
  let discoveredLeagues = []; // [{leagueKey, gameKey, name, season}] — kept in memory so the select's value can just be an index

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const CALLBACK_MESSAGES = {
    connected: 'Connected to Yahoo. Pick a league below, then Sync now.',
    denied: 'Yahoo sign-in was cancelled or denied — try Connect to Yahoo again.',
    state_mismatch: "That link looked stale (or reused) — click Connect to Yahoo again to get a fresh one.",
    no_code: "Yahoo didn't send back an authorization code — try Connect to Yahoo again.",
    error: "Something went wrong completing the Yahoo connection — check Vercel's function logs for the real error.",
  };

  /** Shows the one-time banner from the OAuth callback redirect
   *  (?yahoo=connected etc. on this page's own URL), then strips it
   *  from the address bar so a refresh doesn't re-show it. */
  function consumeCallbackNote() {
    const params = new URLSearchParams(location.search);
    const outcome = params.get('yahoo');
    if (!outcome) return;
    const message = CALLBACK_MESSAGES[outcome];
    if (message) {
      el.callbackNote.textContent = message;
      el.callbackNote.hidden = false;
    }
    params.delete('yahoo');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
  }

  function fmtDate(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
  }

  async function loadStatus() {
    el.statusCard.innerHTML = '<p class="admin-hint">Checking connection…</p>';
    let data;
    try {
      const res = await fetch('/api/fantasy/admin-settings?type=yahoo-status');
      data = await res.json();
    } catch {
      el.statusCard.innerHTML = '<p class="admin-hint">Couldn\'t reach the server — try reloading.</p>';
      return;
    }
    if (!data.ok) {
      el.statusCard.innerHTML = `<p class="admin-hint">${escapeHtmlLocal(data.message || 'Something went wrong loading connection status.')}</p>`;
      return;
    }

    if (!data.connected) {
      el.statusCard.innerHTML = '<p class="adm-yahoo-status-line">🔴 Not connected yet.</p>';
      el.connectBtn.textContent = '🔗 Connect to Yahoo';
      el.discoverBtn.hidden = true;
      el.syncBtn.hidden = true;
      el.leaguePicker.hidden = true;
      return;
    }

    el.connectBtn.textContent = '🔗 Reconnect to Yahoo';
    el.discoverBtn.hidden = false;
    el.syncBtn.hidden = false;

    const leagueLine = data.leagueKey
      ? `League: <strong>${escapeHtmlLocal(data.leagueName || data.leagueKey)}</strong>`
      : 'No league picked yet — click "Find my leagues" below.';
    el.statusCard.innerHTML = `
      <p class="adm-yahoo-status-line">🟢 Connected. ${leagueLine}</p>
      <p class="adm-yahoo-status-line">Last synced: ${escapeHtmlLocal(fmtDate(data.lastSyncAt))}</p>
    `;
  }

  async function discoverLeagues() {
    el.discoverBtn.disabled = true;
    el.saveStatus.textContent = 'Looking up your leagues…';
    try {
      const res = await fetch('/api/fantasy/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'yahoo-discover-leagues' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      discoveredLeagues = data.leagues || [];
      if (!discoveredLeagues.length) {
        el.saveStatus.textContent = 'No NHL fantasy leagues found on that Yahoo account.';
      } else {
        el.leagueSelect.innerHTML = discoveredLeagues.map((l, i) => `
          <option value="${i}">${escapeHtmlLocal(l.name)} (${escapeHtmlLocal(l.season || l.gameKey)})</option>
        `).join('');
        el.leaguePicker.hidden = false;
        el.saveStatus.textContent = `Found ${discoveredLeagues.length} league${discoveredLeagues.length === 1 ? '' : 's'}.`;
      }
    } catch (err) {
      el.saveStatus.textContent = `Couldn't look up leagues: ${err.message}`;
    } finally {
      el.discoverBtn.disabled = false;
      setTimeout(() => { el.saveStatus.textContent = ''; }, 5000);
    }
  }

  async function useSelectedLeague() {
    const league = discoveredLeagues[Number(el.leagueSelect.value)];
    if (!league) return;
    el.useLeagueBtn.disabled = true;
    el.saveStatus.textContent = 'Saving…';
    try {
      const res = await fetch('/api/fantasy/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'yahoo-set-league', leagueKey: league.leagueKey, gameKey: league.gameKey, leagueName: league.name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      el.saveStatus.textContent = `Using ${league.name}. Click "Sync now" to pull its data.`;
      await loadStatus();
    } catch (err) {
      el.saveStatus.textContent = `Couldn't save that: ${err.message}`;
    } finally {
      el.useLeagueBtn.disabled = false;
      setTimeout(() => { el.saveStatus.textContent = ''; }, 6000);
    }
  }

  async function syncNow() {
    el.syncBtn.disabled = true;
    el.saveStatus.textContent = 'Syncing… (this pulls rosters for every team, so it can take a bit)';
    try {
      const res = await fetch('/api/fantasy/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'yahoo-sync' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      const s = data.summary;
      el.saveStatus.textContent = `Synced: ${s.matchups} matchup(s), ${s.rosters} roster(s), ${s.transactions} transaction(s).`;
      await loadStatus();
    } catch (err) {
      el.saveStatus.textContent = `Sync failed: ${err.message}`;
    } finally {
      el.syncBtn.disabled = false;
      setTimeout(() => { el.saveStatus.textContent = ''; }, 8000);
    }
  }

  function wireEvents() {
    el.discoverBtn.addEventListener('click', discoverLeagues);
    el.useLeagueBtn.addEventListener('click', useSelectedLeague);
    el.syncBtn.addEventListener('click', syncNow);
  }

  function init() {
    consumeCallbackNote();
    wireEvents();
    loadStatus();
  }

  window.__adminYahooTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      init();
    },
  };
})();
