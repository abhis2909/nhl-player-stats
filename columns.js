'use strict';

/* ======================================================================
   Shared stat-column catalog + persistence, used by both index.html
   (to decide which columns to render) and admin.html (to build the
   picker UI). Keeping this in one file means both pages always agree
   on ids, labels, and formatting.
   ====================================================================== */

const COLUMN_STORAGE_KEY = 'nhlStats.columnConfig.v1';

const SKATER_COLUMNS = [
  { id: 'goals', short: 'G', label: 'Goals' },
  { id: 'assists', short: 'A', label: 'Assists' },
  { id: 'points', short: 'PTS', label: 'Points' },
  { id: 'plusMinus', short: '+/-', label: 'Plus / Minus' },
  { id: 'ppGoals', short: 'PPG', label: 'Power-Play Goals' },
  { id: 'ppPoints', short: 'PPP', label: 'Power-Play Points' },
  { id: 'shGoals', short: 'SHG', label: 'Shorthanded Goals' },
  { id: 'shPoints', short: 'SHP', label: 'Shorthanded Points' },
  { id: 'gameWinningGoals', short: 'GWG', label: 'Game-Winning Goals' },
  { id: 'otGoals', short: 'OTG', label: 'Overtime Goals' },
  { id: 'pim', short: 'PIM', label: 'Penalty Minutes' },
  { id: 'sog', short: 'SOG', label: 'Shots on Goal' },
  { id: 'shootingPct', short: 'SH%', label: 'Shooting %', fmt: 'pct1' },
  { id: 'gamesPlayed', short: 'GP', label: 'Games Played' },
  { id: 'hits', short: 'HIT', label: 'Hits' },
  { id: 'blocks', short: 'BLK', label: 'Blocked Shots' },
  { id: 'giveaways', short: 'GV', label: 'Giveaways' },
  { id: 'takeaways', short: 'TK', label: 'Takeaways' },
  { id: 'faceoffPct', short: 'FO%', label: 'Faceoff Win %', fmt: 'pct1' },
];

const GOALIE_COLUMNS = [
  { id: 'wins', short: 'W', label: 'Wins' },
  { id: 'losses', short: 'L', label: 'Losses' },
  { id: 'otLosses', short: 'OTL', label: 'Overtime Losses' },
  { id: 'gaa', short: 'GAA', label: 'Goals Against Average', fmt: 'dec2' },
  { id: 'savePct', short: 'SV%', label: 'Save %', fmt: 'save3' },
  { id: 'saves', short: 'SV', label: 'Saves' },
  { id: 'shutouts', short: 'SO', label: 'Shutouts' },
  { id: 'gamesPlayed', short: 'GP', label: 'Games Played' },
  { id: 'gamesStarted', short: 'GS', label: 'Games Started' },
  { id: 'goalsAgainst', short: 'GA', label: 'Goals Against' },
  { id: 'shotsAgainst', short: 'SA', label: 'Shots Against' },
];

const DEFAULT_COLUMN_CONFIG = {
  skaters: ['goals', 'assists', 'ppPoints', 'shPoints', 'pim', 'hits', 'blocks', 'sog'],
  goalies: ['wins', 'gaa', 'saves', 'shutouts'],
};

function columnCatalog(mode) {
  return mode === 'goalies' ? GOALIE_COLUMNS : SKATER_COLUMNS;
}

function defaultColumnConfig() {
  return { skaters: [...DEFAULT_COLUMN_CONFIG.skaters], goalies: [...DEFAULT_COLUMN_CONFIG.goalies] };
}

function loadColumnConfig() {
  const fallback = defaultColumnConfig();
  let raw;
  try {
    raw = localStorage.getItem(COLUMN_STORAGE_KEY);
  } catch {
    return fallback; // localStorage unavailable (privacy mode, etc.)
  }
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    const validSkater = new Set(SKATER_COLUMNS.map((c) => c.id));
    const validGoalie = new Set(GOALIE_COLUMNS.map((c) => c.id));
    const skaters = Array.isArray(parsed.skaters) ? parsed.skaters.filter((id) => validSkater.has(id)) : [];
    const goalies = Array.isArray(parsed.goalies) ? parsed.goalies.filter((id) => validGoalie.has(id)) : [];
    return {
      skaters: skaters.length ? skaters : fallback.skaters,
      goalies: goalies.length ? goalies : fallback.goalies,
    };
  } catch {
    return fallback;
  }
}

function saveColumnConfig(config) {
  localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(config));
}

function resetColumnConfig() {
  try { localStorage.removeItem(COLUMN_STORAGE_KEY); } catch { /* ignore */ }
}

/** Formats a raw stat value according to a column's `fmt`. */
function formatColumnValue(col, value) {
  const n = typeof value === 'number' ? value : Number(value) || 0;
  switch (col.fmt) {
    case 'dec2':
      return n.toFixed(2);
    case 'pct1':
      return `${(n * 100).toFixed(1)}%`;
    case 'save3':
      return n.toFixed(3).replace(/^0/, '');
    default:
      return String(n);
  }
}
