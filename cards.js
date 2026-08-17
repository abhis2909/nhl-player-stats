'use strict';

/* ======================================================================
   Player cards: percentile-based fantasy ratings for every qualified
   skater AND goalie, season-to-date. Uses the same season data as the
   stats page (data.js), the same stat-column selections as the admin
   page (columns.js), and the shared rating engine + card renderer in
   ratings.js (also used by range.js for week/month "Range Ratings").
   Whichever skater/goalie columns are enabled in ⚙ Columns are exactly
   the categories shown here, so changing that selection changes the
   cards too (see the `storage` listener near the bottom for the
   same-tab-open-elsewhere case).

   Rating methodology (full detail in ratings.js's header comment):
   - Eligibility pool here = players with gamesPlayed >= MIN_GP_FRACTION
     of that position group's own season game count (skaters and goalies
     are counted separately — goalies play far fewer games than skaters,
     so a goalie-specific max keeps the bar meaningful). Derived from the
     data itself (seasonGameCount() in data.js), not hardcoded, so this
     keeps working once 2026-27 stats replace these.
   - ratePool() (ratings.js) turns that pool into percentile-based
     ratings; buildCard() (ratings.js) renders the gem-tier card HTML.

   Card visuals: overall maps to one of six gem tiers (tierFor()) — Silver
   / Gold / Emerald / Ruby / Amethyst / Diamond — and tier drives more
   than color: border shimmer speed, sheen-sweep strength, badge/aura
   glow, pulse, sparkles, and stat-tile shape all scale with rarity (see
   the .tier-* rules in style.css). Team is just the small logo+
   abbreviation pill, not the card's theme color.

   Detail modal (click a card): bio, a rating-trend chart built from
   saved weekly snapshots (shows "Start of season" until at least 2
   points exist — see snapshots.js and buildSnapshotTrendPoints()), and
   the full scrollable game log for whichever season/type is selected —
   see the "player detail modal" section below.
   ====================================================================== */

const BATCH_SIZE = 48;

