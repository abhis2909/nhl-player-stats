'use strict';

/* ======================================================================
   Fantasy Hub page — Trade Hub. A shared board: every manager posts
   their own trading-block players, players/categories they're looking
   to target, and their current roster; everyone else can see it, same
   "small private league, fully public" spirit as the rest of this
   site's Fantasy Hub data. Replaced the short-lived Yahoo Fantasy
   import (never got the OAuth app approved) — rather than pull a real
   external roster, this just asks each manager to fill theirs in by
   hand, with player identity/search backed by the same live NHL-API
   player pool every other page already uses (data.js's
   loadSeasonData()), not a new data source.

   Read: GET /api/fantasy/public-config?type=trade-hub (public, no
   login — see that file's handleTradeHubRead()). Write: PATCH
   /api/fantasy/session with { type: 'trade-hub', ... } (session
   required, always your own single row — see session.js's
   handleTradeHubSave()).

   Player search reuses trade-analyzer.js's typeahead pattern
   (.fh-player-search/.fh-suggestions/.fh-trade-chip, same CSS) rather
   than reinventing it. */

// Fixed roster layout — key -> { label, count }. Mirrors
// api/fantasy/session.js's TRADE_HUB_ROSTER_SLOTS server-side
// validation; keep the two in sync if this ever changes.
const ROSTER_GROUPS = [
  { key: 'C', label: 'Center', count: 2 },
  { key: 'LW', label: 'Left Wing', count: 2 },
  { key: 'RW', label: 'Right Wing', count: 2 },
  { key: 'D', label: 'Defense', count: 3 },
  { key: 'UTIL', label: 'Util', count: 1 },
  { key: 'G', label: 'Goalie', count: 2 },
  { key: 'BN', label: 'Bench', count: 3 },
  { key: 'IR', label: 'IR+', count: 2 },
];
const ROSTER_SLOT_KEYS = ROSTER_GROUPS.map((g) => g.key);

// What a manager can call a filled roster slot — independent of the
// player's real NHL position (see this file's header comment and the
// hint text in fantasy-hub.html).
const FANTASY_POSITIONS = ['C', 'LW', 'RW', 'D', 'G', 'Util', 'BN', 'IR'];

const MAX_LIST = 40; // matches session.js's TRADE_HUB_MAX_LIST

const thEl = {
  loginHint: document.getElementById('tradeHubLoginHint'),
  loadingNote: document.getElementById('tradeHubLoadingNote'),
  editor: document.getElementById('tradeHubEditor'),
  blockSearch: document.getElementById('blockSearch'),
  blockSuggestions: document.getElementById('blockSuggestions'),
  blockList: document.getElementById('blockList'),
  targetSearch: document.getElementById('targetSearch'),
  targetSuggestions: document.getElementById('targetSuggestions'),
  targetList: document.getElementById('targetList'),
  categoryChecks: document.getElementById('categoryChecks'),
  rosterBuilder: document.getElementById('rosterBuilder'),
  saveBtn: document.getElementById('tradeHubSaveBtn'),
  saveStatus: document.getElementById('tradeHubSaveStatus'),
  board: document.getElementById('tradeHubBoard'),
  boardEmpty: document.getElementById('tradeHubBoardEmpty'),
};

const thState = {
  searchPool: [], // combined skaters+goalies from the live current-season pool
  byId: new Map(),
  myEntry: {
    blockPlayers: [],
    targetPlayers: [],
    targetCategories: new Set(),
    roster: Object.fromEntries(ROSTER_SLOT_KEYS.map((k) => [k, []])),
  },
  allEntries: [],
};

function thEscapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function thHeadshotUrl(playerId) {
  return `https://assets.nhle.com/mugs/nhl/latest/${playerId}.png`;
}

function toPlayerEntry(p) {
  return { nhlPlayerId: p.playerId, name: p.name, team: p.team, pos: p.pos };
}

/* --------------------------- player search --------------------------- */

