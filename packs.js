'use strict';

/* ======================================================================
   Player Jersey Packs — Mini-Games page 2 (Game 5 from fantasy-hub's
   design doc, "player packs", built here as a JERSEY collectible rather
   than a stat-card collectible — cards.html/ratings.js already own the
   player-rating-card idea, so packs pull a random TEAM's jersey at a
   random rarity tier instead of a random player).

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
// grade. NOT part of the collection key (state.collection stays
// team+tier) — this is presentation/flavor on top of a pull, not a
// separate thing to "own," so it's re-rolled fresh each pack open
// rather than persisted.
const GRADES = ['7', '8', '8.5', '9', '9.5', '10'];
const GRADE_WEIGHTS = { '7': 13, '8': 25, '8.5': 28, '9': 22, '9.5': 10, '10': 2 };
const GRADE_LABEL = { '7': 'NEAR MINT', '8': 'NM-MT', '8.5': 'NM-MT+', '9': 'MINT', '9.5': 'GEM MINT', '10': 'PRISTINE' };
const GRADE_COLOR = { '7': '#8b98ab', '8': '#aab0ba', '8.5': '#c7cdd6', '9': '#e8edf4', '9.5': '#ffffff', '10': '#ffd76a' };

const PACK = { name: 'Standard Jersey Pack', cardCount: 1 };

const STORAGE_KEY = 'pk_jersey_collection_v1';

// Hand-maintained team primary/secondary colors — not currently drawn
// anywhere (the jersey art below is one shared sample image, not
// per-team tinted; see SAMPLE_JERSEY_IMG), kept as the offline fallback
// list of abbrevs (state.abbrevs, below) and ready for whenever real
// per-team jersey art replaces the sample.
const TEAM_COLORS = {
  ANA: ['#F47A38', '#111111'], BOS: ['#FFB81C', '#000000'], BUF: ['#002654', '#FCB514'],
  CGY: ['#C8102E', '#F1BE48'], CAR: ['#CC0000', '#000000'], CHI: ['#CF0A2C', '#000000'],
  COL: ['#6F263D', '#236192'], CBJ: ['#002654', '#CE1126'], DAL: ['#006847', '#8F8F8C'],
  DET: ['#CE1126', '#FFFFFF'], EDM: ['#041E42', '#FF4C00'], FLA: ['#C8102E', '#041E42'],
  LAK: ['#111111', '#A2AAAD'], MIN: ['#154734', '#A6192E'], MTL: ['#AF1E2D', '#192168'],
  NSH: ['#FFB81C', '#041E42'], NJD: ['#CE1126', '#000000'], NYI: ['#00539B', '#F47D30'],
  NYR: ['#0038A8', '#CE1126'], OTT: ['#C52032', '#000000'], PHI: ['#F74902', '#000000'],
  PIT: ['#FCB514', '#000000'], SJS: ['#006D75', '#EA7200'], SEA: ['#001628', '#99D9D9'],
  STL: ['#002F87', '#FCB514'], TBL: ['#002868', '#FFFFFF'], TOR: ['#00205B', '#FFFFFF'],
  UTA: ['#71AFE5', '#101820'], VAN: ['#00205B', '#00843D'], VGK: ['#B4975A', '#333F42'],
  WSH: ['#C8102E', '#041E42'], WPG: ['#041E42', '#004C97'],
};

// Jersey art registry — one explicit entry per team, `name` and `image`
// both set deliberately (by the Jerseys tab on admin.html, or by hand
// here) rather than guessed from the picture. A team with no entry
// falls back to FALLBACK_JERSEY so every pull still renders something.
// Mirrors the shape admin-jerseys.js's localStorage-staged entries use
// (see admin.html) — copy an entry here verbatim to actually publish it
// site-wide, since this file (not localStorage) is what every visitor
// loads.
const JERSEY_ART = {
  BOS: { name: 'Bobby Orr — #4', image: 'jerseys/borr-transparent.png' },
};
const FALLBACK_JERSEY = { name: '', image: 'jerseys/borr-transparent.png' };

function jerseyArtFor(team) {
  return JERSEY_ART[team] || FALLBACK_JERSEY;
}

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
  teamMeta: null, // Map from data.js's buildTeamMeta()
  abbrevs: [],
  collection: loadCollection(), // { "TOR-diamond": 3, ... }
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

function pullOne() {
  const team = state.abbrevs[Math.floor(Math.random() * state.abbrevs.length)];
  const tier = pickWeighted(TIERS, TIER_WEIGHTS);
  const grade = pickWeighted(GRADES, GRADE_WEIGHTS);
  return { team, tier, grade };
}

function keyFor(team, tier) { return `${team}-${tier}`; }

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

/** Builds one jersey slab — a graded-card-style holder (holographic
 *  border + foil sheen) with the jersey inside, as a DOM node.
 *  `opts.badge` ("NEW"/"+1"), if given, renders a pull-result ribbon.
 *  `opts.count`, if given, renders an owned-count chip instead
 *  (collection context). `opts.animate` plays the stage entrance
 *  (rise-in + confetti burst + idle hover); omit it for a static,
 *  already-settled render (the collection's click-to-preview modal). */
