'use strict';

/* ======================================================================
   "Guess the Player" — the first of the planned Mini-Games. A mystery
   NHL player is picked deterministically once per calendar day (same
   player for every visitor that day, no backend needed — see
   pickMysteryPlayer()). You get 8 guesses; each guess is scored against
   the answer across 6 categories (Team, Division, Position, Age,
   Height, Nationality), Wordle/Poeltl-style: green = exact match,
   yellow = close, dark = not close. Progress for today's puzzle is
   saved to localStorage so a reload doesn't lose it.

   Data source: data.js's loadPlayerBioPool() — one roster fetch per
   team (bio fields: height/weight/birth date+country/shoots), NOT the
   season-stats pipeline the rest of the site uses. This game cares who
   a player IS, not how they're performing this season.
   ====================================================================== */

const MAX_GUESSES = 8;
const AGE_CLOSE_TOLERANCE = 3; // years
const HEIGHT_CLOSE_TOLERANCE = 2; // inches
const POSITION_GROUP = { C: 'F', L: 'F', R: 'F', D: 'D', G: 'G' };
const POSITION_LABEL = { C: 'C', L: 'LW', R: 'RW', D: 'D', G: 'G' };

// IOC-style 3-letter birth-country codes -> display name. Covers the
// nations that actually show up on NHL rosters; anything missing just
// falls back to the raw code rather than breaking.
const COUNTRY_NAME = {
  CAN: 'Canada', USA: 'United States', SWE: 'Sweden', FIN: 'Finland', RUS: 'Russia',
  CZE: 'Czechia', SVK: 'Slovakia', CHE: 'Switzerland', DEU: 'Germany', DNK: 'Denmark',
  NOR: 'Norway', AUT: 'Austria', FRA: 'France', GBR: 'Great Britain', LVA: 'Latvia',
  BLR: 'Belarus', SVN: 'Slovenia', UKR: 'Ukraine', KAZ: 'Kazakhstan', JPN: 'Japan',
  AUS: 'Australia', ITA: 'Italy', POL: 'Poland', HUN: 'Hungary', EST: 'Estonia',
  LTU: 'Lithuania', NLD: 'Netherlands', BEL: 'Belgium', ESP: 'Spain', MEX: 'Mexico',
  CHN: 'China', KOR: 'South Korea', BRA: 'Brazil', SRB: 'Serbia', HRV: 'Croatia',
  IRL: 'Ireland', NZL: 'New Zealand', ISR: 'Israel', JAM: 'Jamaica', ZAF: 'South Africa',
  THA: 'Thailand', TWN: 'Taiwan', ROU: 'Romania', BIH: 'Bosnia and Herzegovina',
};

function countryName(code) {
  return COUNTRY_NAME[code] || code || 'Unknown';
}

const el = {
  statusBanner: document.getElementById('statusBanner'),
  subtitle: document.getElementById('gwSubtitle'),
  skeleton: document.getElementById('gwSkeleton'),
  game: document.getElementById('gwGame'),
  guessInput: document.getElementById('gwGuessInput'),
  suggestions: document.getElementById('gwSuggestions'),
  guessBtn: document.getElementById('gwGuessBtn'),
  triesLeft: document.getElementById('gwTriesLeft'),
  tableBody: document.getElementById('gwTableBody'),
  endBanner: document.getElementById('gwEndBanner'),
  confettiLayer: document.getElementById('gwConfettiLayer'),
  winModalRoot: document.getElementById('gwWinModalRoot'),
  winModalOverlay: document.getElementById('gwWinModalOverlay'),
  winModalClose: document.getElementById('gwWinModalClose'),
  winModalImg: document.getElementById('gwWinModalImg'),
  winModalName: document.getElementById('gwWinModalName'),
  winModalTries: document.getElementById('gwWinModalTries'),
  winShareBtn: document.getElementById('gwWinShareBtn'),
  winShareMsg: document.getElementById('gwWinShareMsg'),
  divisionsBtn: document.getElementById('gwDivisionsBtn'),
  divisionsModalRoot: document.getElementById('gwDivisionsModalRoot'),
  divisionsModalOverlay: document.getElementById('gwDivisionsModalOverlay'),
  divisionsModalClose: document.getElementById('gwDivisionsModalClose'),
  divisionsGrid: document.getElementById('gwDivisionsGrid'),
};

const state = {
  teamMeta: null,
  pool: [],
  poolById: new Map(),
  mystery: null,
  guesses: [], // array of full player bio objects, in guess order
  gameOver: false,
  won: false,
  dateKey: null,
  selectedGuess: null, // pending player selected from the suggestion list
};

