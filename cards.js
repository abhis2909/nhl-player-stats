'use strict';

/* ======================================================================
   Player cards: percentile-based fantasy ratings for every qualified
   skater. Uses the same season data as the stats page (data.js) AND the
   same stat-column selection as the admin page (columns.js) — whichever
   skater columns are enabled in ⚙ Columns are exactly the categories
   shown here, so changing that selection changes the cards too (see the
   `storage` listener at the bottom for the same-tab-open-elsewhere case).

   Rating methodology:
   - Eligibility pool = skaters with gamesPlayed >= MIN_GP_FRACTION of the
     season's game count (itself derived from the data, not hardcoded —
     see seasonGameCount() in data.js — so this keeps working once
     2026-27 stats replace these). Only eligible skaters get a card.
   - Each category's rating = that player's percentile rank for the
     mapped stat, within the eligibility pool, rescaled to
     RATING_FLOOR-RATING_CEIL. (Giveaways is inverted — fewer is better.)
   - Overall (the circular badge): each player's position-weighted
     composite percentile is re-percentiled across the pool (so it uses
     the full 0-100 range instead of clustering around the middle the
     way an average-of-percentiles does), then run through the inverse
     normal CDF and rescaled to a mean/stddev — i.e. a genuine bell
     curve, not a flat 55-99 spread: most players land near
     OVERALL_MEAN, fewer out toward the tails. See toOverallRating().
   ====================================================================== */

const MIN_GP_FRACTION = 0.3;
const RATING_FLOOR = 25;   // per-category ratings (uniform 0-100 -> floor..ceil)
const RATING_CEIL = 99;
const OVERALL_MEAN = 75;   // overall badge (normal distribution around this...
const OVERALL_STDDEV = 8;  // ...with this spread)
const OVERALL_MIN = 40;
const OVERALL_MAX = 99;
const BATCH_SIZE = 48;

// Stats where a LOWER raw value is the better outcome (percentile gets
// inverted before rating). Everything else: higher = better.
const INVERT_STATS = new Set(['giveaways']);

// How much each stat counts toward a player's OVERALL badge, by position
// group (L and R share the winger profile). Individual category ratings
// are always plain percentiles — this only changes how they blend into
// one number. Covers every stat in columns.js's SKATER_COLUMNS catalog;
// anything selected there that's missing here just falls back to weight 1.
const POSITION_WEIGHTS = {
  // Centers: two-way, playmaking, faceoffs, works both special-teams units.
  C: {
    goals: 1.1, assists: 1.4, points: 1.3, plusMinus: 1.0, ppGoals: 1.1, ppPoints: 1.2,
    shGoals: 1.2, shPoints: 1.3, gameWinningGoals: 1.1, otGoals: 1.0, pim: 0.7, sog: 1.0,
    shootingPct: 0.9, gamesPlayed: 0.8, hits: 0.7, blocks: 0.9, giveaways: 1.0, takeaways: 1.1,
    faceoffPct: 1.5,
  },
  // Wingers (L/R combined): finishers, PP flank shooters, board play.
  W: {
    goals: 1.4, assists: 1.0, points: 1.2, plusMinus: 1.0, ppGoals: 1.3, ppPoints: 1.3,
    shGoals: 0.7, shPoints: 0.6, gameWinningGoals: 1.2, otGoals: 1.1, pim: 0.9, sog: 1.3,
    shootingPct: 1.1, gamesPlayed: 0.8, hits: 1.1, blocks: 0.6, giveaways: 0.9, takeaways: 0.8,
    faceoffPct: 0.3,
  },
  // Defensemen: shot-blocking, physicality, PK staple, point-shot/assists over goals.
  D: {
    goals: 0.6, assists: 1.1, points: 1.0, plusMinus: 1.1, ppGoals: 0.7, ppPoints: 1.1,
    shGoals: 1.0, shPoints: 1.3, gameWinningGoals: 0.7, otGoals: 0.6, pim: 1.0, sog: 0.7,
    shootingPct: 0.6, gamesPlayed: 0.9, hits: 1.3, blocks: 1.8, giveaways: 1.3, takeaways: 1.3,
    faceoffPct: 0.2,
  },
};