const el = {
  seasonLabel: document.getElementById('seasonLabel'),
  statusBanner: document.getElementById('statusBanner'),
  eligibilityNote: document.getElementById('eligibilityNote'),
  skeleton: document.getElementById('cardsSkeleton'),
  grid: document.getElementById('cardsGrid'),
  resultCount: document.getElementById('resultCount'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  searchInput: document.getElementById('searchInput'),
  teamSelect: document.getElementById('teamSelect'),
  modeButtons: Array.from(document.querySelectorAll('.toggle-btn[data-mode]')),
  posToggleGroup: document.getElementById('posToggleGroup'),
  posButtons: Array.from(document.querySelectorAll('.toggle-btn[data-pos]')),
  modalRoot: document.getElementById('modalRoot'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalContent: document.getElementById('modalContent'),
  compareBar: document.getElementById('compareBar'),
  compareBarText: document.getElementById('compareBarText'),
  compareBtn: document.getElementById('compareBtn'),
  compareClearBtn: document.getElementById('compareClearBtn'),
  compareModalRoot: document.getElementById('compareModalRoot'),
  compareModalOverlay: document.getElementById('compareModalOverlay'),
  compareModalClose: document.getElementById('compareModalClose'),
  compareModalContent: document.getElementById('compareModalContent'),
};

const state = {
  teamMeta: new Map(),
  seasonId: null,
  mode: 'skaters', // 'skaters' | 'goalies'
  rawSkaters: [], ratedSkaters: [], skaterMinGP: 0, skaterMaxGP: 0,
  rawGoalies: [], ratedGoalies: [], goalieMinGP: 0, goalieMaxGP: 0,
  search: '',
  team: 'ALL',
  pos: 'ALL',
  visibleCount: BATCH_SIZE,
  compareSelections: new Map(), // playerId -> rated player, max 2, same mode only
};

// Per-game data sources for the game log + monthly trend. Regular-season
// box score fields (goals, assists, PPP, etc.) come straight from the
// game-log endpoint. Hits/blocks/giveaways/takeaways aren't in that
// response at all — they come from a second, batched query to the
// stats-rest API's per-game realtime report (isGame=true). Anything not
// resolvable per game (shootingPct, faceoffPct) shows as "—".
const GAMELOG_FIELD_MAP = {
  goals: 'goals', assists: 'assists', points: 'points', plusMinus: 'plusMinus',
  ppGoals: 'powerPlayGoals', ppPoints: 'powerPlayPoints', shGoals: 'shorthandedGoals',
  shPoints: 'shorthandedPoints', gameWinningGoals: 'gameWinningGoals', otGoals: 'otGoals',
  pim: 'pim', sog: 'shots',
};
const REALTIME_FIELD_MAP = { hits: 'hits', blocks: 'blockedShots', giveaways: 'giveaways', takeaways: 'takeaways' };

function showBanner(message) {
  el.statusBanner.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Retry';
  btn.addEventListener('click', init);
  el.statusBanner.append(span, btn);
  el.statusBanner.hidden = false;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function rateAllPlayers() {
  state.ratedSkaters = ratePool(state.rawSkaters, 'skaters');
  state.ratedGoalies = ratePool(state.rawGoalies, 'goalies');
}

async function init() {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.grid.innerHTML = '';

  try {
    const { seasonId, teamMeta, skaters, goalies, source, snapshotLabel } = await getSeasonData();
    state.teamMeta = teamMeta;
    state.seasonId = seasonId;
    el.seasonLabel.textContent = `${seasonLabel(seasonId)} · Ratings` +
      (source === 'snapshot' ? ` · ${snapshotLabel}` : '');

    state.skaterMaxGP = seasonGameCount(skaters);
    state.skaterMinGP = Math.ceil(state.skaterMaxGP * MIN_GP_FRACTION);
    state.rawSkaters = skaters.filter((p) => p.gamesPlayed >= state.skaterMinGP);

    state.goalieMaxGP = seasonGameCount(goalies);
    state.goalieMinGP = Math.ceil(state.goalieMaxGP * MIN_GP_FRACTION);
    state.rawGoalies = goalies.filter((p) => p.gamesPlayed >= state.goalieMinGP);

    rateAllPlayers();
    populateTeamSelect();
    updateEligibilityNote();
    el.skeleton.hidden = true;
    render(true);
  } catch (err) {
    el.skeleton.hidden = true;
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  }
}

function updateEligibilityNote() {
  const isGoalie = state.mode === 'goalies';
  const pool = isGoalie ? state.rawGoalies : state.rawSkaters;
  const minGP = isGoalie ? state.goalieMinGP : state.skaterMinGP;
  const maxGP = isGoalie ? state.goalieMaxGP : state.skaterMaxGP;
  el.eligibilityNote.textContent =
    `Showing the ${pool.length.toLocaleString()} ${state.mode} who've played at least ${minGP} games ` +
    `this season (30% of ${maxGP}). Categories match your ⚙ Columns selection for ${state.mode} — change it ` +
    `there and these update too. Ratings (including overall) are percentile ranks scaled to ${RATING_FLOOR}` +
    `–${RATING_CEIL}; overall is a weighted average of the category percentiles.`;
}

function populateTeamSelect() {
  const teams = Array.from(state.teamMeta.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const frag = document.createDocumentFragment();
  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = 'All Teams';
  frag.appendChild(allOpt);
  for (const [abbrev, meta] of teams) {
    const opt = document.createElement('option');
    opt.value = abbrev;
    opt.textContent = meta.name;
    frag.appendChild(opt);
  }
  el.teamSelect.innerHTML = '';
  el.teamSelect.appendChild(frag);
}

function getFiltered() {
  const q = state.search.trim().toLowerCase();
  const pool = state.mode === 'goalies' ? state.ratedGoalies : state.ratedSkaters;
  return pool
    .filter((p) => {
      if (state.team !== 'ALL' && p.team !== state.team) return false;
      if (state.mode === 'skaters' && state.pos !== 'ALL' && positionGroup(p.pos) !== state.pos) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.overall - a.overall);
}

/** @param reset - true when a filter/mode/column-config changed; false for "load more". */
function render(reset) {
  if (reset) state.visibleCount = BATCH_SIZE;
  const filtered = getFiltered();
  const slice = filtered.slice(0, state.visibleCount);

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  slice.forEach((p) => frag.appendChild(buildCardWithCompare(p)));
  el.grid.appendChild(frag);

  el.resultCount.textContent = `Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} ${state.mode}`;
  el.loadMoreWrap.hidden = slice.length >= filtered.length;
}

/** buildCard() (ratings.js) plus a "Compare" checkbox strip appended
 *  below it — kept out of the shared buildCard() itself since Range
 *  Ratings/Team of the Week reuse that function and don't want this. */
function buildCardWithCompare(player) {
  const card = buildCard(player, state.teamMeta, openPlayerModal);

  const bar = document.createElement('label');
  bar.className = 'pc-compare-bar';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.compareSelections.has(player.playerId);
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the card's own click-to-open-modal
    toggleCompare(player);
  });
  const text = document.createElement('span');
  text.textContent = 'Compare';
  bar.append(checkbox, text);
  card.appendChild(bar);

  return card;
}

// ---------------------------------------------------------------------
// Compare two players
// ---------------------------------------------------------------------

function toggleCompare(player) {
  if (state.compareSelections.has(player.playerId)) {
    state.compareSelections.delete(player.playerId);
  } else {
    const existing = Array.from(state.compareSelections.values());
    const isGoalie = player.pos === 'G';
    // Comparing a skater against a goalie wouldn't mean anything (totally
    // different stat categories) — starting a new pick in the other mode
    // just replaces whatever was selected instead of erroring.
    if (existing.length && (existing[0].pos === 'G') !== isGoalie) {
      state.compareSelections.clear();
    } else if (state.compareSelections.size >= 2) {
      // Already have 2 — bump the oldest pick (Maps preserve insertion order).
      state.compareSelections.delete(state.compareSelections.keys().next().value);
    }
    state.compareSelections.set(player.playerId, player);
  }
  updateCompareBar();
  render(false);
}

function updateCompareBar() {
  const n = state.compareSelections.size;
  el.compareBar.hidden = n === 0;
  if (n === 0) return;
  const names = Array.from(state.compareSelections.values()).map((p) => p.name);
  el.compareBarText.textContent = n === 1
    ? `${names[0]} — pick one more player to compare`
    : `${names[0]} vs ${names[1]}`;
  el.compareBtn.disabled = n !== 2;
}

el.compareClearBtn.addEventListener('click', () => {
  state.compareSelections.clear();
  updateCompareBar();
  render(false);
});

el.compareBtn.addEventListener('click', () => {
  const [a, b] = Array.from(state.compareSelections.values());
  if (a && b) openCompareModal(a, b);
});

function closeCompareModal() {
  el.compareModalRoot.hidden = true;
  document.body.style.overflow = '';
  el.compareModalContent.innerHTML = '';
}

el.compareModalClose.addEventListener('click', closeCompareModal);
el.compareModalOverlay.addEventListener('click', closeCompareModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.compareModalRoot.hidden) closeCompareModal();
});

// ---------------------------------------------------------------------
// Stats windows — shared by the compare modal and the single-player
// modal's Season Totals section. Six views: previous/current season
// totals + per-game, and last week totals + per-game.
// ---------------------------------------------------------------------

const PREV_SEASON_OFFSET = 10001; // NHL season ids are YYYYYYYY+1; subtract this to step back one season
const PER_GAME_EXEMPT = new Set(['shootingPct', 'faceoffPct', 'gaa', 'savePct']); // already rates — per-game toggle leaves these as-is

const STATS_WINDOW_OPTIONS = [
  { key: 'prevTotal', label: () => `${seasonLabel(state.seasonId - PREV_SEASON_OFFSET)} Season (Total)` },
  { key: 'prevPerGame', label: () => `${seasonLabel(state.seasonId - PREV_SEASON_OFFSET)} Season (Per Game)` },
  { key: 'currentTotal', label: () => `${seasonLabel(state.seasonId)} Season (Total)` },
  { key: 'currentPerGame', label: () => `${seasonLabel(state.seasonId)} Season (Per Game)` },
  { key: 'lastWeekTotal', label: () => 'Last Week (Total)' },
  { key: 'lastWeekPerGame', label: () => 'Last Week (Per Game)' },
];

function statsWindowOptionsHtml() {
  return STATS_WINDOW_OPTIONS.map((o) => `<option value="${o.key}">${escapeHtml(o.label())}</option>`).join('');
}

/** { raw, gamesPlayed, perGame } for `player` in one of the 6 windows
 *  above, or null if that window isn't available right now (no
 *  previous-season data, or missing weekly snapshots for "last week").
 *  `raw` always carries every catalog stat id it can resolve, including
 *  hits/blocks/giveaways/takeaways where possible:
 *   - current season: the already-loaded rated `player` object itself
 *     (built from data.js's buildSkaters/buildGoalies, which already
 *     merges in realtime stats) — no fetch needed.
 *   - previous season: landing.seasonTotals (doesn't have realtime
 *     stats) PLUS a supplemental stats-rest realtime query for that
 *     specific season, merged in.
 *   - last week: raw snapshot skater/goalie records, which already
 *     include realtime stats (every snapshot is a full buildSkaters()
 *     capture) — subtracted via the shared deltaValue() (ratings.js). */
async function statsWindowFor(player, viewKey) {
  const isGoalie = player.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters');
  const perGame = viewKey.endsWith('PerGame');

  if (viewKey === 'currentTotal' || viewKey === 'currentPerGame') {
    const gp = player.gamesPlayed ?? 0;
    if (!gp) return null;
    return { raw: player, gamesPlayed: gp, perGame };
  }

  if (viewKey === 'prevTotal' || viewKey === 'prevPerGame') {
    const prevSeasonId = state.seasonId - PREV_SEASON_OFFSET;
    let landing;
    try {
      landing = await getJSON(`${API_WEB}/v1/player/${player.playerId}/landing`);
    } catch {
      return null;
    }
    const totals = (landing.seasonTotals || []).find(
      (s) => s.leagueAbbrev === 'NHL' && s.season === prevSeasonId && s.gameTypeId === 2,
    );
    if (!totals) return null;

    const raw = { gamesPlayed: totals.gamesPlayed ?? 0 };
    for (const cat of categories) {
      if (cat.id === 'gamesPlayed') continue;
      raw[cat.id] = seasonTotalValue(totals, cat.id, isGoalie);
    }
    if (!isGoalie && categories.some((c) => REALTIME_FIELD_MAP[c.id])) {
      try {
        const filter = `seasonId=${prevSeasonId} and gameTypeId=2 and playerId=${player.playerId}`;
        const rt = await getJSON(`${API_STATS}/en/skater/realtime?cayenneExp=${encodeURIComponent(filter)}`);
        const row = rt.data?.[0];
        if (row) {
          raw.hits = row.hits ?? 0;
          raw.blocks = row.blockedShots ?? 0;
          raw.giveaways = row.giveaways ?? 0;
          raw.takeaways = row.takeaways ?? 0;
        }
      } catch {
        // Non-fatal — those columns just show "—" for this player/season.
      }
    }
    return { raw, gamesPlayed: raw.gamesPlayed, perGame };
  }

  if (viewKey === 'lastWeekTotal' || viewKey === 'lastWeekPerGame') {
    const thisMonday = mondayOf(todayISO());
    const lastMonday = addDays(thisMonday, -7);
    const fromFull = getSnapshotByKey(lastMonday);
    const toFull = getSnapshotByKey(thisMonday);
    if (!fromFull || !toFull) return null;

    const fromList = isGoalie ? fromFull.data.goalies : fromFull.data.skaters;
    const toList = isGoalie ? toFull.data.goalies : toFull.data.skaters;
    const fromP = fromList.find((p) => p.playerId === player.playerId) || {};
    const toP = toList.find((p) => p.playerId === player.playerId);
    if (!toP) return null;

    const gpDelta = (toP.gamesPlayed ?? 0) - (fromP.gamesPlayed ?? 0);
    if (gpDelta <= 0) return null;
    const raw = { gamesPlayed: gpDelta };
    for (const cat of categories) {
      if (cat.id === 'gamesPlayed') continue;
      raw[cat.id] = deltaValue(cat.id, fromP, toP, isGoalie);
    }
    return { raw, gamesPlayed: gpDelta, perGame };
  }

  return null;
}

function statsWindowValue(win, catId) {
  if (!win) return null;
  const raw = win.raw[catId];
  if (raw == null) return null;
  if (win.perGame && !PER_GAME_EXEMPT.has(catId) && win.gamesPlayed > 0) return raw / win.gamesPlayed;
  return raw;
}

function formatWindowValue(col, win) {
  const value = statsWindowValue(win, col.id);
  if (value == null) return '—';
  if (win.perGame && !PER_GAME_EXEMPT.has(col.id)) return value.toFixed(2);
  return formatColumnValue(col, value);
}

async function renderCompareTable(a, b, viewKey) {
  const wrap = document.getElementById('compareTableWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';

  const [winA, winB] = await Promise.all([statsWindowFor(a, viewKey), statsWindowFor(b, viewKey)]);
  if (!winA || !winB) {
    const missing = !winA ? a.name : b.name;
    wrap.innerHTML = `<div class="gamelog-empty">Not enough data for this view for ${escapeHtml(missing)}.</div>`;
    return;
  }

  const isGoalie = a.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters');

  const overallRow = `
    <tr class="cmp-overall-row">
      <td class="cmp-val ${a.overall > b.overall ? 'cmp-win' : ''}">${a.overall}</td>
      <td class="cmp-label" title="Season-long overall rating">OVR</td>
      <td class="cmp-val ${b.overall > a.overall ? 'cmp-win' : ''}">${b.overall}</td>
    </tr>`;

  const rows = categories.map((cat) => {
    const av = statsWindowValue(winA, cat.id);
    const bv = statsWindowValue(winB, cat.id);
    const inverted = INVERT_STATS.has(cat.id);
    let aWin = false;
    let bWin = false;
    if (av != null && bv != null && av !== bv) {
      aWin = inverted ? av < bv : av > bv;
      bWin = !aWin;
    }
    return `
      <tr>
        <td class="cmp-val ${aWin ? 'cmp-win' : ''}">${escapeHtml(formatWindowValue(cat, winA))}</td>
        <td class="cmp-label" title="${escapeHtml(cat.label)}">${escapeHtml(cat.short)}</td>
        <td class="cmp-val ${bWin ? 'cmp-win' : ''}">${escapeHtml(formatWindowValue(cat, winB))}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="compare-table"><tbody>${overallRow}${rows}</tbody></table>`;
}

async function openCompareModal(a, b) {
  el.compareModalRoot.hidden = false;
  document.body.style.overflow = 'hidden';

  el.compareModalContent.innerHTML = `
    <div class="compare-heads">
      <div class="compare-head">${buildCard(a, state.teamMeta).outerHTML}</div>
      <div class="compare-vs">VS</div>
      <div class="compare-head">${buildCard(b, state.teamMeta).outerHTML}</div>
    </div>
    <div class="stats-window-bar">
      <label for="compareViewSelect">Stats</label>
      <select id="compareViewSelect">${statsWindowOptionsHtml()}</select>
    </div>
    <div id="compareTableWrap"><div class="gamelog-loading">Loading…</div></div>
  `;

  const select = document.getElementById('compareViewSelect');
  select.value = 'currentTotal';
  select.addEventListener('change', () => renderCompareTable(a, b, select.value));
  await renderCompareTable(a, b, 'currentTotal');
}

el.modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    el.modeButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    // Position (C/W/D) filter is skater-only.
    el.posToggleGroup.hidden = state.mode === 'goalies';
    state.pos = 'ALL';
    el.posButtons.forEach((b) => b.classList.toggle('active', b.dataset.pos === 'ALL'));
    updateEligibilityNote();
    render(true);
  });
});

