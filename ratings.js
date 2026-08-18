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
   - Each category's rating = a player's percentile rank for that stat's
     RAW TOTAL, WITHIN THEIR OWN POSITION GROUP (C / W / D; goalies are
     their own single group), rescaled to RATING_FLOOR..CEIL. Raw totals
     (not per-game) so accumulated season production is what's being
     compared — see 2026-08-16 history below if this ever needs
     revisiting: a per-game basis was tried and explicitly reverted.
   - Overall = weighted average of category percentiles (position-
     weighted for skaters, single-profile for goalies), same rescale.
   - Every rating gets a flat +4% premium (RATING_PREMIUM), capped.
   - Overall maps to one of six gem tiers (tierFor()).
   ====================================================================== */

// Must have played at least this many games (flat counts, not scaled to
// the season length or either group's own max games played) to be
// rated — separate bars since goalies play far fewer games than
// skaters over a season.
const MIN_GAMES_PLAYED_SKATERS = 20;
const MIN_GAMES_PLAYED_GOALIES = 15;
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
  // Defensemen: shot-blocking, physicality, PK staple, point-shot/assists over
  // goals. hits/blocks weighted up a bit further (2026-08-16, user feedback)
  // to lean more into the defensive/physical side of the position.
  D: {
    goals: 0.6, assists: 1.1, points: 1.0, plusMinus: 1.1, ppGoals: 0.7, ppPoints: 1.1,
    shGoals: 1.0, shPoints: 1.3, gameWinningGoals: 0.7, otGoals: 0.6, pim: 1.0, sog: 0.7,
    shootingPct: 0.6, gamesPlayed: 0.9, hits: 1.5, blocks: 2.1, giveaways: 1.3, takeaways: 1.3,
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
function tierFor(overall, cfg) {
  const t = cfg?.tierThresholds || { diamond: 92, amethyst: 87, ruby: 82, emerald: 77, gold: 70 };
  if (overall >= t.diamond) return 'diamond';
  if (overall >= t.amethyst) return 'amethyst';
  if (overall >= t.ruby) return 'ruby';
  if (overall >= t.emerald) return 'emerald';
  if (overall >= t.gold) return 'gold';
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

/** `cfg` is an optional admin-tuned RatingSettings override (see
 *  public-config.js's `ratingSettings`, fetched and threaded through by
 *  callers that want it — cards.js/range.js/totw.js/app.js). Omitted or
 *  partial `cfg` falls back to this module's own hardcoded defaults
 *  field by field, so every EXISTING call site with no cfg at all keeps
 *  behaving exactly as before this existed. */
function toCardRating(percentile, cfg) {
  const floor = cfg?.ratingFloor ?? RATING_FLOOR;
  const ceil = cfg?.ratingCeil ?? RATING_CEIL;
  const premium = cfg?.ratingPremium ?? RATING_PREMIUM;
  const raw = floor + (percentile / 100) * (ceil - floor);
  return Math.max(floor, Math.min(ceil, Math.round(raw * premium)));
}

/** Rates one pool (skaters or goalies) against itself, using whichever
 *  columns are currently enabled for that mode. Cheap (~tens of ms for
 *  ~700 players), safe to call whenever the column config might change.
 *  Works equally well on a season-to-date pool or a delta pool built from
 *  two snapshots (range.js) — it only ever compares players within the
 *  pool it's given.
 *
 *  Percentiles are LEAGUE-WIDE for skaters (2026-08-18, reverted back
 *  from the position-relative grouping tried on 2026-08-16 — see git
 *  history if that's ever worth reviving). Every skater's percentile
 *  for a stat is computed against the FULL skater pool, not just their
 *  own position group — a center, winger, and defenseman with the same
 *  raw total get the same percentile. `POSITION_WEIGHTS` still applies
 *  when blending category percentiles into the overall score (a
 *  separate step, further down) — only the percentile-ranking POOL
 *  itself is no longer position-scoped. Goalies remain their own
 *  separate group, as always (mixing them with skaters' stat pools
 *  wouldn't mean anything).
 *
 *  Percentiles are on each stat's RAW TOTAL (2026-08-16: a per-game
 *  version was tried, then reverted per direct follow-up feedback —
 *  keep the position-relative grouping above, but rank on accumulated
 *  season/window production, not rate). */
/** `cfg` (optional) — an admin-tuned RatingSettings override; see
 *  toCardRating()'s doc comment for the fallback contract. Only
 *  `cfg.positionWeights`/`cfg.goalieWeights` matter here directly;
 *  floor/ceil/premium/tiers are handled inside toCardRating()/tierFor(). */
function ratePool(pool, mode, cfg) {
  // Synthetic columns (currently just 'overall'/Power Ranking) are
  // computed BY this function, never an input to it — including one in
  // `categories` would rate every player on their own (always-absent,
  // so always-0) overall value, a meaningless self-referential category
  // that quietly skews the real result for everyone equally. Filter it
  // out regardless of whether it happens to be one of the active
  // display columns (it usually is, now that it's in the default set).
  //
  // gamesPlayed is excluded too, per direct request — it stays a normal
  // visible column on the Stats table/cards (activeColumns() elsewhere
  // is untouched), it's just never one of the percentile inputs that
  // feeds the rating/overall score, regardless of whether it's active.
  const categories = activeColumns(mode).filter((c) => !c.synthetic && c.id !== 'gamesPlayed');
  const isGoalie = mode === 'goalies';
  // League-wide for skaters (one shared 'SKATER' key regardless of
  // position) — goalies stay their own separate pool. This only
  // controls what the PERCENTILE is computed against; POSITION_WEIGHTS
  // below still blends categories into overall per-position.
  const groupKey = (player) => (isGoalie ? 'G' : 'SKATER');
  const positionWeights = cfg?.positionWeights || POSITION_WEIGHTS;
  const goalieWeights = cfg?.goalieWeights || GOALIE_WEIGHTS;

  const groups = new Map(); // groupKey -> players in that group
  for (const player of pool) {
    const key = groupKey(player);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(player);
  }

  const statPoolsByGroup = new Map();
  for (const [key, groupPlayers] of groups) {
    const statPools = {};
    for (const cat of categories) statPools[cat.id] = groupPlayers.map((p) => p[cat.id] ?? 0);
    statPoolsByGroup.set(key, statPools);
  }

  return pool.map((player) => {
    const statPools = statPoolsByGroup.get(groupKey(player));
    const ratings = categories.map((cat) => {
      const value = player[cat.id] ?? 0;
      let pct = percentileRank(value, statPools[cat.id]);
      if (INVERT_STATS.has(cat.id)) pct = 100 - pct;
      return { id: cat.id, short: cat.short, label: cat.label, fmt: cat.fmt, value, rating: toCardRating(pct, cfg), pct };
    });
    const weights = isGoalie ? goalieWeights : positionWeights[positionGroup(player.pos)];
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of ratings) {
      const w = weights[r.id] ?? 1;
      weightedSum += r.pct * w;
      weightTotal += w;
    }
    const compositePct = weightTotal ? weightedSum / weightTotal : 50;
    return { ...player, ratings, overall: toCardRating(compositePct, cfg) };
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
      if (cat.id === 'gamesPlayed' || cat.synthetic) continue; // synthetic (overall) isn't a real stat to delta — ratePool() computes it fresh
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
function buildCard(player, teamMeta, onOpen, cfg) {
  const isGoalie = player.pos === 'G';
  const tier = tierFor(player.overall, cfg);
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
              <span class="val">${player.overall ?? '—'}</span><span class="lbl">OVR</span>
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
