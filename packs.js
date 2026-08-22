'use strict';

/* ======================================================================
   Player Jersey Packs — Mini-Games page 2 (Game 5 from fantasy-hub's
   design doc, "player packs", built here as a JERSEY collectible rather
   than a stat-card collectible — cards.html/ratings.js already own the
   player-rating-card idea).

   Rarity is a property of the PLAYER, not the pull: each JERSEY_ART
   entry is classified into a tier at upload time (Admin -> Jerseys'
   "Rarity class" select), and a pack pull picks a random player
   weighted by TIER_WEIGHTS applied to each player's own tier (see
   ALL_PLAYERS/pickWeightedBy/pullOne below) — so which specific player
   you get and which rarity you get are the same roll, not two
   independent ones. (Grade is still its own independent second roll on
   top of that — see GRADE_WEIGHTS.)

   PREVIEW BUILD: no backend yet. Nothing here touches CreditTransaction/
   Card/Pack/UserCard/PackOpening (see prisma/schema.prisma — those exist
   in the DB but are explicitly "unused in Phase 1"). Opening a pack is
   free and a user's collection is plain localStorage, per-browser, not
   synced to their Fantasy Hub account. Swapping in the real thing later
   means: an admin-configurable Pack row (cost/cardCount/oddsJson) instead
   of the hardcoded PACK/TIER_WEIGHTS below, a POST endpoint that debits
   CreditTransaction + writes PackOpening + UserCard server-side, and this
   file's pullOne()/openPack() becoming a thin client for that response
   instead of doing the RNG itself. The tier art/rarity system is
   deliberately the exact same one cards.html's ratings use (see
   style.css's .tier-silver..diamond) so "gem tier" reads as one concept
   across the whole site.
   ====================================================================== */

const TIERS = ['silver', 'gold', 'emerald', 'ruby', 'amethyst', 'diamond'];

// Odds are a flat guess for this preview, not tuned against anything —
// same spot an admin "Pack Methodology" tab (mirroring the existing
// Projection Methodology tab) would write to later.
const TIER_WEIGHTS = { silver: 45, gold: 28, emerald: 15, ruby: 7, amethyst: 4, diamond: 1 };
const TIER_LABEL = { silver: 'Silver', gold: 'Gold', emerald: 'Emerald', ruby: 'Ruby', amethyst: 'Amethyst', diamond: 'Diamond' };

// A second, independent roll on top of tier — a BGS-style grading slab
// layered onto the pull, same "weighted odds" mechanic as tier but
// deliberately its own axis: two Diamond pulls can still differ by
// grade. NOT part of the collection key (state.collection keys off the
// player, not the grade) — this is presentation/flavor on top of a
// pull, not a separate thing to "own," so it's re-rolled fresh each
// pack open rather than persisted.
//
// Weights are a discretized normal distribution — mean 8, sigma 1 —
// sampled at each grade's actual numeric value (so 8.5 and 9 are only
// half a point apart while 7 and 8 are a full point, matching real BGS
// grade spacing) and normalized to sum to 100:
//   python3 -c "import math; mean=8; sigma=1
//   xs=[7,8,8.5,9,9.5,10]
//   raw=[math.exp(-((x-mean)**2)/(2*sigma**2)) for x in xs]
//   print([round(r/sum(raw)*100) for r in raw])"
// -> [17, 28, 25, 17, 9, 4] — 8 is the clear peak, tapering off
// symmetrically-ish in both directions (matching "8 most common").
const GRADES = ['7', '8', '8.5', '9', '9.5', '10'];
const GRADE_WEIGHTS = { '7': 17, '8': 28, '8.5': 25, '9': 17, '9.5': 9, '10': 4 };
const GRADE_LABEL = { '7': 'NEAR MINT', '8': 'NM-MT', '8.5': 'NM-MT+', '9': 'MINT', '9.5': 'GEM MINT', '10': 'PRISTINE' };
const GRADE_COLOR = { '7': '#8b98ab', '8': '#aab0ba', '8.5': '#c7cdd6', '9': '#e8edf4', '9.5': '#ffffff', '10': '#ffd76a' };