function thWireSearch(searchInput, suggestionsEl, excludeIds, onPick) {
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { suggestionsEl.hidden = true; suggestionsEl.innerHTML = ''; return; }
    const matches = thState.searchPool
      .filter((p) => !excludeIds().has(p.playerId) && p.name.toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) { suggestionsEl.hidden = true; suggestionsEl.innerHTML = ''; return; }
    suggestionsEl.innerHTML = matches.map((p) => `
      <div class="fh-suggestion" data-player-id="${p.playerId}">
        <img src="${thHeadshotUrl(p.playerId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="fh-suggestion-name">${thEscapeHtml(p.name)}</span>
        <span class="fh-suggestion-meta">${thEscapeHtml(p.pos)} · ${thEscapeHtml(p.team)}</span>
      </div>
    `).join('');
    suggestionsEl.hidden = false;
    suggestionsEl.querySelectorAll('.fh-suggestion').forEach((node) => {
      node.addEventListener('click', () => {
        const player = thState.byId.get(Number(node.dataset.playerId));
        if (player) onPick(player);
        suggestionsEl.hidden = true;
        suggestionsEl.innerHTML = '';
        searchInput.value = '';
        searchInput.focus();
      });
    });
  });
  document.addEventListener('click', (e) => {
    if (!suggestionsEl.contains(e.target) && e.target !== searchInput) suggestionsEl.hidden = true;
  });
}

/* ----------------------- block / target player lists ----------------------- */

function thRenderPlayerList(listEl, entries, onRemove) {
  listEl.innerHTML = entries.map((p) => `
    <li class="fh-trade-chip" data-player-id="${p.nhlPlayerId}">
      <img src="${thHeadshotUrl(p.nhlPlayerId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="fh-chip-name">${thEscapeHtml(p.name)}</span>
      <span class="fh-chip-ovr">${thEscapeHtml(p.pos)}</span>
      <button type="button" aria-label="Remove ${thEscapeHtml(p.name)}">✕</button>
    </li>
  `).join('');
  listEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      onRemove(Number(btn.closest('.fh-trade-chip').dataset.playerId));
    });
  });
}

function thRenderBlock() {
  thRenderPlayerList(thEl.blockList, thState.myEntry.blockPlayers, (id) => {
    thState.myEntry.blockPlayers = thState.myEntry.blockPlayers.filter((p) => p.nhlPlayerId !== id);
    thRenderBlock();
  });
}

function thRenderTargets() {
  thRenderPlayerList(thEl.targetList, thState.myEntry.targetPlayers, (id) => {
    thState.myEntry.targetPlayers = thState.myEntry.targetPlayers.filter((p) => p.nhlPlayerId !== id);
    thRenderTargets();
  });
}

/* ------------------------------ categories ------------------------------ */

function thCategoryCatalog() {
  const seen = new Set();
  const out = [];
  for (const col of [...SKATER_COLUMNS, ...GOALIE_COLUMNS]) { // columns.js
    if (col.synthetic || seen.has(col.id)) continue;
    seen.add(col.id);
    out.push(col);
  }
  return out;
}

function thRenderCategoryChecks() {
  const catalog = thCategoryCatalog();
  thEl.categoryChecks.innerHTML = catalog.map((col) => `
    <label class="check-item" title="${thEscapeHtml(col.label)}">
      <input type="checkbox" value="${col.id}" ${thState.myEntry.targetCategories.has(col.id) ? 'checked' : ''}>
      ${thEscapeHtml(col.short)}
    </label>
  `).join('');
  thEl.categoryChecks.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) thState.myEntry.targetCategories.add(box.value);
      else thState.myEntry.targetCategories.delete(box.value);
    });
  });
}

/* -------------------------------- roster -------------------------------- */

function thRenderRosterBuilder() {
  thEl.rosterBuilder.innerHTML = ROSTER_GROUPS.map((group) => `
    <div class="th-roster-group">
      <h4>${thEscapeHtml(group.label)}</h4>
      ${Array.from({ length: group.count }, (_, i) => `
        <div class="th-roster-slot" data-slot-group="${group.key}" data-slot-index="${i}"></div>
      `).join('')}
    </div>
  `).join('');

  for (const group of ROSTER_GROUPS) {
    for (let i = 0; i < group.count; i++) thRenderRosterSlot(group.key, i);
  }
}

function thRosterSlotEl(groupKey, index) {
  return thEl.rosterBuilder.querySelector(`.th-roster-slot[data-slot-group="${groupKey}"][data-slot-index="${index}"]`);
}

function thAllRosteredIds() {
  const ids = new Set();
  for (const key of ROSTER_SLOT_KEYS) {
    for (const entry of thState.myEntry.roster[key]) if (entry) ids.add(entry.nhlPlayerId);
  }
  return ids;
}