function buildJerseyPiece(team, tier, opts = {}) {
  const meta = state.teamMeta?.get(team);
  const teamName = meta?.common || meta?.name || team;
  const art = jerseyArtFor(team);

  const piece = document.createElement('div');
  piece.className = `jersey-piece tier-${tier}${opts.animate ? ' jp-rise-in' : ''}`;
  if (!opts.animate) piece.style.opacity = '1'; // skip the entrance's initial hidden state
  piece.innerHTML = `
    <div class="jp-float-wrap ${opts.animate ? 'jp-float' : ''}">
      <div class="jp-slab ${opts.animate ? 'jp-spotlit' : ''}">
        ${opts.grade ? `
          <div class="jp-grade-plate">
            <span class="jp-grade-num" style="color:${GRADE_COLOR[opts.grade]};">${opts.grade}</span>
            <span class="jp-grade-label">${GRADE_LABEL[opts.grade]}</span>
          </div>
        ` : ''}
        <div class="jp-slab-holo"></div>
        <div class="jp-slab-panel${opts.grade ? ' jp-slab-panel-graded' : ''}">
          <div class="jp-tier-tag">${TIER_LABEL[tier]}</div>
          <div class="jp-jersey-wrap">
            <span class="jp-sparkle" style="top:8%; left:6%; animation-delay:0s;"></span>
            <span class="jp-sparkle" style="top:24%; left:90%; animation-delay:0.9s;"></span>
            <span class="jp-sparkle" style="top:80%; left:12%; animation-delay:1.6s;"></span>
            ${opts.badge ? `<div class="jp-badge jp-badge-${opts.badge === 'NEW' ? 'new' : 'dupe'}">${opts.badge}</div>` : ''}
            ${opts.count ? `<div class="jp-count-chip">×${opts.count}</div>` : ''}
            <div class="jp-jersey-photo">
              <img class="jp-jersey-img" src="${art.image}" alt="">
              <span class="jp-jersey-sheen"></span>
            </div>
          </div>
          <div class="jp-info">
            ${meta?.logo ? `<img class="jp-team-logo" src="${meta.logo}" alt="" loading="lazy">` : ''}
            <div class="jp-team-name">${escapeHtml(teamName)}</div>
            ${art.name ? `<div class="jp-jersey-label">${escapeHtml(art.name)}</div>` : ''}
          </div>
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
  el.stagePiece.appendChild(buildJerseyPiece(pull.team, pull.tier, { badge, grade: pull.grade, animate: true }));
}

function openPack() {
  el.openBtn.disabled = true;
  const pull = pullOne();
  const key = keyFor(pull.team, pull.tier);
  const isNew = !state.collection[key];
  state.collection[key] = (state.collection[key] || 0) + 1;
  saveCollection();

  el.revealSection.hidden = false;
  playOpeningAnimation(pull, isNew ? 'NEW' : '+1');
  renderCollection();
  el.revealSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.openBtn.disabled = false;
}

function renderCollection() {
  el.collection.hidden = false;
  const total = state.abbrevs.length * TIERS.length;
  const owned = Object.keys(state.collection).length;
  const totalPulls = Object.values(state.collection).reduce((a, b) => a + b, 0);
  el.progressLabel.textContent = `${owned} / ${total} unique jerseys collected — ${totalPulls} total pulls`;
  el.progressFill.style.width = `${total ? (owned / total * 100) : 0}%`;

  const teams = [...state.abbrevs].sort((a, b) => {
    const na = state.teamMeta?.get(a)?.common || a;
    const nb = state.teamMeta?.get(b)?.common || b;
    return na.localeCompare(nb);
  });

  el.teamRows.innerHTML = '';
  for (const team of teams) {
    const meta = state.teamMeta?.get(team);
    const row = document.createElement('div');
    row.className = 'pk-team-row';
    row.innerHTML = `
      <div class="pk-team-row-label">
        ${meta?.logo ? `<img src="${meta.logo}" alt="" loading="lazy">` : ''}
        <span>${escapeHtml(meta?.common || team)}</span>
      </div>
      <div class="pk-pip-row">
        ${TIERS.map((t) => {
          const count = state.collection[keyFor(team, t)] || 0;
          return `<button type="button" class="pk-pip tier-${t} ${count ? 'pk-pip-owned' : 'pk-pip-locked'}"
            data-team="${team}" data-tier="${t}" title="${TIER_LABEL[t]}${count ? ` — owned ×${count}` : ' — not pulled yet'}"
            ${count ? '' : 'disabled'}></button>`;
        }).join('')}
      </div>
    `;
    el.teamRows.appendChild(row);
  }
}

function openJerseyModal(team, tier) {
  const count = state.collection[keyFor(team, tier)] || 0;
  el.modalContent.innerHTML = '';
  el.modalContent.appendChild(buildJerseyPiece(team, tier, { count }));
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
    openJerseyModal(pip.dataset.team, pip.dataset.tier);
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
    state.abbrevs = Array.from(state.teamMeta.keys());
  } catch {
    // Team names/logos are cosmetic here — fall back to a bare list of
    // abbrevs so packs can still be opened even if standings/now is down.
    state.abbrevs = Object.keys(TEAM_COLORS);
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