const PACK = { name: 'Standard Jersey Pack', cardCount: 1 };

const STORAGE_KEY = 'pk_jersey_collection_v1';

// Jersey art registry — `name`, `image`, and `tier` all set deliberately
// (by the Jerseys tab on admin.html's "Rarity class" select, or by hand
// here) rather than guessed. A team maps to either one entry (a single
// object) or an array of them (BOS/BUF below) — every entry, regardless
// of team, is one card in the pool a pull draws from (see ALL_PLAYERS):
// there's no per-team pull step anymore, so a team with zero entries
// just never comes up rather than falling back to a placeholder. Mirrors
// the shape admin-jerseys.js's localStorage-staged entries use (see
// admin.html) — copy an entry here verbatim to actually publish it
// site-wide, since this file (not localStorage) is what every visitor
// loads.
//
// `tier` currently defaults every entry below to 'silver' — real
// classification (which of these are actually Diamond-caliber legends
// vs. depth guys) is a call for the site owner to make via Admin ->
// Jerseys, not something to guess at here. Until that happens, every
// pull will land on silver (TIER_WEIGHTS' by-far-largest bucket) since
// nothing's classified into the other five yet — expected, not a bug.
const JERSEY_ART = {
  BOS: [
    // borr-transparent.png (the original placeholder used since this
    // feature's earliest prototype) was deleted directly on GitHub and
    // replaced with a properly-published, correctly-tagged upload.
    { name: 'Bobby Orr — #4', image: 'jerseys/bos-bobby-orr.png', tier: 'silver' },
    // Published via Admin -> Jerseys with the team dropdown left on its
    // default (Anaheim) — the jersey itself is unmistakably Boston
    // (black/gold, ORR #4), so it's filed here rather than under ANA.
    // Filename kept as originally published (ana-bobby-orr.png); only
    // this registry entry's team placement was corrected.
    { name: 'Bobby Orr — #4 (alt)', image: 'jerseys/ana-bobby-orr.png', tier: 'silver' },
    { name: 'Ray Bourque — #77', image: 'jerseys/bos-ray-bourque.png', tier: 'silver' },
  ],
  BUF: [
    { name: 'Perreault — #11', image: 'jerseys/buf-perreault-11.png', tier: 'silver' },
    { name: 'Hasek — #39', image: 'jerseys/buf-hasek-39.png', tier: 'silver' },
    { name: 'Lafontaine — #16', image: 'jerseys/buf-lafontaine-16.png', tier: 'silver' },
    { name: 'Gare — #18', image: 'jerseys/buf-gare-18.png', tier: 'silver' },
    { name: 'Andreychuk — #26', image: 'jerseys/buf-andreychuk-26.png', tier: 'silver' },
    { name: 'Ruff — #22', image: 'jerseys/buf-ruff-22.png', tier: 'silver' },
    { name: 'Ramsay — #14', image: 'jerseys/buf-ramsay-14.png', tier: 'silver' },
    { name: 'Martin — #7', image: 'jerseys/buf-martin-7.png', tier: 'silver' },
    { name: 'Robert — #8', image: 'jerseys/buf-robert-8.png', tier: 'silver' },
    { name: 'Miller — #30', image: 'jerseys/buf-miller-30.png', tier: 'silver' },
    { name: 'Vanek — #26', image: 'jerseys/buf-vanek-26.png', tier: 'silver' },
    { name: 'Drury — #23', image: 'jerseys/buf-drury-23.png', tier: 'silver' },
    { name: 'Briere — #48', image: 'jerseys/buf-briere-48.png', tier: 'silver' },
    { name: 'Pominville — #29', image: 'jerseys/buf-pominville-29.png', tier: 'silver' },
    { name: 'Afinogenov — #61', image: 'jerseys/buf-afinogenov-61.png', tier: 'silver' },
    { name: 'Roy — #9', image: 'jerseys/buf-roy-9.png', tier: 'silver' },
    { name: 'Thompson — #72', image: 'jerseys/buf-thompson-72.png', tier: 'silver' },
    { name: 'Schoenfeld — #6', image: 'jerseys/buf-schoenfeld-6.png', tier: 'silver' },
    { name: 'Korab — #4', image: 'jerseys/buf-korab-4.png', tier: 'silver' },
    { name: 'Dahlin — #26', image: 'jerseys/buf-dahlin-26.png', tier: 'silver' },
  ],
};