el.searchInput.addEventListener('input', debounce(() => {
  state.search = el.searchInput.value;
  render(true);
}, 150));

el.teamSelect.addEventListener('change', () => {
  state.team = el.teamSelect.value;
  render(true);
});

el.posButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.pos = btn.dataset.pos;
    el.posButtons.forEach((b) => b.classList.toggle('active', b === btn));
    render(true);
  });
});

el.loadMoreBtn.addEventListener('click', () => {
  state.visibleCount += BATCH_SIZE;
  render(false);
});

// If the admin page (⚙ Columns) is open in another tab and saves a change,
// pick it up here live instead of requiring a reload.
window.addEventListener('storage', (e) => {
  if (e.key !== COLUMN_STORAGE_KEY) return;
  rateAllPlayers();
  updateEligibilityNote();
  render(true);
});

wireDataBar(init, (err) => showBanner(`Couldn't retrieve latest stats (${err.message}).`));

/* ------------------------------ player detail modal ------------------------------ */

function closeModal() {
  el.modalRoot.hidden = true;
  document.body.style.overflow = '';
  el.modalContent.innerHTML = '';
}

el.modalClose.addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modalRoot.hidden) closeModal();
});

function openPlayerModal(player) {
  el.modalRoot.hidden = false;
  document.body.style.overflow = 'hidden';
  el.modalContent.innerHTML = '<div class="modal-spinner">Loading…</div>';

  getJSON(`${API_WEB}/v1/player/${player.playerId}/landing`)
    .then((landing) => {
      renderModalShell(player, landing);
      renderSnapshotTrend(player);
      wireStatsWindow(player);
      wireModalGameLog(player, landing);
    })
    .catch((err) => {
      el.modalContent.innerHTML = `<div class="modal-spinner">Couldn't load player details (${escapeHtml(err.message)}).</div>`;
    });
}

