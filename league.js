'use strict';

/* Fantasy Hub page — "League" panel: reads the Yahoo Fantasy import's
   cached data (api/fantasy/public-config.js's `?type=yahoo`, itself
   fed by the admin's Yahoo League tab / the daily cron — see
   api/_lib/yahoo.js) and renders standings/matchups/rosters/
   transactions/draft. Public, no login needed, same as the rest of
   this file's data.

   Every render*() function is wrapped so one section's Yahoo-shape
   surprise can't blank the whole panel — see the file-level comment in
   api/_lib/yahoo.js for why this is written defensively rather than
   assuming an exact shape: this was built against Yahoo's documented/
   community-reverse-engineered JSON contract with no live account to
   test against, so a field landing in a slightly different spot than
   expected is the most likely first bug, not a sign anything else is
   wrong. rawData on every cache row (and here, in each fetched blob)
   is always the untouched original response, so fixing a parse tweak
   never needs another Yahoo round trip. */
(function () {
  const el = {
    panel: document.getElementById('panelLeague'),
    fetchedNote: document.getElementById('leagueFetchedNote'),
    subtabs: document.getElementById('leagueSubtabs'),
    standings: document.getElementById('leagueStandings'),
    matchups: document.getElementById('leagueMatchups'),
    rosters: document.getElementById('leagueRosters'),
    transactions: document.getElementById('leagueTransactions'),
    draft: document.getElementById('leagueDraft'),
  };
  if (!el.panel) return; // this script only matters on fantasy-hub.html

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Yahoo's XML-derived JSON shape — see file header ----------
  function yArr(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const out = [];
    for (const key of Object.keys(obj)) {
      if (key === 'count') continue;
      out.push(obj[key]);
    }
    return out;
  }
  // Merges a "resource" (team/player/transaction/...) into one flat
  // object — handles both shapes Yahoo mixes together: an array of
  // single-key fragments directly, OR one element of the outer array
  // itself being such a fragments-array (the common "[metaFragments,
  // {team_standings:{...}}, ...]" pattern).
  function yFlat(resource) {
    const out = {};
    const items = Array.isArray(resource) ? resource : [resource];
    for (const item of items) {
      if (Array.isArray(item)) {
        for (const inner of item) {
          if (inner && typeof inner === 'object') Object.assign(out, inner);
        }
      } else if (item && typeof item === 'object') {
        Object.assign(out, item);
      }
    }
    return out;
  }

  function renderSection(container, fn, label) {
    try {
      fn();
    } catch (err) {
      console.error(`league.js: couldn't render ${label}`, err);
      container.innerHTML = `<p class="admin-hint">Couldn't read the ${label} data yet — the sync may need a refresh, or Yahoo's response shape shifted. Try Admin → Yahoo League → Sync now.</p>`;
    }
  }

  function renderStandings(rawData) {
    if (!rawData) { el.standings.innerHTML = '<p class="admin-hint">No standings synced yet.</p>'; return; }
    renderSection(el.standings, () => {
      const standingsNode = rawData?.fantasy_content?.league?.[1]?.standings?.[0];
      const teams = yArr(standingsNode?.teams).map((t) => yFlat(t?.team));
      if (!teams.length) { el.standings.innerHTML = '<p class="admin-hint">No teams found in the standings data.</p>'; return; }
      teams.sort((a, b) => Number(yFlat(a.team_standings).rank ?? 99) - Number(yFlat(b.team_standings).rank ?? 99));
      el.standings.innerHTML = `
        <table class="league-table">
          <thead><tr><th>Rank</th><th>Team</th><th>Record</th><th>Points For</th></tr></thead>
          <tbody>
            ${teams.map((t) => {
              const st = yFlat(t.team_standings);
              const outcome = yFlat(st.outcome_totals);
              const record = outcome.wins != null
                ? `${outcome.wins}-${outcome.losses}${outcome.ties ? `-${outcome.ties}` : ''}`
                : '—';
              return `<tr>
                <td>${escapeHtmlLocal(st.rank ?? '—')}</td>
                <td>${escapeHtmlLocal(t.name ?? t.team_key ?? '—')}</td>
                <td>${escapeHtmlLocal(record)}</td>
                <td>${escapeHtmlLocal(st.points_for ?? '—')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;
    }, 'standings');
  }

  function renderMatchups(matchupRows) {
    if (!matchupRows || !matchupRows.length) { el.matchups.innerHTML = '<p class="admin-hint">No matchups synced yet.</p>'; return; }
    renderSection(el.matchups, () => {
      const cards = matchupRows.map(({ weekKey, rawData }) => {
        const matchup = rawData?.matchup;
        const teams = yArr(matchup?.[0]?.teams ?? matchup?.teams).map((t) => yFlat(t?.team));
        if (teams.length !== 2) return '';
        const [a, b] = teams;
        const ptsA = yFlat(a.team_points).total ?? '—';
        const ptsB = yFlat(b.team_points).total ?? '—';
        return `
          <div class="league-matchup-card">
            <span class="league-matchup-week">Week ${escapeHtmlLocal(weekKey)}</span>
            <div class="league-matchup-row">
              <span>${escapeHtmlLocal(a.name ?? '—')}</span>
              <strong>${escapeHtmlLocal(ptsA)}</strong>
            </div>
            <div class="league-matchup-row">
              <span>${escapeHtmlLocal(b.name ?? '—')}</span>
              <strong>${escapeHtmlLocal(ptsB)}</strong>
            </div>
          </div>
        `;
      }).filter(Boolean).join('');
      el.matchups.innerHTML = cards || '<p class="admin-hint">Couldn\'t read any matchup rows.</p>';
    }, 'matchups');
  }

  function renderRosters(rosterRows) {
    if (!rosterRows || !rosterRows.length) { el.rosters.innerHTML = '<p class="admin-hint">No rosters synced yet.</p>'; return; }
    renderSection(el.rosters, () => {
      el.rosters.innerHTML = rosterRows.map(({ teamName, rawData }) => {
        const rosterNode = rawData?.fantasy_content?.team?.[1]?.roster;
        const players = yArr(rosterNode?.[0]?.players ?? rosterNode?.players).map((p) => yFlat(p?.player));
        return `
          <div class="league-roster-card">
            <h3>${escapeHtmlLocal(teamName)}</h3>
            <ul class="league-roster-list">
              ${players.map((p) => {
                const name = p.name?.full ?? p.name ?? '—';
                const pos = p.display_position ?? p.primary_position ?? '';
                return `<li>${escapeHtmlLocal(name)}${pos ? ` <span class="league-pos">${escapeHtmlLocal(pos)}</span>` : ''}</li>`;
              }).join('') || '<li class="admin-hint">No players found.</li>'}
            </ul>
          </div>
        `;
      }).join('');
    }, 'rosters');
  }

  function renderTransactions(txRows) {
    if (!txRows || !txRows.length) { el.transactions.innerHTML = '<p class="admin-hint">No transactions synced yet.</p>'; return; }
    renderSection(el.transactions, () => {
      el.transactions.innerHTML = `<div class="fh-transactions-list">${txRows.map((raw) => {
        const tx = yFlat(raw?.transaction?.[0]);
        const players = yArr(raw?.transaction?.[1]?.players).map((p) => yFlat(p?.player));
        const names = players.map((p) => p.name?.full ?? p.name ?? '').filter(Boolean).join(', ');
        return `<div class="fh-transaction-row">
          <strong>${escapeHtmlLocal((tx.type ?? 'transaction').replace(/_/g, ' '))}</strong>
          <span>${escapeHtmlLocal(names || '—')}</span>
        </div>`;
      }).join('')}</div>`;
    }, 'transactions');
  }

  function renderDraft(rawData) {
    if (!rawData) { el.draft.innerHTML = '<p class="admin-hint">No draft results synced yet.</p>'; return; }
    renderSection(el.draft, () => {
      const picks = yArr(rawData?.fantasy_content?.league?.[1]?.draft_results)
        .map((d) => yFlat(d?.draft_result))
        .sort((a, b) => Number(a.pick ?? 0) - Number(b.pick ?? 0));
      if (!picks.length) { el.draft.innerHTML = '<p class="admin-hint">No draft picks found.</p>'; return; }
      el.draft.innerHTML = `
        <table class="league-table">
          <thead><tr><th>Pick</th><th>Round</th><th>Player</th><th>Team</th></tr></thead>
          <tbody>
            ${picks.map((p) => `<tr>
              <td>${escapeHtmlLocal(p.pick ?? '—')}</td>
              <td>${escapeHtmlLocal(p.round ?? '—')}</td>
              <td>${escapeHtmlLocal(p.player_key ?? '—')}</td>
              <td>${escapeHtmlLocal(p.team_key ?? '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `;
    }, 'draft');
  }

  function wireSubtabs() {
    const panels = {
      standings: el.standings, matchups: el.matchups, rosters: el.rosters,
      transactions: el.transactions, draft: el.draft,
    };
    el.subtabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-league-tab]');
      if (!btn) return;
      const name = btn.dataset.leagueTab;
      for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
      Array.from(el.subtabs.querySelectorAll('[data-league-tab]')).forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    });
  }

  async function init() {
    wireSubtabs();
    let data;
    try {
      const res = await fetch('/api/fantasy/public-config?type=yahoo');
      data = await res.json();
    } catch {
      return; // no Yahoo panel if the site has nothing connected / errors — not a core feature, fail quiet
    }
    if (!data.ok || !data.connected) return;

    el.panel.hidden = false;
    el.fetchedNote.textContent = data.leagueName
      ? `${data.leagueName} — last synced ${data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : 'never'}`
      : '';

    renderStandings(data.standings);
    renderMatchups(data.matchups);
    renderRosters(data.rosters);
    renderTransactions(data.transactions);
    renderDraft(data.draft);
  }

  init();
})();
