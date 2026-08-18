'use strict';

/* Admin page — Rating Methodology sub-tab: lets you tune the
   percentile-rating engine (ratings.js's POSITION_WEIGHTS/
   GOALIE_WEIGHTS/MIN_GP_FRACTION/RATING_FLOOR..CEIL/RATING_PREMIUM/
   tierFor() thresholds) without a code change — same rating engine
   Player Ratings, Range Ratings, Team of the Week, and the Stats
   page's Power Ranking column all read. Lazy-loaded
   (window.__adminRatingTab.ensureLoaded()), same pattern as the other
   admin sub-tabs. Weight inputs are built dynamically from columns.js's
   SKATER_COLUMNS/GOALIE_COLUMNS catalog, so a stat added to that
   catalog automatically gets a weight field here too. */
(function () {
  const loadingEl = document.getElementById('ratingLoading');
  const errorEl = document.getElementById('ratingError');
  const formEl = document.getElementById('ratingForm');
  const weightGroupsEl = document.getElementById('ratingWeightGroups');
  const minGpEl = document.getElementById('ratingMinGp');
  const floorEl = document.getElementById('ratingFloor');
  const ceilEl = document.getElementById('ratingCeil');
  const premiumEl = document.getElementById('ratingPremium');
  const tierEls = {
    diamond: document.getElementById('tierDiamond'),
    amethyst: document.getElementById('tierAmethyst'),
    ruby: document.getElementById('tierRuby'),
    emerald: document.getElementById('tierEmerald'),
    gold: document.getElementById('tierGold'),
  };
  const saveBtn = document.getElementById('ratingSaveBtn');
  const resetBtn = document.getElementById('ratingResetBtn');
  const saveStatus = document.getElementById('ratingSaveStatus');

  // Same defaults as ratings.js's own hardcoded constants — see
  // public-config.js's DEFAULT_RATING_SETTINGS (kept in sync by hand,
  // same drift-risk note as that file's header comment).
  const DEFAULTS = {
    positionWeights: {
      C: {
        goals: 1.1, assists: 1.4, points: 1.3, plusMinus: 1.0, ppGoals: 1.1, ppPoints: 1.2,
        shGoals: 1.2, shPoints: 1.3, gameWinningGoals: 1.1, otGoals: 1.0, pim: 0.7, sog: 1.0,
        shootingPct: 0.9, gamesPlayed: 0.8, hits: 0.7, blocks: 0.9, giveaways: 1.0, takeaways: 1.1,
        faceoffPct: 1.5,
      },
      W: {
        goals: 1.4, assists: 1.0, points: 1.2, plusMinus: 1.0, ppGoals: 1.3, ppPoints: 1.3,
        shGoals: 0.7, shPoints: 0.6, gameWinningGoals: 1.2, otGoals: 1.1, pim: 0.9, sog: 1.3,
        shootingPct: 1.1, gamesPlayed: 0.8, hits: 1.1, blocks: 0.6, giveaways: 0.9, takeaways: 0.8,
        faceoffPct: 0.3,
      },
      D: {
        goals: 0.6, assists: 1.1, points: 1.0, plusMinus: 1.1, ppGoals: 0.7, ppPoints: 1.1,
        shGoals: 1.0, shPoints: 1.3, gameWinningGoals: 0.7, otGoals: 0.6, pim: 1.0, sog: 0.7,
        shootingPct: 0.6, gamesPlayed: 0.9, hits: 1.5, blocks: 2.1, giveaways: 1.3, takeaways: 1.3,
        faceoffPct: 0.2,
      },
    },
    goalieWeights: {
      wins: 1.3, losses: 0.8, otLosses: 0.7, gaa: 1.4, savePct: 1.4,
      saves: 0.8, shutouts: 1.1, gamesPlayed: 0.6, gamesStarted: 0.7,
      goalsAgainst: 0.8, shotsAgainst: 0.5,
    },
    minGpFraction: 0.2,
    ratingFloor: 25,
    ratingCeil: 99,
    ratingPremium: 1.04,
    tierThresholds: { diamond: 92, amethyst: 87, ruby: 82, emerald: 77, gold: 70 },
  };

  const POSITION_LABEL = { C: 'Centers', W: 'Wingers (L/R combined)', D: 'Defensemen' };

  let loaded = false;
  // Last-loaded (or reset-to-default) settings — readFromForm() merges
  // its edits into this rather than starting blank, so a stat that's
  // currently hidden (not one of the active Stats-page columns, so it
  // has no input on this form) keeps whatever weight it already had
  // instead of silently reverting to 1 on the next Save.
  let currentSettings = DEFAULTS;

  function weightInputId(group, statId) {
    return `ratingW-${group}-${statId}`;
  }

  // Only stats currently active on the Stats page (Admin -> Columns)
  // get a weight field here — a hidden stat isn't part of ratePool()'s
  // computation at all (see ratings.js), so a weight input for it would
  // just be misleading. Synthetic columns (Power Ranking itself) are
  // never rateable inputs, so they're excluded regardless.
  function activeRateableColumns(mode) {
    return activeColumns(mode).filter((c) => !c.synthetic);
  }

  function buildWeightGroups() {
    weightGroupsEl.innerHTML = '';
    const skaterCols = activeRateableColumns('skaters');
    const goalieCols = activeRateableColumns('goalies');
    for (const group of ['C', 'W', 'D']) {
      weightGroupsEl.appendChild(buildWeightSection(POSITION_LABEL[group], group, skaterCols));
    }
    weightGroupsEl.appendChild(buildWeightSection('Goalies', 'G', goalieCols));
  }

  function buildWeightSection(title, group, catalog) {
    const section = document.createElement('section');
    section.className = 'admin-section';
    const head = document.createElement('div');
    head.className = 'admin-section-head';
    head.innerHTML = `<h2 style="font-size: 13.5px;">${title}</h2>`;
    section.appendChild(head);

    if (catalog.length === 0) {
      const note = document.createElement('p');
      note.className = 'admin-hint';
      note.textContent = 'No stat columns are currently selected for this group — enable some under Admin → Columns to tune their weights.';
      section.appendChild(note);
      return section;
    }

    const grid = document.createElement('div');
    grid.className = 'checkbox-grid';
    for (const col of catalog) {
      const field = document.createElement('div');
      field.className = 'fh-field';
      const id = weightInputId(group, col.id);
      field.innerHTML = `
        <label for="${id}">${escapeHtmlLocal(col.label)}</label>
        <input id="${id}" type="number" step="0.1" min="0" data-group="${group}" data-stat="${col.id}">
      `;
      grid.appendChild(field);
    }
    section.appendChild(grid);
    return section;
  }

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function applyToForm(settings) {
    const s = settings || DEFAULTS;
    currentSettings = s; // remembered so readFromForm() can preserve weights for stats not shown right now
    for (const group of ['C', 'W', 'D']) {
      const weights = s.positionWeights[group] || {};
      for (const col of SKATER_COLUMNS) {
        const input = document.getElementById(weightInputId(group, col.id));
        if (input) input.value = weights[col.id] ?? 1;
      }
    }
    for (const col of GOALIE_COLUMNS) {
      const input = document.getElementById(weightInputId('G', col.id));
      if (input) input.value = (s.goalieWeights || {})[col.id] ?? 1;
    }
    minGpEl.value = s.minGpFraction;
    floorEl.value = s.ratingFloor;
    ceilEl.value = s.ratingCeil;
    premiumEl.value = s.ratingPremium;
    for (const key of Object.keys(tierEls)) tierEls[key].value = s.tierThresholds[key];
  }

  // Starts from currentSettings (so any stat currently hidden — not an
  // active Stats-page column, so it has no input on this form — keeps
  // its existing weight untouched) and overlays only what's actually
  // editable right now.
  function readFromForm() {
    const positionWeights = { C: {}, W: {}, D: {} };
    for (const group of ['C', 'W', 'D']) {
      positionWeights[group] = { ...(currentSettings.positionWeights?.[group] || DEFAULTS.positionWeights[group]) };
      for (const col of SKATER_COLUMNS) {
        const input = document.getElementById(weightInputId(group, col.id));
        if (input) positionWeights[group][col.id] = Number(input.value) || 0;
      }
    }
    const goalieWeights = { ...(currentSettings.goalieWeights || DEFAULTS.goalieWeights) };
    for (const col of GOALIE_COLUMNS) {
      const input = document.getElementById(weightInputId('G', col.id));
      if (input) goalieWeights[col.id] = Number(input.value) || 0;
    }
    const tierThresholds = {};
    for (const key of Object.keys(tierEls)) tierThresholds[key] = Number(tierEls[key].value);

    return {
      type: 'rating',
      positionWeights,
      goalieWeights,
      minGpFraction: Number(minGpEl.value),
      ratingFloor: Number(floorEl.value),
      ratingCeil: Number(ceilEl.value),
      ratingPremium: Number(premiumEl.value),
      tierThresholds,
    };
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving…';
    saveStatus.style.color = '';
    try {
      const res = await fetch('/api/fantasy/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFromForm()),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      saveStatus.textContent = 'Saved ✓';
      saveStatus.style.color = '#59d97c';
    } catch (err) {
      saveStatus.textContent = `Couldn't save (${err.message}).`;
      saveStatus.style.color = 'var(--accent-2, #ff8b96)';
    } finally {
      saveBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', () => {
    applyToForm(DEFAULTS);
    saveStatus.textContent = 'Reset to defaults — remember to Save.';
    saveStatus.style.color = '';
  });

  async function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    formEl.hidden = true;
    buildWeightGroups();
    try {
      const res = await fetch('/api/fantasy/admin-settings?type=rating');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      applyToForm(data.settings);
      formEl.hidden = false;
    } catch (err) {
      errorEl.textContent = `Couldn't load rating settings (${err.message}).`;
      errorEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
    }
  }

  window.__adminRatingTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      load();
    },
  };
})();
