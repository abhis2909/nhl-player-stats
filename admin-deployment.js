'use strict';

/* Admin page — Deployment sub-tab: lets you enter an optional projected
   TOI/game, PP TOI/game, and games-projected override per player, for
   the upcoming ("Projected") season on the Stats page — see
   projections.js for how these feed the projection math. Lazy-loaded
   (window.__adminDeploymentTab.ensureLoaded(), called by admin.js on
   first tab open) since it needs the full player bio pool + a DB read,
   not something to fetch on every admin.html page load. */
(function () {
  const seasonLabelEl = document.getElementById('deploySeasonLabel');
  const searchInput = document.getElementById('deploySearchInput');
  const loadingEl = document.getElementById('deployLoading');
  const errorEl = document.getElementById('deployError');
  const emptyEl = document.getElementById('deployEmpty');
  const wrapEl = document.getElementById('deployTableWrap');
  const tbody = document.getElementById('deployTbody');

  const SEARCH_RESULT_CAP = 30;

  let loaded = false;
  let season = null; // e.g. "2026–27" (seasonLabel() format — see data.js)
  let bioPool = []; // full current-roster pool (data.js's loadPlayerBioPool)
  let overrides = new Map(); // nhlPlayerId -> { toiPerGame, ppToiPerGame, gamesProjected }

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function numOrBlank(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function rowHtml(player) {
    const o = overrides.get(player.playerId) || {};
    const hasOverride = overrides.has(player.playerId);
    return `
      <tr data-player-id="${player.playerId}">
        <td>${escapeHtmlLocal(player.name)}${hasOverride ? ' <span class="section-sub">(set)</span>' : ''}</td>
        <td>${escapeHtmlLocal(player.team)}</td>
        <td><input type="number" step="0.1" min="0" class="deploy-toi" value="${numOrBlank(o.toiPerGame)}" style="width:80px"></td>
        <td><input type="number" step="0.1" min="0" class="deploy-pptoi" value="${numOrBlank(o.ppToiPerGame)}" style="width:80px"></td>
        <td><input type="number" step="1" min="0" class="deploy-gp" value="${numOrBlank(o.gamesProjected)}" style="width:70px"></td>
        <td>
          <button type="button" class="link-btn deploy-save">Save</button>
          ${hasOverride ? '<button type="button" class="link-btn deploy-clear" style="color: var(--accent-2, #ff8b96); margin-left:8px;">Clear</button>' : ''}
        </td>
      </tr>
    `;
  }

  function renderRows(players) {
    if (players.length === 0) {
      wrapEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    tbody.innerHTML = players.map(rowHtml).join('');
    wrapEl.hidden = false;
  }

  function currentView() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      return bioPool.filter((p) => overrides.has(p.playerId));
    }
    return bioPool.filter((p) => p.name.toLowerCase().includes(q)).slice(0, SEARCH_RESULT_CAP);
  }

  async function saveRow(tr) {
    const playerId = Number(tr.dataset.playerId);
    const toiPerGame = tr.querySelector('.deploy-toi').value;
    const ppToiPerGame = tr.querySelector('.deploy-pptoi').value;
    const gamesProjected = tr.querySelector('.deploy-gp').value;
    const btn = tr.querySelector('.deploy-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/fantasy/admin-deployment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          season,
          nhlPlayerId: playerId,
          toiPerGame: toiPerGame === '' ? null : Number(toiPerGame),
          ppToiPerGame: ppToiPerGame === '' ? null : Number(ppToiPerGame),
          gamesProjected: gamesProjected === '' ? null : Number(gamesProjected),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      overrides.set(playerId, {
        toiPerGame: data.deployment.toiPerGame,
        ppToiPerGame: data.deployment.ppToiPerGame,
        gamesProjected: data.deployment.gamesProjected,
      });
      btn.textContent = 'Saved ✓';
      renderRows(currentView());
    } catch (err) {
      btn.textContent = 'Save';
      btn.disabled = false;
      window.alert(`Couldn't save (${err.message}).`);
    }
  }

  async function clearRow(playerId) {
    if (!window.confirm('Clear this deployment override? The player will fall back to their historical average.')) return;
    try {
      const res = await fetch(`/api/fantasy/admin-deployment?season=${encodeURIComponent(season)}&nhlPlayerId=${playerId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      overrides.delete(playerId);
      renderRows(currentView());
    } catch (err) {
      window.alert(`Couldn't clear (${err.message}).`);
    }
  }

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.classList.contains('deploy-save')) saveRow(tr);
    if (e.target.classList.contains('deploy-clear')) clearRow(Number(tr.dataset.playerId));
  });

  searchInput.addEventListener('input', () => renderRows(currentView()));

  async function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    wrapEl.hidden = true;
    emptyEl.hidden = true;
    try {
      const data = await loadSeasonData(); // data.js — determines "current," same as app.js
      const projectedSeasonIdVal = data.seasonId + 10001;
      season = seasonLabel(projectedSeasonIdVal); // data.js
      seasonLabelEl.textContent = `for ${season}`;

      const [pool, overridesRes] = await Promise.all([
        loadPlayerBioPool(data.teamMeta), // data.js
        fetch(`/api/fantasy/admin-deployment?season=${encodeURIComponent(season)}`).then((r) => r.json()),
      ]);
      if (!overridesRes.ok) throw new Error(overridesRes.message || 'could not load deployment overrides');

      bioPool = pool.slice().sort((a, b) => a.name.localeCompare(b.name));
      overrides = new Map(overridesRes.deployment.map((d) => [d.nhlPlayerId, d]));

      renderRows(currentView());
    } catch (err) {
      errorEl.textContent = `Couldn't load deployment data (${err.message}).`;
      errorEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
    }
  }

  window.__adminDeploymentTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      load();
    },
  };
})();
