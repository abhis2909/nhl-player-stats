'use strict';

/* Admin page: lets you pick which stat columns show up on index.html,
   plus drives the sub-tab switching for the other two sections that
   now live on this same page (Range Ratings, Users — see admin.html).
   Reads/writes the same localStorage key as app.js via columns.js.

   Wrapped in an IIFE so its top-level `const el`/etc. don't collide
   with range.js's own top-level `const el` — both scripts load on
   this one page now, sharing the global scope otherwise. */
(function () {
  const el = {
    skaterChecks: document.getElementById('skaterChecks'),
    goalieChecks: document.getElementById('goalieChecks'),
    skaterWarn: document.getElementById('skaterWarn'),
    goalieWarn: document.getElementById('goalieWarn'),
    saveBtn: document.getElementById('saveBtn'),
    resetBtn: document.getElementById('resetBtn'),
    saveStatus: document.getElementById('saveStatus'),
    statusBanner: document.getElementById('statusBanner'),
    jsonBox: document.getElementById('jsonBox'),
    copyJsonBtn: document.getElementById('copyJsonBtn'),
    applyJsonBtn: document.getElementById('applyJsonBtn'),
  };

  let config = loadColumnConfig();

  function checksFor(mode) {
    return mode === 'goalies' ? el.goalieChecks : el.skaterChecks;
  }

  function warnFor(mode) {
    return mode === 'goalies' ? el.goalieWarn : el.skaterWarn;
  }

  function renderChecks() {
    el.skaterChecks.innerHTML = '';
    el.goalieChecks.innerHTML = '';
    for (const col of SKATER_COLUMNS) el.skaterChecks.appendChild(makeCheck('skaters', col));
    for (const col of GOALIE_COLUMNS) el.goalieChecks.appendChild(makeCheck('goalies', col));
    validateSection('skaters');
    validateSection('goalies');
    syncJsonBox();
  }

  function makeCheck(mode, col) {
    const id = `chk-${mode}-${col.id}`;
    const label = document.createElement('label');
    label.className = 'check-item';
    label.htmlFor = id;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = config[mode].includes(col.id);
    input.addEventListener('change', () => {
      const set = new Set(config[mode]);
      if (input.checked) set.add(col.id); else set.delete(col.id);
      config[mode] = Array.from(set);
      validateSection(mode);
      syncJsonBox();
      setStatus('Unsaved changes', false);
    });

    const text = document.createElement('span');
    text.innerHTML = `<strong>${col.short}</strong> — ${escapeHtmlLocal(col.label)}`;

    label.append(input, text);
    return label;
  }

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function validateSection(mode) {
    const empty = config[mode].length === 0;
    warnFor(mode).hidden = !empty;
    el.saveBtn.disabled = config.skaters.length === 0 || config.goalies.length === 0;
    return !empty;
  }

  function syncJsonBox() {
    el.jsonBox.value = JSON.stringify(config, null, 2);
  }

  function setStatus(message, success) {
    el.saveStatus.textContent = message;
    el.saveStatus.style.color = success ? '#59d97c' : 'var(--text-faint)';
  }

  function setChecksFromConfig() {
    for (const col of SKATER_COLUMNS) {
      document.getElementById(`chk-skaters-${col.id}`).checked = config.skaters.includes(col.id);
    }
    for (const col of GOALIE_COLUMNS) {
      document.getElementById(`chk-goalies-${col.id}`).checked = config.goalies.includes(col.id);
    }
    validateSection('skaters');
    validateSection('goalies');
    syncJsonBox();
  }

  /* ---------------------------- events ---------------------------- */

  el.saveBtn.addEventListener('click', () => {
    if (!validateSection('skaters') || !validateSection('goalies')) {
      setStatus('Fix the warnings above first.', false);
      return;
    }
    saveColumnConfig(config);
    setStatus('Saved ✓', true);
    // Range Ratings lives on this same page now — if it's already
    // pulled a delta pool, re-rate it in place so a column change
    // shows up there without a full page reload.
    if (window.__rangeTab) window.__rangeTab.refresh();
  });

  el.resetBtn.addEventListener('click', () => {
    config = defaultColumnConfig();
    resetColumnConfig();
    setChecksFromConfig();
    setStatus('Reset to defaults ✓', true);
    if (window.__rangeTab) window.__rangeTab.refresh();
  });

  document.querySelectorAll('[data-select-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.selectAll;
      config[mode] = columnCatalog(mode).map((c) => c.id);
      setChecksFromConfig();
      setStatus('Unsaved changes', false);
    });
  });

  document.querySelectorAll('[data-select-none]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.selectNone;
      config[mode] = [];
      setChecksFromConfig();
      setStatus('Unsaved changes', false);
    });
  });

  el.copyJsonBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.jsonBox.value);
      setStatus('Copied JSON to clipboard ✓', true);
    } catch {
      el.jsonBox.select();
      setStatus('Select-all applied — copy with Ctrl/Cmd+C', false);
    }
  });

  el.applyJsonBtn.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(el.jsonBox.value);
      const validSkater = new Set(SKATER_COLUMNS.map((c) => c.id));
      const validGoalie = new Set(GOALIE_COLUMNS.map((c) => c.id));
      const skaters = Array.isArray(parsed.skaters) ? parsed.skaters.filter((id) => validSkater.has(id)) : [];
      const goalies = Array.isArray(parsed.goalies) ? parsed.goalies.filter((id) => validGoalie.has(id)) : [];
      config = { skaters, goalies };
      setChecksFromConfig();
      setStatus('JSON applied — remember to Save', false);
    } catch (err) {
      setStatus(`Couldn't parse JSON (${err.message})`, false);
    }
  });

  renderChecks();

  /* ---------------------------------------------------------------
     Sub-tabs: Columns / Range Ratings / Users / Deployment /
     Methodology all live on this one admin-gated page (Range Ratings
     moved here from its own range.html; see fantasy-hub/README.md
     history). Users/Deployment/Methodology's data loads are lazy
     (admin-users.js / admin-deployment.js / admin-projection.js, each
     exposing a window.__adminXTab.ensureLoaded()); Range Ratings' own
     init() runs eagerly same as it always did on range.html.
     --------------------------------------------------------------- */
  const subtabButtons = Array.from(document.querySelectorAll('.admin-subtabs [data-subtab]'));
  const subtabPanels = {
    columns: document.getElementById('subtabColumns'),
    range: document.getElementById('subtabRange'),
    users: document.getElementById('subtabUsers'),
    deployment: document.getElementById('subtabDeployment'),
    projection: document.getElementById('subtabProjection'),
  };

  function showSubtab(name) {
    if (!subtabPanels[name]) return;
    for (const [key, panel] of Object.entries(subtabPanels)) {
      if (panel) panel.hidden = key !== name;
    }
    subtabButtons.forEach((btn) => {
      const active = btn.dataset.subtab === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (name === 'users' && window.__adminUsersTab) window.__adminUsersTab.ensureLoaded();
    if (name === 'deployment' && window.__adminDeploymentTab) window.__adminDeploymentTab.ensureLoaded();
    if (name === 'projection' && window.__adminProjectionTab) window.__adminProjectionTab.ensureLoaded();
  }

  subtabButtons.forEach((btn) => {
    btn.addEventListener('click', () => showSubtab(btn.dataset.subtab));
  });

  // Deep link support, e.g. admin.html?tab=range (range.html now
  // redirects here with that query param — see range.html).
  const requestedTab = new URLSearchParams(location.search).get('tab');
  if (requestedTab) showSubtab(requestedTab);
})();
