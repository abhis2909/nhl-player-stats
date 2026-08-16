'use strict';

/* ======================================================================
   Shared rating engine + card renderer, used by both the Player Cards
   page (cards.js, season-to-date ratings) and the Range Ratings page
   (range.js, ratings over a chosen from/to window). Keeping this in one
   file means both pages compute and render ratings identically — a
   player's card should look and feel the same whether it came from a
   full-season pool or a one-week delta pool.

   Rating methodology (recap — see cards.js's header comment for the
   full breakdown of the season-to-date pipeline that consumes this):
   - Each category's rating = a player's percentile rank for that stat
     WITHIN WHATEVER POOL IS PASSED IN, rescaled to RATING_FLOOR..CEIL.
   - Overall = weighted average of category percentiles (position-
     weighted for skaters, single-profile for goalies), same rescale.
   - Every rating gets a flat +4% premium (RATING_PREMIUM), capped.
   - Overall maps to one of six gem tiers (tierFor()).
   ====================================================================== */

const MIN_GP_FRACTION = 0.3;
const RATING_FLOOR = 25;
const RATING_CEIL = 99;
const RATING_PREMIUM = 1.04; // flat +4% applied to every rating (category and overall), capped at RATING_CEIL

// Stats where a LOWER raw value is the better outcome (percentile gets
// inverted before rating). Everything else: higher = better. Skater and
// goalie catalogs don't share ids, so one set covers both.
const INVERT_STATS = new Set(['giveaways', 'losses', 'otLosses', 'gaa', 'goalsAgainst']);

// How much each stat counts toward a skater's OVERALL badge, by position
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

// Single weight profile for goalies (no position sub-groups). Wins/GAA/
// Save% are the core "how good" indicators; shutouts a bonus; saves/GP/
// shots-against more workload than skill.
const GOALIE_WEIGHTS = {
  wins: 1.3, losses: 0.8, otLosses: 0.7, gaa: 1.4, savePct: 1.4,
  saves: 0.8, shutouts: 1.1, gamesPlayed: 0.6, gamesStarted: 0.7,
  goalsAgainst: 0.8, shotsAgainst: 0.5,
};

const POSITION_GROUP_LABEL = { C: 'center', W: 'winger', D: 'defenseman' };

/** Maps a raw position code (C/L/R/D) to a POSITION_WEIGHTS group. */
function positionGroup(pos) {
  if (pos === 'D') return 'D';
  if (pos === 'C') return 'C';
  return 'W'; // L, R
}

/** Overall rating -> card tier. Effect intensity (border shimmer speed,
 *  sheen strength, glow, pulse, sparkles, stat-tile shape) scales with
 *  tier via CSS in style.css (.tier-silver..diamond) — this function is
 *  the single source of truth for the thresholds. */
function tierFor(overall) {
  if (overall >= 92) return 'diamond';
  if (overall >= 87) return 'amethyst';
  if (overall >= 82) return 'ruby';
  if (overall >= 77) return 'emerald';
  if (overall >= 70) return 'gold';
  return 'silver';
}

/** Catalog entries (from columns.js) for whichever stats are currently
 *  enabled on the admin page for `mode` ('skaters' | 'goalies') — read
 *  fresh each call so this always reflects the latest saved selection. */
function activeColumns(mode) {
  const config = loadColumnConfig();
  const selected = new Set(config[mode] || []);
  return columnCatalog(mode).filter((c) => selected.has(c.id));
}

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
  return Math.max(RATING_FLOOR, Math.min(RATING_CEIL, Math.round(raw * RATING_PREMIUM)));
}

/** Rates one pool (skaters or goalies) against itself, using whichever
 *  columns are currently enabled for that mode. Cheap (~tens of ms for
 *  ~700 players), safe to call whenever the column config might change.
 *  Works equally well on a season-to-date pool or a delta pool built from
 *  two snapshots (range.js) — it only ever compares players within the
 *  pool it's given. */