// Flattened once at load: every JERSEY_ART entry, from every team,
// as one flat list of pullable players — this (not JERSEY_ART directly)
// is what pullOne()/renderCollection() actually operate on, so the pull
// doesn't care whether a team's entries happen to be grouped as an
// array or a single object above.
const ALL_PLAYERS = Object.entries(JERSEY_ART).flatMap(([team, entries]) =>
  (Array.isArray(entries) ? entries : [entries]).map((entry) => ({ ...entry, team }))
);

const el = {
  loading: document.getElementById('pkLoading'),
  packSection: document.getElementById('pkPackSection'),
  packName: document.getElementById('pkPackName'),
  packName2: document.getElementById('pkPackName2'),
  packCount: document.getElementById('pkPackCount'),
  odds: document.getElementById('pkOdds'),
  gradeOdds: document.getElementById('pkGradeOdds'),
  pack: document.getElementById('pkPack'),
  openBtn: document.getElementById('pkOpenBtn'),
  revealSection: document.getElementById('pkRevealSection'),
  stageFixtures: document.getElementById('pkStageFixtures'),
  stageBeams: document.getElementById('pkStageBeams'),
  stagePiece: document.getElementById('pkStagePiece'),
  openAgainBtn: document.getElementById('pkOpenAgainBtn'),
  collection: document.getElementById('pkCollection'),
  progressLabel: document.getElementById('pkProgressLabel'),
  progressFill: document.getElementById('pkProgressFill'),
  teamRows: document.getElementById('pkTeamRows'),
  resetBtn: document.getElementById('pkResetBtn'),
  modalRoot: document.getElementById('pkModalRoot'),
  modalOverlay: document.getElementById('pkModalOverlay'),
  modalClose: document.getElementById('pkModalClose'),
  modalContent: document.getElementById('pkModalContent'),
};

const state = {
  teamMeta: null, // Map from data.js's buildTeamMeta() — team logos/common-names only, cosmetic
  collection: loadCollection(), // { "jerseys/buf-hasek-39.png": 3, ... } — keyed by player (see keyFor())
};

function loadCollection() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function saveCollection() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.collection));
}

function pickWeighted(values, weights) {
  const total = values.reduce((sum, v) => sum + weights[v], 0);
  let r = Math.random() * total;
  for (const v of values) {
    r -= weights[v];
    if (r <= 0) return v;
  }
  return values[0];
}

/** Same idea as pickWeighted, but for a list of arbitrary objects whose
 *  weight comes from a function instead of a plain {value: weight} map
 *  — used to weight ALL_PLAYERS by each player's own tier's odds. */
