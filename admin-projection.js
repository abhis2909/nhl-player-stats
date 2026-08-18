'use strict';

/* Admin page — Projection Methodology sub-tab: lets you tune the
   Stats page's Next-Season Preview and Rest-of-Season projections
   without a code change — the 4 season weights, whether the age curve
   applies, its clip range, and the Rest-of-Season shrinkage constant
   (see projections.js for how these are consumed). Lazy-loaded
   (window.__adminProjectionTab.ensureLoaded()), same pattern as
   admin-users.js / admin-deployment.js / admin-rating.js. */
(function () {
  const loadingEl = document.getElementById('projLoading');
  const errorEl = document.getElementById('projError');
  const formEl = document.getElementById('projForm');
  const w1 = document.getElementById('projW1');
  const w2 = document.getElementById('projW2');
  const w3 = document.getElementById('projW3');
  const w4 = document.getElementById('projW4');
  const weightSumEl = document.getElementById('projWeightSum');
  const ageCurveEnabled = document.getElementById('projAgeCurveEnabled');
  const clipMin = document.getElementById('projClipMin');
  const clipMax = document.getElementById('projClipMax');
  const shrinkage = document.getElementById('projShrinkage');
  const saveBtn = document.getElementById('projSaveBtn');
  const saveStatus = document.getElementById('projSaveStatus');

  // Same defaults as ProjectionSettings' @default()s in prisma/schema.prisma.
  const DEFAULTS = {
    seasonWeights: [0.4, 0.3, 0.2, 0.1], ageCurveEnabled: true,
    multiplierClipMin: 0.85, multiplierClipMax: 1.15, restOfSeasonShrinkageGames: 20,
  };

  let loaded = false;

  function applyToForm(settings) {
    const s = settings || DEFAULTS;
    [w1, w2, w3, w4].forEach((el, i) => { el.value = s.seasonWeights[i]; });
    ageCurveEnabled.checked = s.ageCurveEnabled;
    clipMin.value = s.multiplierClipMin;
    clipMax.value = s.multiplierClipMax;
    shrinkage.value = s.restOfSeasonShrinkageGames ?? DEFAULTS.restOfSeasonShrinkageGames;
    updateWeightSum();
  }

  function updateWeightSum() {
    const sum = [w1, w2, w3, w4].reduce((s, el) => s + (Number(el.value) || 0), 0);
    const ok = Math.abs(sum - 1) < 0.01;
    weightSumEl.textContent = `Weights sum to ${sum.toFixed(2)}${ok ? ' ✓' : ' — must sum to 1 to save'}`;
    weightSumEl.style.color = ok ? '' : 'var(--accent-2, #ff8b96)';
    return ok;
  }

  [w1, w2, w3, w4].forEach((el) => el.addEventListener('input', updateWeightSum));

  saveBtn.addEventListener('click', async () => {
    if (!updateWeightSum()) {
      saveStatus.textContent = 'Fix the weights first.';
      saveStatus.style.color = 'var(--accent-2, #ff8b96)';
      return;
    }
    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving…';
    saveStatus.style.color = '';
    try {
      const res = await fetch('/api/fantasy/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'projection',
          seasonWeights: [w1, w2, w3, w4].map((el) => Number(el.value)),
          ageCurveEnabled: ageCurveEnabled.checked,
          multiplierClipMin: Number(clipMin.value),
          multiplierClipMax: Number(clipMax.value),
          restOfSeasonShrinkageGames: Number(shrinkage.value),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      saveStatus.textContent = 'Saved ✓';
      saveStatus.style.color = '#59d97c';
    } catch (err) {
      saveStatus.textContent = `Couldn't save (${err.message}).`;
      saveStatus.style.color = 'var(--accent-2, #ff8b96)';
    } finally {
      saveBtn.disabled = false;
    }
  });

  async function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    formEl.hidden = true;
    try {
      const res = await fetch('/api/fantasy/admin-settings?type=projection');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      applyToForm(data.settings);
      formEl.hidden = false;
    } catch (err) {
      errorEl.textContent = `Couldn't load methodology settings (${err.message}).`;
      errorEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
    }
  }

  window.__adminProjectionTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      load();
    },
  };
})();