function ratePool(pool, mode) {
  const categories = activeColumns(mode);
  const statPools = {};
  for (const cat of categories) statPools[cat.id] = pool.map((p) => p[cat.id] ?? 0);

  return pool.map((player) => {
    const ratings = categories.map((cat) => {
      const value = player[cat.id] ?? 0;
      let pct = percentileRank(value, statPools[cat.id]);
      if (INVERT_STATS.has(cat.id)) pct = 100 - pct;
      return { id: cat.id, short: cat.short, label: cat.label, fmt: cat.fmt, value, rating: toCardRating(pct), pct };
    });
    const weights = mode === 'goalies' ? GOALIE_WEIGHTS : POSITION_WEIGHTS[positionGroup(player.pos)];
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of ratings) {
      const w = weights[r.id] ?? 1;
      weightedSum += r.pct * w;
      weightTotal += w;
    }
    const compositePct = weightTotal ? weightedSum / weightTotal : 50;
    return { ...player, ratings, overall: toCardRating(compositePct) };
  });
}

// ---------------------------------------------------------------------
// Delta-window rating — same rating engine (ratePool above), fed a pool
// built from the DIFFERENCE between two season-data snapshots instead of
// season-to-date totals. Used by range.js (a chosen [from, to] window)
// and totw.js (a single calendar week's window, for Team of the Week).
// ---------------------------------------------------------------------

const MIN_RANGE_GP = 1; // must have played at least 1 game in the window to be ranked

const SKATER_COUNTING = new Set([
  'goals', 'assists', 'points', 'plusMinus', 'ppGoals', 'ppPoints', 'shGoals', 'shPoints',
  'gameWinningGoals', 'otGoals', 'pim', 'sog', 'gamesPlayed', 'hits', 'blocks', 'giveaways', 'takeaways',
]);
const GOALIE_COUNTING = new Set([
  'wins', 'losses', 'otLosses', 'saves', 'shutouts', 'gamesPlayed', 'gamesStarted', 'goalsAgainst', 'shotsAgainst',
]);

/** A single category's value over the [from, to] window for one player.
 *  Plain counting stats just subtract. shooting%/save%/GAA are true
 *  rates, so they're recomputed from their underlying counts (goals/SOG,
 *  goals-against/shots-against, goals-against/starts) rather than
 *  subtracted directly. faceoff% has no raw win/loss counts available at
 *  all in this data, so it falls back to the end-of-window season rate —
 *  a known approximation, same spirit as the rating-trend chart's. */
function deltaValue(catId, fromP, toP, isGoalie) {
  if (isGoalie) {
    if (GOALIE_COUNTING.has(catId)) return (toP[catId] ?? 0) - (fromP[catId] ?? 0);
    if (catId === 'savePct') {
      const gaD = (toP.goalsAgainst ?? 0) - (fromP.goalsAgainst ?? 0);
      const saD = (toP.shotsAgainst ?? 0) - (fromP.shotsAgainst ?? 0);
      return saD > 0 ? 1 - gaD / saD : (toP.savePct ?? 0);
    }
    if (catId === 'gaa') {
      const gaD = (toP.goalsAgainst ?? 0) - (fromP.goalsAgainst ?? 0);
      const gsD = (toP.gamesStarted ?? 0) - (fromP.gamesStarted ?? 0);
      return gsD > 0 ? gaD / gsD : (toP.gaa ?? 0);
    }
    return toP[catId] ?? 0;
  }
  if (SKATER_COUNTING.has(catId)) return (toP[catId] ?? 0) - (fromP[catId] ?? 0);
  if (catId === 'shootingPct') {
    const gD = (toP.goals ?? 0) - (fromP.goals ?? 0);
    const sD = (toP.sog ?? 0) - (fromP.sog ?? 0);
    return sD > 0 ? gD / sD : (toP.shootingPct ?? 0);
  }
  return toP[catId] ?? 0; // faceoffPct fallback — see comment above
}