function pickWeightedBy(items, weightFn) {
  const total = items.reduce((sum, it) => sum + weightFn(it), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/** The pull: one player, drawn from every classified jersey in
 *  ALL_PLAYERS weighted by TIER_WEIGHTS[player.tier] — so tier and
 *  player are one roll, not two (a Diamond pull IS whichever player is
 *  actually classified Diamond, never a mismatch). Grade is still its
 *  own separate roll on top. */
function pullOne() {
  const player = pickWeightedBy(ALL_PLAYERS, (p) => TIER_WEIGHTS[p.tier] || 0);
  const grade = pickWeighted(GRADES, GRADE_WEIGHTS);
  return { player, team: player.team, tier: player.tier, grade };
}

// The collection key is the player, not team+tier — tier is now fixed
// per player rather than an independent roll, so "own BOS at Diamond"
// isn't a meaningful separate thing from "own whichever specific player
// is BOS's Diamond card" the way it used to be. image is already a
// stable per-player unique id (every jersey is its own file).
function keyFor(player) { return player.image; }

/** Random confetti-piece HTML: N rectangles flung outward from center on
 *  random angles/distances, colored from the tier palette. Only used in
 *  the animated stage reveal — see opts.animate below. */
function confettiHTML() {
  const colors = ['#fff', 'var(--t1)', 'var(--t-accent)'];
  let html = '';
  for (let i = 0; i < 18; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 70 + Math.random() * 100;
    const dx = Math.round(Math.cos(angle) * dist);
    const dy = Math.round(Math.sin(angle) * dist - 25); // biased upward/outward, not straight down
    const rot = Math.round(Math.random() * 720 - 360);
    const delay = (Math.random() * 0.3).toFixed(2);
    const w = 3 + Math.round(Math.random() * 3);
    html += `<span class="jp-confetti-piece" style="--dx:${dx}px; --dy:${dy}px; --rot:${rot}deg; width:${w}px; height:${w * 2}px; background:${colors[i % colors.length]}; animation-delay:${(2.3 + Number(delay)).toFixed(2)}s;"></span>`;
  }
  return html;
}

/** Builds one jersey slab — a real graded-collectible layout (header
 *  strip with team monogram/player name/rating box, a middle display
 *  window with the jersey art + a decorative side icon, a footer with
 *  team name + item id + tier pill), as a DOM node. Takes the player
 *  object straight from ALL_PLAYERS/pullOne() — tier comes from
 *  `player.tier`, not a separate argument, since the two are the same
 *  roll now (see pullOne()). `opts.badge` ("NEW"/"+1"), if given,
 *  renders a pull-result ribbon. `opts.count`, if given, renders an
 *  owned-count chip instead (collection context). `opts.grade`, if
 *  given, renders the rating box (omitted in some static previews
 *  where no grade was rolled — see openJerseyModal). `opts.animate`
 *  plays the stage entrance (rise-in + confetti burst + idle hover);
 *  omit it for a static, already-settled render. */
function buildJerseyPiece(player, opts = {}) {
  const tier = player.tier;
  const meta = state.teamMeta?.get(player.team);
  const teamName = meta?.common || meta?.name || player.team;
  const itemId = player.image.split('/').pop().replace(/\.[a-z0-9]+$/i, '').toUpperCase();

  const piece = document.createElement('div');
  piece.className = `jersey-piece tier-${tier}${opts.animate ? ' jp-rise-in' : ''}`;
  if (!opts.animate) piece.style.opacity = '1'; // skip the entrance's initial hidden state
  piece.innerHTML = `
    <div class="jp-float-wrap ${opts.animate ? 'jp-float' : ''}">
      <div class="jp-slab ${opts.animate ? 'jp-spotlit' : ''}">
        <div class="jp-slab-top">
          <div class="jp-slab-heading">
            <div class="jp-slab-player-name">${escapeHtml(player.name || teamName)}</div>
            <div class="jp-slab-subtitle">${TIER_LABEL[tier]} Collectible</div>
          </div>
          ${opts.grade ? `
            <div class="jp-rating-box">
              <span class="jp-rating-title">Card Rating</span>
              <span class="jp-rating-score" style="color:${GRADE_COLOR[opts.grade]};">${opts.grade}</span>
              <span class="jp-rating-desc">${GRADE_LABEL[opts.grade]}</span>
            </div>
          ` : ''}
        </div>
        <div class="jp-slab-middle">
          <div class="jp-jersey-wrap">
            <span class="jp-sparkle" style="top:8%; left:6%; animation-delay:0s;"></span>
            <span class="jp-sparkle" style="top:24%; left:90%; animation-delay:0.9s;"></span>
            <span class="jp-sparkle" style="top:80%; left:12%; animation-delay:1.6s;"></span>
            ${opts.badge ? `<div class="jp-badge jp-badge-${opts.badge === 'NEW' ? 'new' : 'dupe'}">${opts.badge}</div>` : ''}
            ${opts.count ? `<div class="jp-count-chip">×${opts.count}</div>` : ''}
            <div class="jp-jersey-photo">
              <img class="jp-jersey-img" src="${player.image}" alt="">
              <span class="jp-jersey-sheen"></span>
            </div>
          </div>
        </div>
        <div class="jp-slab-bottom">
          <div class="jp-slab-footer-text">
            <div class="jp-slab-team-name">${escapeHtml(teamName)}</div>
            <div class="jp-slab-item-id">#${escapeHtml(itemId)}</div>
          </div>
          <div class="jp-tier-tag">${TIER_LABEL[tier]}</div>
        </div>
      </div>
      ${opts.animate ? `<div class="jp-confetti">${confettiHTML()}</div>` : ''}
    </div>
  `;
  return piece;
}

function renderOdds() {
  const total = TIERS.reduce((sum, t) => sum + TIER_WEIGHTS[t], 0);
  el.odds.textContent = 'Odds: ' + TIERS.map((t) => `${TIER_LABEL[t]} ${(TIER_WEIGHTS[t] / total * 100).toFixed(0)}%`).join(' · ');

  const gradeTotal = GRADES.reduce((sum, g) => sum + GRADE_WEIGHTS[g], 0);
  el.gradeOdds.textContent = 'Grade odds: ' + GRADES.slice().reverse()
    .map((g) => `${g} ${(GRADE_WEIGHTS[g] / gradeTotal * 100).toFixed(0)}%`).join(' · ');
}

/** Plays the "ring of spotlights" reveal: five beams + the light-ring +
 *  the overhead fixture cones all flood the stage first (see
 *  .pk-beam-flash/.pk-fixture-flash in style.css, ~3.4s to fully dim),
 *  then the graded-slab jersey rises up smoothly from below the stage,
 *  through the ring, into the light (.jp-rise-in's 1s delay is tuned to
 *  land while the flood is still bright), gets a brief brightness pulse
 *  + confetti burst as the light "catches" it — and as it settles, the
 *  flood dims down with it, handing the spotlight to the jersey itself
 *  rather than staying bright behind it. Re-triggering CSS animations
 *  on a repeat open needs the classList reset + a forced reflow below —
 *  just re-adding the same class name is a no-op to the browser. */
function playOpeningAnimation(pull, badge) {
  el.stageBeams.className = 'pk-stage-beams';
  el.stageFixtures.className = 'pk-stage-fixtures';
  void el.stageBeams.offsetWidth; // force reflow so the animation restarts
  el.stageBeams.classList.add(`tier-${pull.tier}`, 'pk-beam-flash');
  el.stageFixtures.classList.add('pk-fixture-flash');

  el.stagePiece.innerHTML = '';
  el.stagePiece.appendChild(buildJerseyPiece(pull.player, { badge, grade: pull.grade, animate: true }));
}

function openPack() {
  el.openBtn.disabled = true;
  const pull = pullOne();
  const key = keyFor(pull.player);
  const isNew = !state.collection[key];
  state.collection[key] = (state.collection[key] || 0) + 1;
  saveCollection();

  el.revealSection.hidden = false;
  playOpeningAnimation(pull, isNew ? 'NEW' : '+1');
  renderCollection();
  el.revealSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.openBtn.disabled = false;
}

/** Lists every classified player as its own row (one pip each, colored
 *  by that player's fixed tier) — replaces the old team x tier pip
 *  grid, which stopped making sense once tier became a property of the
 *  player rather than something independently rolled per team. */
function renderCollection() {
  el.collection.hidden = false;
  const total = ALL_PLAYERS.length;
  const owned = ALL_PLAYERS.filter((p) => state.collection[keyFor(p)]).length;
  const totalPulls = Object.values(state.collection).reduce((a, b) => a + b, 0);
  el.progressLabel.textContent = `${owned} / ${total} unique jerseys collected — ${totalPulls} total pulls`;
  el.progressFill.style.width = `${total ? (owned / total * 100) : 0}%`;

  const sorted = [...ALL_PLAYERS].sort((a, b) => {
    const na = state.teamMeta?.get(a.team)?.common || a.team;
    const nb = state.teamMeta?.get(b.team)?.common || b.team;
    if (na !== nb) return na.localeCompare(nb);
    return (a.name || '').localeCompare(b.name || '');
  });

  el.teamRows.innerHTML = '';
  for (const player of sorted) {
    const meta = state.teamMeta?.get(player.team);
    const count = state.collection[keyFor(player)] || 0;
    const row = document.createElement('div');
    row.className = 'pk-team-row';
    row.innerHTML = `
      <div class="pk-team-row-label">
        ${meta?.logo ? `<img src="${meta.logo}" alt="" loading="lazy">` : ''}
        <span>${escapeHtml(player.name || player.team)}</span>
      </div>
      <div class="pk-pip-row">
        <button type="button" class="pk-pip tier-${player.tier} ${count ? 'pk-pip-owned' : 'pk-pip-locked'}"
          data-image="${escapeHtml(player.image)}" title="${TIER_LABEL[player.tier]}${count ? ` — owned ×${count}` : ' — not pulled yet'}"
          ${count ? '' : 'disabled'}></button>
      </div>
    `;
    el.teamRows.appendChild(row);
  }
}

function openJerseyModal(image) {
  const player = ALL_PLAYERS.find((p) => p.image === image);
  if (!player) return;
  const count = state.collection[keyFor(player)] || 0;
  el.modalContent.innerHTML = '';
  el.modalContent.appendChild(buildJerseyPiece(player, { count }));
  el.modalRoot.hidden = false;
}

function closeJerseyModal() { el.modalRoot.hidden = true; }

function wireEvents() {
  el.openBtn.addEventListener('click', openPack);
  el.openAgainBtn.addEventListener('click', openPack);
  el.pack.addEventListener('click', openPack);

  el.teamRows.addEventListener('click', (e) => {
    const pip = e.target.closest('.pk-pip-owned');
    if (!pip) return;
    openJerseyModal(pip.dataset.image);
  });

  el.resetBtn.addEventListener('click', () => {
    if (!confirm('Reset your local jersey collection? This only clears this browser’s preview data.')) return;
    state.collection = {};
    saveCollection();
    renderCollection();
    el.revealSection.hidden = true;
  });

  el.modalOverlay.addEventListener('click', closeJerseyModal);
  el.modalClose.addEventListener('click', closeJerseyModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modalRoot.hidden) closeJerseyModal();
  });
}

async function init() {
  wireEvents();
  try {
    const standings = await getJSON(`${API_WEB}/v1/standings/now`);
    state.teamMeta = buildTeamMeta(standings);
  } catch {
    // Team logos/common-names are cosmetic only (buildJerseyPiece and
    // renderCollection both already fall back to the raw abbrev when
    // teamMeta has nothing) — packs still open fine off ALL_PLAYERS
    // alone if standings/now is down.
    state.teamMeta = new Map();
  }

  el.loading.hidden = true;
  el.packName.textContent = PACK.name;
  el.packName2.textContent = PACK.name;
  el.packCount.textContent = `${PACK.cardCount} jersey${PACK.cardCount === 1 ? '' : 's'}`;
  renderOdds();
  el.packSection.hidden = false;

  if (Object.keys(state.collection).length) renderCollection();
}

init();