/** Maps a raw position code (C/L/R/D) to a POSITION_WEIGHTS group. */
function positionGroup(pos) {
  if (pos === 'D') return 'D';
  if (pos === 'C') return 'C';
  return 'W'; // L, R
}

const POSITION_GROUP_LABEL = { C: 'center', W: 'winger', D: 'defenseman' };

/** Catalog entries (from columns.js) for whichever skater stats are currently
 *  enabled on the admin page — read fresh each call so this always reflects
 *  the latest saved selection, not a stale snapshot. */
function activeColumns(mode) {
  const config = loadColumnConfig();
  const selected = new Set(config[mode] || []);
  return columnCatalog(mode).filter((c) => selected.has(c.id));
}

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
  posButtons: Array.from(document.querySelectorAll('.toggle-btn[data-pos]')),
  modalRoot: document.getElementById('modalRoot'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalContent: document.getElementById('modalContent'),
};

const state = {
  teamMeta: new Map(),
  seasonId: null,
  rawSkaters: [],   // eligible skaters, unrated (re-rated whenever the column config changes)
  players: [],      // rawSkaters + .ratings + .overall for the CURRENT column config
  search: '',
  team: 'ALL',
  pos: 'ALL',
  visibleCount: BATCH_SIZE,
};

const GAMES_TO_SHOW = 5;

// Per-game data sources for the "Last N Games" panel. Regular-season box
// score fields (goals, assists, PPP, etc.) come straight from the game-log
// endpoint. Hits/blocks/giveaways/takeaways aren't in that response at all
// — they come from a second, batched query to the stats-rest API's
// per-game realtime report (isGame=true). Anything not listed in either
// map (shootingPct, faceoffPct, gamesPlayed) isn't meaningfully available
// per game, so it shows as "—".
const GAMELOG_FIELD_MAP = {
  goals: 'goals', assists: 'assists', points: 'points', plusMinus: 'plusMinus',
  ppGoals: 'powerPlayGoals', ppPoints: 'powerPlayPoints', shGoals: 'shorthandedGoals',
  shPoints: 'shorthandedPoints', gameWinningGoals: 'gameWinningGoals', otGoals: 'otGoals',
  pim: 'pim', sog: 'shots',
};
const REALTIME_FIELD_MAP = { hits: 'hits', blocks: 'blockedShots', giveaways: 'giveaways', takeaways: 'takeaways' };

/** Percentile rank (0-100) of `value` within `pool` — 0 = lowest, 100 = highest. */
function percentileRank(value, pool) {
  const n = pool.length;
  if (n <= 1) return 100;
  let below = 0;
  for (const v of pool) if (v < value) below += 1;
  return (below / (n - 1)) * 100;
}

function toCardRating(percentile) {
  const raw = RATING_FLOOR + (percentile / 100) * (RATING_CEIL - RATING_FLOOR);
  return Math.max(RATING_FLOOR, Math.min(RATING_CEIL, Math.round(raw)));
}

/**
 * Inverse standard normal CDF (probit function) — Peter Acklam's rational
 * approximation, ~1.15e-9 relative error. Converts a uniform(0,1) input
 * into a standard-normal z-score; used to turn a percentile into a
 * bell-curve rating instead of a flat linear one.
 */
function inverseNormalCDF(p) {
  const pc = Math.min(Math.max(p, 1e-9), 1 - 1e-9); // keep finite at the extremes
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (pc < pLow) {
    const q = Math.sqrt(-2 * Math.log(pc));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pc <= pHigh) {
    const q = pc - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - pc));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Percentile (0-100) -> a normally-distributed overall rating around OVERALL_MEAN. */
function toOverallRating(percentile) {
  const z = inverseNormalCDF(percentile / 100);
  const raw = OVERALL_MEAN + z * OVERALL_STDDEV;
  return Math.max(OVERALL_MIN, Math.min(OVERALL_MAX, Math.round(raw)));
}

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

/** Recomputes ratings + overall for every skater, using whichever columns are
 *  currently enabled on the admin page. Cheap (~tens of ms for ~700 players),
 *  safe to call whenever the column config might have changed. */