function showError(message) {
  el.statusBanner.hidden = false;
  el.statusBanner.textContent = message; // .status-banner is red/error-styled by default (see style.css)
}

/** Deterministic string hash (djb2) — used to turn today's date into a
 *  stable index into the player pool, so every visitor gets the SAME
 *  mystery player on the same calendar day without any server state. */
function hashStringToInt(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function pickMysteryPlayer(pool, dateKey) {
  const sorted = [...pool].sort((a, b) => a.playerId - b.playerId);
  const idx = hashStringToInt(dateKey) % sorted.length;
  return sorted[idx];
}

function storageKey(dateKey) {
  return `nhlStats.guessWho.v1.${dateKey}`;
}

function loadSavedState(dateKey) {
  try {
    const raw = localStorage.getItem(storageKey(dateKey));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState() {
  try {
    localStorage.setItem(storageKey(state.dateKey), JSON.stringify({
      mystery: state.mystery,
      guesses: state.guesses,
      gameOver: state.gameOver,
      won: state.won,
    }));
  } catch {
    // Non-fatal — worst case, a reload mid-game loses progress.
  }
}

// ---------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------

function numericTier(guessVal, mysteryVal, closeTolerance) {
  if (guessVal == null || mysteryVal == null) return 'black';
  const diff = Math.abs(guessVal - mysteryVal);
  if (diff === 0) return 'green';
  if (diff <= closeTolerance) return 'yellow';
  return 'black';
}

function numericArrow(guessVal, mysteryVal) {
  if (guessVal == null || mysteryVal == null) return '';
  if (mysteryVal > guessVal) return '▲';
  if (mysteryVal < guessVal) return '▼';
  return '';
}

/** Scores one guess against the mystery player. Returns one entry per
 *  category: { tier: 'green'|'yellow'|'black', text, arrow? }. */
function compareGuess(guess, mystery) {
  const guessMeta = state.teamMeta.get(guess.team);
  const mysteryMeta = state.teamMeta.get(mystery.team);
  const guessAge = ageFromBirthDate(guess.birthDate);
  const mysteryAge = ageFromBirthDate(mystery.birthDate);

  const result = {};

  result.team = {
    tier: guess.team === mystery.team ? 'green' : 'black',
    text: guess.team,
  };

  result.division = {
    tier: guessMeta?.division && guessMeta.division === mysteryMeta?.division ? 'green' : 'black',
    text: guessMeta?.division || '—',
  };

  const samePos = guess.pos === mystery.pos;
  const sameGroup = POSITION_GROUP[guess.pos] === POSITION_GROUP[mystery.pos];
  result.position = {
    tier: samePos ? 'green' : sameGroup ? 'yellow' : 'black',
    text: POSITION_LABEL[guess.pos] || guess.pos,
  };

  result.age = {
    tier: numericTier(guessAge, mysteryAge, AGE_CLOSE_TOLERANCE),
    text: guessAge == null ? '—' : String(guessAge),
    arrow: numericArrow(guessAge, mysteryAge),
  };

  result.height = {
    tier: numericTier(guess.heightInInches, mystery.heightInInches, HEIGHT_CLOSE_TOLERANCE),
    text: formatHeight(guess.heightInInches),
    arrow: numericArrow(guess.heightInInches, mystery.heightInInches),
  };

  result.nationality = {
    tier: guess.birthCountry === mystery.birthCountry ? 'green' : 'black',
    text: countryName(guess.birthCountry),
  };

  return result;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function cellHtml(cat) {
  const arrow = cat.arrow ? `<span class="gw-arrow">${cat.arrow}</span>` : '';
  return `<td class="gw-cell gw-tier-${cat.tier}"><span class="gw-cell-val">${escapeHtml(cat.text)}</span>${arrow}</td>`;
}

function renderGuessRow(guess) {
  const cmp = compareGuess(guess, state.mystery);
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="gw-cell-player">
      <img src="${guess.headshot}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span>${escapeHtml(guess.name)}</span>
    </td>
    ${cellHtml(cmp.team)}
    ${cellHtml(cmp.division)}
    ${cellHtml(cmp.position)}
    ${cellHtml(cmp.age)}
    ${cellHtml(cmp.height)}
    ${cellHtml(cmp.nationality)}
  `;
  return row;
}

function renderBoard() {
  el.tableBody.innerHTML = '';
  for (const guess of state.guesses) {
    el.tableBody.appendChild(renderGuessRow(guess));
  }
  const remaining = MAX_GUESSES - state.guesses.length;
  if (state.gameOver) {
    el.triesLeft.textContent = state.won
      ? `Solved in ${state.guesses.length} of ${MAX_GUESSES} guesses!`
      : `Out of guesses — the answer was ${state.mystery.name}.`;
  } else {
    el.triesLeft.textContent = `Guess ${state.guesses.length + 1} of ${MAX_GUESSES}`;
  }
  renderEndBanner();
  renderInputLock();
}

function renderInputLock() {
  const locked = state.gameOver;
  el.guessInput.disabled = locked;
  el.guessBtn.disabled = locked || !state.selectedGuess;
  if (locked) {
    el.guessInput.value = '';
    el.suggestions.hidden = true;
  }
}

function shareText() {
  const tiles = { green: '🟩', yellow: '🟨', black: '⬛' };
  const lines = state.guesses.map((guess) => {
    const cmp = compareGuess(guess, state.mystery);
    return ['team', 'division', 'position', 'age', 'height', 'nationality']
      .map((k) => tiles[cmp[k].tier]).join('');
  });
  const score = state.won ? `${state.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  return `Guess the Player ${state.dateKey} ${score}\n${lines.join('\n')}`;
}

function renderEndBanner() {
  if (!state.gameOver) {
    el.endBanner.hidden = true;
    return;
  }
  const m = state.mystery;
  const meta = state.teamMeta.get(m.team);
  el.endBanner.hidden = false;
  el.endBanner.innerHTML = `
    <div class="gw-end-headline">${state.won ? '🎉 You got it!' : '😔 Better luck tomorrow'}</div>
    <div class="gw-end-player">
      <img src="${m.headshot}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div>
        <div class="gw-end-name">${escapeHtml(m.name)}</div>
        <div class="gw-end-meta">${escapeHtml(m.team)} · ${escapeHtml(meta?.division || '')} · ${escapeHtml(POSITION_LABEL[m.pos] || m.pos)}</div>
      </div>
    </div>
    <button type="button" id="gwShareBtn" class="ghost-btn">📋 Copy Results</button>
    <span id="gwShareMsg" class="gw-share-msg"></span>
  `;
  document.getElementById('gwShareBtn').addEventListener('click', async () => {
    const msg = document.getElementById('gwShareMsg');
    try {
      await navigator.clipboard.writeText(shareText());
      msg.textContent = 'Copied!';
    } catch {
      msg.textContent = 'Could not copy — clipboard unavailable.';
    }
  });
}

// ---------------------------------------------------------------------
// Win celebration — confetti + popup. Fired ONLY at the moment a winning
// guess is submitted (see submitGuess()), never when an already-finished
// game is restored from localStorage on a later visit — replaying the
// celebration every reload would get old fast.
// ---------------------------------------------------------------------

const CONFETTI_COLORS = ['#59d97c', '#ffb020', '#4fb3ff', '#ff4d5e', '#c99aff', '#ffffff'];
const CONFETTI_COUNT = 140;

function spawnConfetti() {
  el.confettiLayer.innerHTML = '';
  const pieces = [];
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    const piece = document.createElement('span');
    piece.className = 'gw-confetti-piece';
    const size = 6 + Math.random() * 7;
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.width = `${size}px`;
    piece.style.height = `${size * (0.4 + Math.random() * 0.6)}px`;
    piece.style.animationDuration = `${2.4 + Math.random() * 1.8}s`;
    piece.style.animationDelay = `${Math.random() * 0.5}s`;
    pieces.push(piece);
  }
  pieces.forEach((p) => el.confettiLayer.appendChild(p));
  setTimeout(() => { el.confettiLayer.innerHTML = ''; }, 4500);
}

function openWinModal(guess) {
  el.winModalImg.src = guess.headshot;
  el.winModalName.textContent = guess.name;
  el.winModalTries.textContent = `Solved in ${state.guesses.length} of ${MAX_GUESSES} guesses!`;
  el.winShareMsg.textContent = '';
  el.winModalRoot.hidden = false;
}

function closeWinModal() {
  el.winModalRoot.hidden = true;
}

function wireWinModal() {
  el.winModalClose.addEventListener('click', closeWinModal);
  el.winModalOverlay.addEventListener('click', closeWinModal);
  el.winShareBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareText());
      el.winShareMsg.textContent = 'Copied!';
    } catch {
      el.winShareMsg.textContent = 'Could not copy — clipboard unavailable.';
    }
  });
}