function thRenderRosterSlot(groupKey, index) {
  const slotEl = thRosterSlotEl(groupKey, index);
  if (!slotEl) return;
  const entry = thState.myEntry.roster[groupKey][index];

  if (!entry) {
    slotEl.innerHTML = `
      <div class="fh-player-search th-roster-search">
        <input type="text" placeholder="Search a player…" autocomplete="off">
        <div class="fh-suggestions" hidden></div>
      </div>
    `;
    const input = slotEl.querySelector('input');
    const suggestions = slotEl.querySelector('.fh-suggestions');
    thWireSearch(input, suggestions, thAllRosteredIds, (player) => {
      thState.myEntry.roster[groupKey][index] = { ...toPlayerEntry(player), pos: groupKey === 'BN' || groupKey === 'IR' || groupKey === 'UTIL' ? player.pos : groupKey };
      thRenderRosterSlot(groupKey, index);
    });
    return;
  }

  slotEl.innerHTML = `
    <div class="th-roster-filled">
      <img src="${thHeadshotUrl(entry.nhlPlayerId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="th-roster-name">${thEscapeHtml(entry.name)}</span>
      <select class="th-roster-pos" aria-label="Position for ${thEscapeHtml(entry.name)}">
        ${FANTASY_POSITIONS.map((p) => `<option value="${p}" ${p === entry.pos ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <button type="button" aria-label="Remove ${thEscapeHtml(entry.name)}">✕</button>
    </div>
  `;
  slotEl.querySelector('.th-roster-pos').addEventListener('change', (e) => {
    thState.myEntry.roster[groupKey][index].pos = e.target.value;
  });
  slotEl.querySelector('button').addEventListener('click', () => {
    thState.myEntry.roster[groupKey][index] = null;
    thRenderRosterSlot(groupKey, index);
  });
}

/* ------------------------------ save / load ------------------------------ */

function thApplyEntryToEditor(entry) {
  thState.myEntry.blockPlayers = (entry?.blockPlayers || []).slice();
  thState.myEntry.targetPlayers = (entry?.targetPlayers || []).slice();
  thState.myEntry.targetCategories = new Set(entry?.targetCategories || []);
  const roster = Object.fromEntries(ROSTER_SLOT_KEYS.map((k) => [k, []]));
  for (const group of ROSTER_GROUPS) {
    const saved = (entry?.roster && entry.roster[group.key]) || [];
    roster[group.key] = Array.from({ length: group.count }, (_, i) => saved[i] || null);
  }
  thState.myEntry.roster = roster;

  thRenderBlock();
  thRenderTargets();
  thRenderCategoryChecks();
  thRenderRosterBuilder();
}

async function thSaveMyEntry() {
  thEl.saveBtn.disabled = true;
  thEl.saveStatus.textContent = 'Saving…';
  try {
    const res = await fetch('/api/fantasy/session', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'trade-hub',
        blockPlayers: thState.myEntry.blockPlayers,
        targetPlayers: thState.myEntry.targetPlayers,
        targetCategories: [...thState.myEntry.targetCategories],
        roster: thState.myEntry.roster,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    thEl.saveStatus.textContent = 'Saved ✓';
    await thLoadBoard();
  } catch (err) {
    thEl.saveStatus.textContent = `Couldn't save (${err.message}).`;
  } finally {
    thEl.saveBtn.disabled = false;
    setTimeout(() => { thEl.saveStatus.textContent = ''; }, 4000);
  }
}

/* -------------------------------- board -------------------------------- */

function thRenderBoardPlayerChips(entries) {
  if (!entries.length) return '<span class="admin-hint">—</span>';
  return `<ul class="fh-trade-list th-board-chip-list">${entries.map((p) => `
    <li class="fh-trade-chip">
      <img src="${thHeadshotUrl(p.nhlPlayerId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="fh-chip-name">${thEscapeHtml(p.name)}</span>
      <span class="fh-chip-ovr">${thEscapeHtml(p.pos)}</span>
    </li>
  `).join('')}</ul>`;
}