function buildBioSection(player, landing) {
  if (!landing) {
    return `<div class="ph-bio"><div class="ph-bio-item"><span class="value">Bio unavailable right now.</span></div></div>`;
  }
  const age = ageFromBirthDate(landing.birthDate);
  const height = formatHeight(landing.heightInInches);
  const weight = landing.weightInPounds ? `${landing.weightInPounds} lb` : '—';
  const teamName = landing.fullTeamName?.default || state.teamMeta.get(player.team)?.name || player.team;
  const birthplace = [landing.birthCity?.default, landing.birthStateProvince?.default, landing.birthCountry]
    .filter(Boolean).join(', ');
  const draft = landing.draftDetails
    ? `${landing.draftDetails.year} · Rd ${landing.draftDetails.round}, Pick ${landing.draftDetails.overallPick}`
    : 'Undrafted';
  const shootsLabel = player.pos === 'G' ? 'Catches' : 'Shoots';

  return `
    <div class="ph-bio">
      <div class="ph-bio-item"><span class="label">Age</span><span class="value">${age ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Height</span><span class="value">${height}</span></div>
      <div class="ph-bio-item"><span class="label">Weight</span><span class="value">${weight}</span></div>
      <div class="ph-bio-item"><span class="label">Team</span><span class="value">${escapeHtml(teamName)}</span></div>
      <div class="ph-bio-item"><span class="label">Draft</span><span class="value">${escapeHtml(draft)}</span></div>
      <div class="ph-bio-item"><span class="label">${shootsLabel}</span><span class="value">${landing.shootsCatches ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Birthplace</span><span class="value">${escapeHtml(birthplace) || '—'}</span></div>
    </div>
  `;
}