// ---------------------------------------------------------------------
// "View NHL Divisions" reference popup — a closeable lookup of every
// team and which division it's in, since Division is one of the 6
// guess categories. Built from state.teamMeta (already loaded for the
// Division comparison itself), not a separate fetch.
// ---------------------------------------------------------------------

// Standard NHL presentation order (two per conference); anything
// unrecognized (a future realignment) is appended after these, rather
// than silently dropped.
const DIVISION_ORDER = ['Atlantic', 'Metropolitan', 'Central', 'Pacific'];
const DIVISION_CONFERENCE = {
  Atlantic: 'Eastern', Metropolitan: 'Eastern', Central: 'Western', Pacific: 'Western',
};

function buildDivisionsGridHtml() {
  const byDivision = new Map();
  for (const [abbrev, meta] of state.teamMeta) {
    const division = meta.division || 'Other';
    if (!byDivision.has(division)) byDivision.set(division, []);
    byDivision.get(division).push({ abbrev, name: meta.name });
  }

  const divisions = [...byDivision.keys()].sort((a, b) => {
    const ai = DIVISION_ORDER.indexOf(a);
    const bi = DIVISION_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return divisions.map((division) => {
    const teams = byDivision.get(division).sort((a, b) => a.name.localeCompare(b.name));
    const conference = DIVISION_CONFERENCE[division];
    return `
      <div class="gw-division-card">
        <h3>${escapeHtml(division)}</h3>
        ${conference ? `<div class="gw-division-conference">${escapeHtml(conference)} Conference</div>` : ''}
        <ul>
          ${teams.map((t) => `<li><span class="gw-division-team-abbr">${escapeHtml(t.abbrev)}</span>${escapeHtml(t.name)}</li>`).join('')}
        </ul>
      </div>
    `;
  }).join('');
}

function openDivisionsModal() {
  el.divisionsGrid.innerHTML = buildDivisionsGridHtml();
  el.divisionsModalRoot.hidden = false;
}

function closeDivisionsModal() {
  el.divisionsModalRoot.hidden = true;
}

function wireDivisionsModal() {
  el.divisionsBtn.addEventListener('click', openDivisionsModal);
  el.divisionsModalClose.addEventListener('click', closeDivisionsModal);
  el.divisionsModalOverlay.addEventListener('click', closeDivisionsModal);
}

// ---------------------------------------------------------------------
// Autocomplete + guess submission
// ---------------------------------------------------------------------

function renderSuggestions(query) {
  const guessedIds = new Set(state.guesses.map((g) => g.playerId));
  const q = query.trim().toLowerCase();
  if (!q) {
    el.suggestions.hidden = true;
    el.suggestions.innerHTML = '';
    return;
  }
  const matches = state.pool
    .filter((p) => !guessedIds.has(p.playerId) && p.name.toLowerCase().includes(q))
    .slice(0, 8);

  if (!matches.length) {
    el.suggestions.hidden = true;
    el.suggestions.innerHTML = '';
    return;
  }
  el.suggestions.innerHTML = matches.map((p) => `
    <div class="gw-suggestion" data-player-id="${p.playerId}">
      <img src="${p.headshot}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span>${escapeHtml(p.name)}</span>
      <span class="gw-suggestion-team">${escapeHtml(p.team)}</span>
    </div>
  `).join('');
  el.suggestions.hidden = false;
  // Clicking a suggestion guesses it immediately — no separate "Guess"
  // click needed for the mouse flow (the button/Enter path below still
  // covers keyboard-typed exact matches).
  Array.from(el.suggestions.querySelectorAll('.gw-suggestion')).forEach((node) => {
    node.addEventListener('click', () => {
      const id = Number(node.getAttribute('data-player-id'));
      const player = state.poolById.get(id);
      selectGuess(player);
      submitGuess();
    });
  });
}

function selectGuess(player) {
  state.selectedGuess = player;
  el.guessInput.value = player.name;
  el.suggestions.hidden = true;
  el.guessBtn.disabled = state.gameOver;
}

function submitGuess() {
  if (state.gameOver || !state.selectedGuess) return;
  const guess = state.selectedGuess;
  state.guesses.push(guess);
  let justWon = false;
  if (guess.playerId === state.mystery.playerId) {
    state.gameOver = true;
    state.won = true;
    justWon = true;
  } else if (state.guesses.length >= MAX_GUESSES) {
    state.gameOver = true;
    state.won = false;
  }
  state.selectedGuess = null;
  el.guessInput.value = '';
  saveState();
  renderBoard();
  if (justWon) {
    spawnConfetti();
    openWinModal(guess);
  }
}

function wireGuessBar() {
  el.guessInput.addEventListener('input', () => {
    state.selectedGuess = null;
    el.guessBtn.disabled = true;
    renderSuggestions(el.guessInput.value);
  });
  el.guessInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.selectedGuess) submitGuess();
    } else if (e.key === 'Escape') {
      el.suggestions.hidden = true;
    }
  });
  document.addEventListener('click', (e) => {
    if (!el.suggestions.contains(e.target) && e.target !== el.guessInput) {
      el.suggestions.hidden = true;
    }
  });
  el.guessBtn.addEventListener('click', submitGuess);
}