function rateAllPlayers() {
  const categories = activeColumns('skaters'); // from columns.js: catalog entries filtered to the saved selection
  const pool = state.rawSkaters;

  const statPools = {};
  for (const cat of categories) statPools[cat.id] = pool.map((p) => p[cat.id] ?? 0);

  // Stage 1: per-category percentile (also this player's individually-displayed rating)
  // and this player's position-weighted composite percentile.
  const withComposite = pool.map((player) => {
    const ratings = categories.map((cat) => {
      const value = player[cat.id] ?? 0;
      let pct = percentileRank(value, statPools[cat.id]);
      if (INVERT_STATS.has(cat.id)) pct = 100 - pct;
      return { id: cat.id, short: cat.short, label: cat.label, fmt: cat.fmt, value, rating: toCardRating(pct), pct };
    });
    const weights = POSITION_WEIGHTS[positionGroup(player.pos)];
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of ratings) {
      const w = weights[r.id] ?? 1;
      weightedSum += r.pct * w;
      weightTotal += w;
    }
    return { player, ratings, compositePct: weightTotal ? weightedSum / weightTotal : 50 };
  });

  // Stage 2: re-percentile the composite score, then map through the
  // normal-distribution curve for the final overall.
  const compositePool = withComposite.map((w) => w.compositePct);
  state.players = withComposite.map(({ player, ratings, compositePct }) => ({
    ...player,
    ratings,
    overall: toOverallRating(percentileRank(compositePct, compositePool)),
  }));
}

async function init() {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.grid.innerHTML = '';

  try {
    const { seasonId, teamMeta, skaters, source, snapshotLabel } = await getSeasonData();
    state.teamMeta = teamMeta;
    state.seasonId = seasonId;
    el.seasonLabel.textContent = `${seasonLabel(seasonId)} · Ratings` +
      (source === 'snapshot' ? ` · ${snapshotLabel}` : '');

    const maxGP = seasonGameCount(skaters);
    const minGP = Math.ceil(maxGP * MIN_GP_FRACTION);
    state.rawSkaters = skaters.filter((p) => p.gamesPlayed >= minGP);

    el.eligibilityNote.textContent =
      `Showing the ${state.rawSkaters.length.toLocaleString()} skaters who've played at least ${minGP} games ` +
      `this season (30% of ${maxGP}). Categories match your ⚙ Columns selection for skaters — change it there ` +
      `and these update too. Category ratings are percentile ranks scaled to ${RATING_FLOOR}–${RATING_CEIL}; ` +
      `the overall badge is normally distributed around ${OVERALL_MEAN}.`;

    rateAllPlayers();
    populateTeamSelect();
    el.skeleton.hidden = true;
    render(true);
  } catch (err) {
    el.skeleton.hidden = true;
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  }
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
  return state.players
    .filter((p) => {
      if (state.team !== 'ALL' && p.team !== state.team) return false;
      if (state.pos !== 'ALL' && positionGroup(p.pos) !== state.pos) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.overall - a.overall);
}

/** @param reset - true when a filter (or the column config) changed; false for "load more". */
function render(reset) {
  if (reset) state.visibleCount = BATCH_SIZE;
  const filtered = getFiltered();
  const slice = filtered.slice(0, state.visibleCount);

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  slice.forEach((p) => frag.appendChild(buildCard(p)));
  el.grid.appendChild(frag);

  el.resultCount.textContent = `Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} skaters`;
  el.loadMoreWrap.hidden = slice.length >= filtered.length;
}

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
  render(true);
});

wireDataBar(init, (err) => showBanner(`Couldn't retrieve latest stats (${err.message}).`));