function renderModalShell(player, landing) {
  el.modalContent.innerHTML = `
    <div class="pcard-modal-body">
      <div class="pcard-modal-left">
        ${buildCard(player, state.teamMeta).outerHTML}
        ${buildBioSection(player, landing)}
      </div>
      <div class="pcard-modal-right">
        <div class="pcard-section">
          <h3 id="modalPlayerName">${escapeHtml(player.name)} — Rating Trend</h3>
          <div id="trendWrap"><div class="trend-empty">Start of season.</div></div>
        </div>
        <div class="pcard-section">
          <div class="gamelog-head">
            <h3>Stats</h3>
            <div class="gamelog-controls">
              <select id="statsWindowSelect">${statsWindowOptionsHtml()}</select>
            </div>
          </div>
          <div id="seasonTotalsWrap"><div class="gamelog-loading">Loading…</div></div>
        </div>
        <div class="pcard-section">
          <div class="gamelog-head">
            <h3>Game Log</h3>
            <div class="gamelog-controls">
              <select id="gameLogSeason" aria-label="Season"></select>
              <button type="button" id="gtRegular" class="active">Regular</button>
              <button type="button" id="gtPlayoffs">Playoffs</button>
            </div>
          </div>
          <div id="gameLogWrap"><div class="gamelog-loading">Loading…</div></div>
        </div>
      </div>
    </div>
  `;
}