// ---------------------------------------------------------------------
// Init + daily reset
// ---------------------------------------------------------------------

/** Loads (or starts fresh) whatever puzzle belongs to TODAY, per the
 *  browser's local calendar date. This is the entire "reset daily"
 *  mechanism: `state.dateKey` is always `todayISO()`, every localStorage
 *  read/write is scoped under that date's own key
 *  (`nhlStats.guessWho.v1.<dateKey>`), and `pickMysteryPlayer()` is a
 *  pure function of (pool, dateKey) — so a NEW date automatically means
 *  no saved entry exists yet, which automatically means a fresh mystery
 *  player and an empty guess list. No explicit "reset" code path is
 *  needed; "today" simply has never been played until it has.
 *  Yesterday's entry is just left behind in localStorage, unused —
 *  harmless, and lets `shareText()` still work if someone looks back at
 *  an old day (not currently exposed in the UI, but the data's there). */
function loadPuzzleForToday() {
  state.dateKey = todayISO();
  const saved = loadSavedState(state.dateKey);
  if (saved && saved.mystery) {
    state.mystery = saved.mystery;
    state.guesses = saved.guesses || [];
    state.gameOver = !!saved.gameOver;
    state.won = !!saved.won;
  } else {
    state.mystery = pickMysteryPlayer(state.pool, state.dateKey);
    state.guesses = [];
    state.gameOver = false;
    state.won = false;
    saveState();
  }
  state.selectedGuess = null;
}