/** Builds a pool of "delta players" for `mode` between two season-data
 *  snapshots. A player missing from `fromData` (call-up, trade-in,
 *  rookie debut) is treated as having zero stats at the start of the
 *  window — their whole season-to-date line counts as their "delta",
 *  which is exactly what you want if they weren't around yet. */
function buildDeltaPool(fromData, toData, mode) {
  const isGoalie = mode === 'goalies';
  const toList = isGoalie ? toData.goalies : toData.skaters;
  const fromList = isGoalie ? fromData.goalies : fromData.skaters;
  const fromMap = new Map(fromList.map((p) => [p.playerId, p]));
  const catalog = columnCatalog(mode);

  const out = [];
  for (const toP of toList) {
    const fromP = fromMap.get(toP.playerId) || {};
    const gpDelta = (toP.gamesPlayed ?? 0) - (fromP.gamesPlayed ?? 0);
    if (gpDelta < MIN_RANGE_GP) continue;

    const player = { playerId: toP.playerId, name: toP.name, pos: toP.pos, team: toP.team, gamesPlayed: gpDelta };
    for (const cat of catalog) {
      if (cat.id === 'gamesPlayed') continue;
      player[cat.id] = deltaValue(cat.id, fromP, toP, isGoalie);
    }
    out.push(player);
  }
  return out;
}

/** Builds one gem-tier card as a DOM node. `teamMeta` is the Map from
 *  data.js's buildTeamMeta() (for the logo). `onOpen(player)`, if given,
 *  is called on click/Enter/Space — pass a function that opens whatever
 *  detail view makes sense for the calling page. */
function buildCard(player, teamMeta, onOpen) {
  const isGoalie = player.pos === 'G';
  const tier = tierFor(player.overall);
  const headshot = `https://assets.nhle.com/mugs/nhl/latest/${player.playerId}.png`;
  const meta = teamMeta?.get(player.team);
  const [first, ...rest] = player.name.split(' ');
  const last = rest.join(' ') || player.name;
  const weightLabel = isGoalie ? 'goalies' : `${POSITION_GROUP_LABEL[positionGroup(player.pos)]}s`;

  const card = document.createElement('div');
  card.className = `player-card tier-${tier}`;

  card.innerHTML = `
    <div class="pc-inner">
      <div class="pc-tier-tag">${tier}</div>
      <span class="pc-sparkle" style="top:18%; left:14%; animation-delay:0s;"></span>
      <span class="pc-sparkle" style="top:34%; left:82%; animation-delay:0.9s;"></span>
      <span class="pc-sparkle" style="top:52%; left:20%; animation-delay:1.6s;"></span>
      <div class="pc-photo-wrap">
        <img src="${headshot}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="pc-photo-fade"></div>
        <div class="pc-top-row">
          <div>
            <div class="pc-ovr-badge" title="Overall, weighted for ${weightLabel}">
              <span class="val">${player.overall}</span><span class="lbl">OVR</span>
            </div>
            <div class="pc-pos-badge">${escapeHtml(player.pos)}</div>
          </div>
          <div class="pc-team-pill">
            ${meta?.logo ? `<img src="${meta.logo}" alt="" loading="lazy">` : ''}
            <span>${escapeHtml(player.team)}</span>
          </div>
        </div>
      </div>
      <div class="pc-info">
        <div class="pc-player-name">
          <span class="pc-first-name">${escapeHtml(first)}</span>
          <span class="pc-last-name">${escapeHtml(last)}</span>
        </div>
        <div class="pc-stats-grid">
          ${player.ratings.map((r) => `
            <div class="pc-stat" title="${escapeHtml(r.label)}: ${escapeHtml(formatColumnValue(r, r.value))}">
              <div class="pc-stat-shape"><span class="pc-stat-val">${r.rating}</span></div>
              <span class="pc-stat-lbl">${escapeHtml(r.short)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  if (onOpen) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => onOpen(player));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(player); }
    });
  }
  return card;
}