/** Wires the standalone "Stats" window selector (6 options — same as the
 *  compare modal's) that drives #seasonTotalsWrap, independent of the
 *  Game Log section's own season/type selector below it. */
function wireStatsWindow(player) {
  const select = document.getElementById('statsWindowSelect');
  if (!select) return;
  select.value = 'currentTotal';
  const load = () => renderPlayerStatsWindow(player, select.value);
  select.addEventListener('change', load);
  load();
}

async function renderPlayerStatsWindow(player, viewKey) {
  const wrap = document.getElementById('seasonTotalsWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';

  const win = await statsWindowFor(player, viewKey);
  if (!win) {
    wrap.innerHTML = '<div class="gamelog-empty">Not enough data for this view.</div>';
    return;
  }

  const isGoalie = player.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters');
  wrap.innerHTML = `
    <div class="ph-stats">
      ${categories.map((c) => `
        <div class="stat-chip" title="${escapeHtml(c.label)}">
          <span class="num">${escapeHtml(formatWindowValue(c, win))}</span>
          <span class="lbl">${escapeHtml(c.short)}</span>
        </div>`).join('')}
    </div>
  `;
}

function wireModalGameLog(player, landing) {
  const seasons = Array.from(new Set(
    (landing?.seasonTotals || [])
      .filter((s) => s.leagueAbbrev === 'NHL')
      .map((s) => s.season),
  )).sort((a, b) => b - a);
  if (seasons.length === 0) seasons.push(state.seasonId);

  const seasonSelect = document.getElementById('gameLogSeason');
  seasonSelect.innerHTML = seasons.map((s) => `<option value="${s}">${seasonLabel(s)}</option>`).join('');

  const btnReg = document.getElementById('gtRegular');
  const btnPo = document.getElementById('gtPlayoffs');
  let gameType = 2;

  const load = () => loadGameLog(player, seasonSelect.value, gameType);

  seasonSelect.addEventListener('change', load);
  btnReg.addEventListener('click', () => {
    gameType = 2;
    btnReg.classList.add('active');
    btnPo.classList.remove('active');
    load();
  });
  btnPo.addEventListener('click', () => {
    gameType = 3;
    btnPo.classList.add('active');
    btnReg.classList.remove('active');
    load();
  });

  load();
}

// Maps our SKATER_COLUMNS ids to the field names the landing endpoint's
// seasonTotals entries actually use (different naming from the stats-rest
// summary endpoint data.js pulls from). Hits/blocks/giveaways/takeaways
// aren't in seasonTotals at all (realtime-only stats) — shown as "—".
const SEASON_TOTAL_FIELD_MAP = {
  goals: 'goals', assists: 'assists', points: 'points', plusMinus: 'plusMinus',
  ppGoals: 'powerPlayGoals', ppPoints: 'powerPlayPoints', shGoals: 'shorthandedGoals',
  shPoints: 'shorthandedPoints', gameWinningGoals: 'gameWinningGoals', otGoals: 'otGoals',
  pim: 'pim', sog: 'shots', shootingPct: 'shootingPctg', faceoffPct: 'faceoffWinningPctg',
  gamesPlayed: 'gamesPlayed',
};

/** One category's value from a landing seasonTotals entry. Goalies get a
 *  small direct mapping (field names differ enough from our catalog ids
 *  to be clearer spelled out); skaters go through SEASON_TOTAL_FIELD_MAP.
 *  Returns null for anything not present in this endpoint at all. */
function seasonTotalValue(totals, catId, isGoalie) {
  if (isGoalie) {
    switch (catId) {
      case 'wins': return totals.wins ?? 0;
      case 'losses': return totals.losses ?? 0;
      case 'otLosses': return totals.otLosses ?? 0;
      case 'gaa': return totals.goalsAgainstAvg ?? null;
      case 'savePct': return totals.savePctg ?? null;
      case 'saves':
        return typeof totals.shotsAgainst === 'number' && typeof totals.goalsAgainst === 'number'
          ? totals.shotsAgainst - totals.goalsAgainst : null;
      case 'shutouts': return totals.shutouts ?? 0;
      case 'gamesPlayed': return totals.gamesPlayed ?? 0;
      case 'gamesStarted': return totals.gamesStarted ?? 0;
      case 'goalsAgainst': return totals.goalsAgainst ?? 0;
      case 'shotsAgainst': return totals.shotsAgainst ?? 0;
      default: return null;
    }
  }
  const key = SEASON_TOTAL_FIELD_MAP[catId];
  return key ? (totals[key] ?? null) : null;
}

async function loadGameLog(player, season, gameType) {
  const gameLogWrap = document.getElementById('gameLogWrap');
  if (!gameLogWrap) return;
  gameLogWrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';

  const isGoalie = player.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters');

  try {
    const logData = await getJSON(`${API_WEB}/v1/player/${player.playerId}/game-log/${season}/${gameType}`);
    const games = logData.gameLog || [];

    if (games.length === 0) {
      const label = gameType === 3 ? 'playoff' : 'regular season';
      gameLogWrap.innerHTML = `<div class="gamelog-empty">No ${label} games found for ${seasonLabel(season)}.</div>`;
      return;
    }

    if (!isGoalie) {
      const needsRealtime = categories.some((c) => REALTIME_FIELD_MAP[c.id]);
      if (needsRealtime) {
        const orExpr = games.map((g) => `gameId=${g.gameId}`).join(' or ');
        const filter = `(${orExpr}) and playerId=${player.playerId}`;
        try {
          const rt = await getJSON(`${API_STATS}/en/skater/realtime?isGame=true&cayenneExp=${encodeURIComponent(filter)}`);
          const byGame = new Map((rt.data || []).map((r) => [r.gameId, r]));
          for (const g of games) g._realtime = byGame.get(g.gameId) || {};
        } catch {
          // Non-fatal — those columns just show "—" for this player.
        }
      }
    }

    gameLogWrap.innerHTML = buildGameLogTable(games, categories, isGoalie);
  } catch (err) {
    gameLogWrap.innerHTML = `<div class="gamelog-empty">Couldn't load game log (${escapeHtml(err.message)}).</div>`;
  }
}

/** A single game's value for `catId` — the shared building block for both
 *  the game-log table and the monthly trend aggregation. Returns null if
 *  that stat isn't resolvable per game (shootingPct, faceoffPct). */
function perGameValue(g, catId, isGoalie) {
  if (isGoalie) {
    switch (catId) {
      case 'wins': return g.decision === 'W' ? 1 : 0;
      case 'losses': return g.decision === 'L' ? 1 : 0;
      case 'otLosses': return g.decision === 'O' ? 1 : 0;
      case 'shutouts': return g.shutouts ?? 0;
      case 'gamesStarted': return g.gamesStarted ?? 0;
      case 'gamesPlayed': return 1;
      case 'goalsAgainst': return g.goalsAgainst ?? 0;
      case 'shotsAgainst': return g.shotsAgainst ?? 0;
      case 'saves': return Math.max(0, (g.shotsAgainst ?? 0) - (g.goalsAgainst ?? 0));
      case 'gaa': {
        const minutes = parseToiMinutes(g.toi);
        return minutes > 0 && typeof g.goalsAgainst === 'number' ? (g.goalsAgainst / minutes) * 60 : null;
      }
      case 'savePct': return typeof g.savePctg === 'number' ? g.savePctg : null;
      default: return null;
    }
  }
  if (REALTIME_FIELD_MAP[catId]) return g._realtime?.[REALTIME_FIELD_MAP[catId]] ?? null;
  if (GAMELOG_FIELD_MAP[catId]) return g[GAMELOG_FIELD_MAP[catId]] ?? null;
  return null;
}

function parseToiMinutes(toi) {
  if (!toi || typeof toi !== 'string') return 0;
  const [m, s] = toi.split(':').map(Number);
  return (m || 0) + (s || 0) / 60;
}

function buildGameLogTable(games, categories, isGoalie) {
  const DECISION_COL = { wins: 'W', losses: 'L', otLosses: 'O' };
  const head = `<tr><th>Date</th><th>Opp</th>${categories.map((c) => `<th title="${escapeHtml(c.label)}">${escapeHtml(c.short)}</th>`).join('')}</tr>`;

  const rows = games.map((g) => {
    const opp = (g.homeRoadFlag === 'H' ? 'vs ' : '@ ') + (g.opponentAbbrev ?? '');
    const cells = categories.map((c) => {
      if (isGoalie && DECISION_COL[c.id]) {
        const isThis = g.decision === DECISION_COL[c.id];
        const cls = isThis ? (c.id === 'wins' ? 'result-w' : c.id === 'losses' ? 'result-l' : 'result-o') : '';
        const label = c.id === 'otLosses' ? 'OT' : DECISION_COL[c.id];
        return `<td class="${cls}">${isThis ? label : '–'}</td>`;
      }
      const raw = perGameValue(g, c.id, isGoalie);
      const display = raw == null ? '—' : escapeHtml(formatColumnValue(c, raw));
      return `<td>${display}</td>`;
    }).join('');
    return `<tr><td>${formatDate(g.gameDate)}</td><td>${escapeHtml(opp)}</td>${cells}</tr>`;
  }).join('');

  return `<div class="gamelog-table-wrap"><table class="gamelog-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/** Builds the rating-trend chart's data points from saved weekly
 *  snapshots (see snapshots.js), NOT from the game log — this is a trend
 *  of "what would this player's overall rating have been at each
 *  snapshot", not a per-game breakdown. Each snapshot is re-rated
 *  independently against its OWN eligibility pool (same MIN_GP_FRACTION
 *  rule as the live pool) so the comparison is always fair for that
 *  point in time. Only snapshots from the CURRENT season are included, so
 *  this naturally resets once the 2026-27 season's snapshots replace
 *  today's — no manual season rollover needed here. A final "Live" point
 *  is appended from the already-rated in-memory pool (no recomputation). */
function buildSnapshotTrendPoints(player) {
  const isGoalie = player.pos === 'G';
  const mode = isGoalie ? 'goalies' : 'skaters';
  const points = [];

  const chronological = listSnapshots().slice().reverse(); // listSnapshots() is newest-first
  for (const snap of chronological) {
    const full = getSnapshotByKey(snap.key);
    if (!full || full.data.seasonId !== state.seasonId) continue;

    const rawPool = isGoalie ? full.data.goalies : full.data.skaters;
    const maxGP = seasonGameCount(rawPool);
    const minGP = Math.ceil(maxGP * MIN_GP_FRACTION);
    const eligible = rawPool.filter((p) => p.gamesPlayed >= minGP);

    const rated = ratePool(eligible, mode);
    const found = rated.find((p) => p.playerId === player.playerId);
    if (found) points.push({ label: snap.label, value: found.overall });
  }

  const livePool = isGoalie ? state.ratedGoalies : state.ratedSkaters;
  const live = livePool.find((p) => p.playerId === player.playerId);
  if (live) points.push({ label: 'Live', value: live.overall });

  return points;
}

/** Renders the Rating Trend section into #trendWrap. Computed once, up
 *  front, from snapshot history — unlike the game log below it, this
 *  doesn't refetch when the season/type selector changes. */
function renderSnapshotTrend(player) {
  const trendWrap = document.getElementById('trendWrap');
  if (!trendWrap) return;

  const points = buildSnapshotTrendPoints(player);
  if (points.length < 2) {
    trendWrap.innerHTML = '<div class="trend-empty">Start of season — retrieve stats weekly once the season begins to build a trend here.</div>';
    return;
  }
  trendWrap.innerHTML = `<div class="trend-chart-wrap">${buildTrendSvg(points)}</div>`;
}

function buildTrendSvg(points) {
  const w = 600, h = 170, padL = 26, padR = 14, padT = 20, padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const values = points.map((p) => p.value);
  const minV = Math.min(...values, RATING_FLOOR);
  const maxV = Math.max(...values, RATING_FLOOR + 5);
  const span = Math.max(1, maxV - minV);
  const xFor = (i) => (points.length === 1 ? padL + innerW / 2 : padL + (i / (points.length - 1)) * innerW);
  const yFor = (v) => padT + innerH - ((v - minV) / span) * innerH;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${xFor(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const marks = points.map((p, i) => `
    <circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.value).toFixed(1)}" r="3.5" fill="var(--accent)" stroke="#0b0f14" stroke-width="1"></circle>
    <text x="${xFor(i).toFixed(1)}" y="${(yFor(p.value) - 9).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${p.value}</text>
    <text x="${xFor(i).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--text-faint)">${escapeHtml(p.label)}</text>
  `).join('');

  return `
    <svg class="trend-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Rating trend">
      <path d="${areaD}" fill="var(--accent)" opacity="0.12"></path>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2"></path>
      ${marks}
    </svg>
  `;
}

init();