function buildCard(player) {
  const colors = teamColor(player.team);
  const headshot = `https://assets.nhle.com/mugs/nhl/latest/${player.playerId}.png`;
  const meta = state.teamMeta.get(player.team);
  const teamName = meta?.name || player.team;

  const card = document.createElement('div');
  card.className = 'player-card';
  card.style.setProperty('--card-primary', colors.primary);
  card.style.setProperty('--card-secondary', colors.secondary);

  card.innerHTML = `
    <div class="card-top">
      <div class="card-badge">
        <span class="card-overall" title="Overall, weighted for ${POSITION_GROUP_LABEL[positionGroup(player.pos)]}s">${player.overall}</span>
        <span class="card-pos">${escapeHtml(player.pos)}</span>
      </div>
      <div class="card-team-pill">
        ${meta?.logo ? `<img src="${meta.logo}" alt="" loading="lazy">` : ''}
        <span>${escapeHtml(player.team)}</span>
      </div>
    </div>
    <div class="card-photo-wrap">
      <img class="card-photo" src="${headshot}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    </div>
    <div class="card-identity">
      <div class="card-name">${escapeHtml(player.name)}</div>
      <div class="card-subtitle">${escapeHtml(teamName)}</div>
    </div>
    <div class="card-stats-grid">
      ${player.ratings.map((r) => `
        <div class="card-stat" title="${escapeHtml(r.label)}: ${escapeHtml(formatColumnValue(r, r.value))}">
          <span class="card-stat-num">${r.rating}</span>
          <span class="card-stat-lbl">${escapeHtml(r.short)}</span>
        </div>
      `).join('')}
    </div>
  `;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.addEventListener('click', () => openPlayerModal(player));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlayerModal(player); }
  });
  return card;
}

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

  Promise.all([
    getJSON(`${API_WEB}/v1/player/${player.playerId}/landing`).catch(() => null),
    fetchLastGames(player),
  ])
    .then(([landing, games]) => renderPlayerModal(player, landing, games))
    .catch((err) => {
      el.modalContent.innerHTML = `<div class="modal-spinner">Couldn't load player details (${escapeHtml(err.message)}).</div>`;
    });
}

/** Last GAMES_TO_SHOW regular-season games, box score fields from the
 *  game-log endpoint plus a batched per-game realtime query (hits/blocks/
 *  giveaways/takeaways) if any active category needs those. */
async function fetchLastGames(player) {
  const logData = await getJSON(`${API_WEB}/v1/player/${player.playerId}/game-log/${state.seasonId}/2`);
  const games = (logData.gameLog || []).slice(0, GAMES_TO_SHOW);
  if (games.length === 0) return games;

  const categories = activeColumns('skaters');
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
  return games;
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

  return `
    <div class="ph-bio">
      <div class="ph-bio-item"><span class="label">Age</span><span class="value">${age ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Height</span><span class="value">${height}</span></div>
      <div class="ph-bio-item"><span class="label">Weight</span><span class="value">${weight}</span></div>
      <div class="ph-bio-item"><span class="label">Team</span><span class="value">${escapeHtml(teamName)}</span></div>
      <div class="ph-bio-item"><span class="label">Draft</span><span class="value">${escapeHtml(draft)}</span></div>
      <div class="ph-bio-item"><span class="label">Shoots</span><span class="value">${landing.shootsCatches ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Birthplace</span><span class="value">${escapeHtml(birthplace) || '—'}</span></div>
    </div>
  `;
}

function buildLastGamesTable(games) {
  if (!games || games.length === 0) {
    return '<div class="gamelog-empty">No regular-season games found yet.</div>';
  }
  const categories = activeColumns('skaters');
  const head = `<tr><th>Date</th><th>Opp</th>${categories.map((c) => `<th title="${escapeHtml(c.label)}">${escapeHtml(c.short)}</th>`).join('')}</tr>`;

  const rows = games.map((g) => {
    const opp = (g.homeRoadFlag === 'H' ? 'vs ' : '@ ') + (g.opponentAbbrev ?? '');
    const cells = categories.map((c) => {
      let raw;
      if (REALTIME_FIELD_MAP[c.id]) raw = g._realtime?.[REALTIME_FIELD_MAP[c.id]];
      else if (GAMELOG_FIELD_MAP[c.id]) raw = g[GAMELOG_FIELD_MAP[c.id]];
      const display = raw == null ? '—' : escapeHtml(formatColumnValue(c, raw));
      return `<td>${display}</td>`;
    }).join('');
    return `<tr><td>${formatDate(g.gameDate)}</td><td>${escapeHtml(opp)}</td>${cells}</tr>`;
  }).join('');

  return `<div class="gamelog-table-wrap"><table class="gamelog-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function renderPlayerModal(player, landing, games) {
  el.modalContent.innerHTML = `
    <div class="pcard-modal-body">
      <div class="pcard-modal-left">
        ${buildCard(player).outerHTML}
        ${buildBioSection(player, landing)}
      </div>
      <div class="pcard-modal-right">
        <h3 id="modalPlayerName">${escapeHtml(player.name)} — Last ${games.length || GAMES_TO_SHOW} Games</h3>
        ${buildLastGamesTable(games)}
      </div>
    </div>
  `;
}

init();