function thRenderBoardRoster(roster) {
  return `<div class="th-board-roster">${ROSTER_GROUPS.map((group) => {
    const slots = (roster && roster[group.key]) || [];
    const filled = slots.filter(Boolean);
    if (!filled.length) return '';
    return `
      <div class="th-board-roster-group">
        <strong>${thEscapeHtml(group.label)}</strong>
        ${filled.map((p) => `<span class="th-board-roster-entry">${thEscapeHtml(p.name)} <em>(${thEscapeHtml(p.pos)})</em></span>`).join('')}
      </div>
    `;
  }).join('')}</div>`;
}

function thRenderBoard() {
  const entries = thState.allEntries;
  thEl.boardEmpty.hidden = entries.length > 0;
  thEl.board.innerHTML = entries.map((e) => `
    <div class="th-board-card">
      <div class="th-board-card-head">
        ${typeof buildAvatarImg === 'function' ? buildAvatarImg(e.avatarUrl, 36, 'bust') : ''}
        <h3>${thEscapeHtml(e.displayName)}</h3>
      </div>
      <div class="th-board-section">
        <h4>Trading Block</h4>
        ${thRenderBoardPlayerChips(e.blockPlayers || [])}
      </div>
      <div class="th-board-section">
        <h4>Targets</h4>
        ${thRenderBoardPlayerChips(e.targetPlayers || [])}
      </div>
      ${(e.targetCategories || []).length ? `
        <div class="th-board-section">
          <h4>Looking to improve</h4>
          <p>${(e.targetCategories || []).map((id) => thEscapeHtml((thCategoryCatalog().find((c) => c.id === id) || {}).short || id)).join(', ')}</p>
        </div>
      ` : ''}
      <div class="th-board-section">
        <h4>Roster</h4>
        ${thRenderBoardRoster(e.roster)}
      </div>
    </div>
  `).join('');
}

async function thLoadBoard() {
  try {
    const res = await fetch('/api/fantasy/public-config?type=trade-hub');
    const data = await res.json();
    thState.allEntries = (data.ok && data.entries) || [];
  } catch {
    thState.allEntries = [];
  }
  thRenderBoard();
}

/* -------------------------------- boot -------------------------------- */

function thUpdateLoginState() {
  const user = window.fantasyAuth && window.fantasyAuth.getUser();
  thEl.loginHint.hidden = Boolean(user);
  thEl.editor.hidden = !user;
  if (user) {
    const mine = thState.allEntries.find((e) => e.username === user.username);
    thApplyEntryToEditor(mine);
  }
}

// Wired unconditionally at module load — same pattern trade-analyzer.js
// uses, so a hiccup loading the live player pool below doesn't also
// leave the board, save button, and search boxes permanently dead.
thWireSearch(thEl.blockSearch, thEl.blockSuggestions, () => new Set(thState.myEntry.blockPlayers.map((p) => p.nhlPlayerId)), (player) => {
  if (thState.myEntry.blockPlayers.length >= MAX_LIST) return;
  thState.myEntry.blockPlayers.push(toPlayerEntry(player));
  thRenderBlock();
});
thWireSearch(thEl.targetSearch, thEl.targetSuggestions, () => new Set(thState.myEntry.targetPlayers.map((p) => p.nhlPlayerId)), (player) => {
  if (thState.myEntry.targetPlayers.length >= MAX_LIST) return;
  thState.myEntry.targetPlayers.push(toPlayerEntry(player));
  thRenderTargets();
});
thEl.saveBtn.addEventListener('click', thSaveMyEntry);

const thLoginLink = document.getElementById('tradeHubLoginLink');
if (thLoginLink) {
  thLoginLink.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('fhLoginBtn')?.click();
  });
}

async function thLoadPlayerPool() {
  thEl.loadingNote.hidden = false;
  try {
    const seasonData = await loadSeasonData(); // data.js — current season's live player pool
    thState.searchPool = [...seasonData.skaters, ...seasonData.goalies];
    for (const p of thState.searchPool) thState.byId.set(p.playerId, p);
    thEl.loadingNote.hidden = true;
  } catch (err) {
    thEl.loadingNote.textContent = `Couldn't load the player pool (${err.message}).`;
  }
}

async function thInit() {
  await Promise.all([thLoadPlayerPool(), thLoadBoard()]);
  thUpdateLoginState();
}

window.fantasyAuth.ready.then(thUpdateLoginState);
window.fantasyAuth.onChange(thUpdateLoginState);

thInit();