/** The one gap `loadPuzzleForToday()` alone doesn't cover: a tab left
 *  open FROM BEFORE midnight won't notice the calendar date changed
 *  underneath it just by sitting there — `state.dateKey` only gets
 *  re-read on a fresh call. This polls for that and, when the date has
 *  rolled over, reloads today's (new) puzzle live, no manual refresh
 *  needed — clearing any leftover UI (open win modal, confetti, typed
 *  guess) from the puzzle that just ended. */
function checkForNewDay() {
  if (todayISO() === state.dateKey) return;
  closeWinModal();
  closeDivisionsModal();
  el.confettiLayer.innerHTML = '';
  el.guessInput.value = '';
  el.suggestions.hidden = true;
  loadPuzzleForToday();
  renderBoard();
}

async function init() {
  try {
    const standings = await getJSON(`${API_WEB}/v1/standings/now`);
    const teamMeta = buildTeamMeta(standings);
    const pool = await loadPlayerBioPool(teamMeta);
    if (!pool.length) throw new Error('No players loaded');

    state.teamMeta = teamMeta;
    state.pool = pool.filter((p) => p.birthDate && p.heightInInches).sort((a, b) => a.name.localeCompare(b.name));
    state.poolById = new Map(pool.map((p) => [p.playerId, p]));
    loadPuzzleForToday();

    el.subtitle.textContent = `A new player every day · ${state.pool.length.toLocaleString()} players in the pool`;
    el.skeleton.hidden = true;
    el.game.hidden = false;
    el.divisionsBtn.hidden = false;
    wireGuessBar();
    wireWinModal();
    wireDivisionsModal();
    renderBoard();

    // Catch a midnight rollover while this tab stays open: a light
    // interval poll (cheap — just a string compare) plus a check
    // whenever the tab regains focus/visibility, which is when a
    // stale "yesterday" puzzle would actually be noticed.
    setInterval(checkForNewDay, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForNewDay();
    });
    window.addEventListener('focus', checkForNewDay);
  } catch (err) {
    el.skeleton.hidden = true;
    showError(`Couldn't load today's puzzle (${err.message}). Try refreshing.`);
  }
}

init();
