'use strict';

/* Admin page — Jerseys sub-tab: turns a jersey photo into the
   transparent-background PNG the Player Jersey Packs stage wants
   (see packs.js's JERSEY_ART / buildJerseyPiece), entirely client-side
   — no upload, no server round-trip. This is a PREPARATION tool, not a
   publish pipeline: there's no live backend to write into the repo
   (see jerseys/README.md), so it ends at "download this PNG + here's
   the code to paste" rather than actually landing the file on the
   site. "Staged" entries are localStorage only, one browser, purely so
   the person doing this doesn't lose track of names/teams they've
   already processed mid-session.

   The background-removal algorithm (border-seeded flood fill, tolerant
   of a gradual halo/vignette a flat chroma-key would miss; a light box
   blur for feathered edges; a strong-alpha bbox for the crop so faint
   stray fringe doesn't leak into it; a final low-alpha floor to kill
   JPEG-ringing noise; edge decontamination against local luminance) is
   the same one used to produce jerseys/borr-transparent.png — that was
   done as a one-off Python script; this is that same approach ported
   to run live in the browser via Canvas, tuned from the same trial run
   against that image.

   The "already transparent" checkbox skips all of that and routes to
   trimTransparent() instead — for a PNG someone already cut out
   elsewhere. Running the flood-fill remover on one of those would be
   actively harmful (it reasons purely off RGB, with no idea the alpha
   channel is already doing the real work, so it could reclassify parts
   of an already-clean cutout as background); trimTransparent() only
   trusts the existing alpha and crops the excess margin.

   Lazy-loaded (window.__adminJerseysTab.ensureLoaded()). */
(function () {
  const TEAMS = [
    ['ANA', 'Anaheim Ducks'], ['BOS', 'Boston Bruins'], ['BUF', 'Buffalo Sabres'],
    ['CGY', 'Calgary Flames'], ['CAR', 'Carolina Hurricanes'], ['CHI', 'Chicago Blackhawks'],
    ['COL', 'Colorado Avalanche'], ['CBJ', 'Columbus Blue Jackets'], ['DAL', 'Dallas Stars'],
    ['DET', 'Detroit Red Wings'], ['EDM', 'Edmonton Oilers'], ['FLA', 'Florida Panthers'],
    ['LAK', 'Los Angeles Kings'], ['MIN', 'Minnesota Wild'], ['MTL', 'Montreal Canadiens'],
    ['NSH', 'Nashville Predators'], ['NJD', 'New Jersey Devils'], ['NYI', 'New York Islanders'],
    ['NYR', 'New York Rangers'], ['OTT', 'Ottawa Senators'], ['PHI', 'Philadelphia Flyers'],
    ['PIT', 'Pittsburgh Penguins'], ['SJS', 'San Jose Sharks'], ['SEA', 'Seattle Kraken'],
    ['STL', 'St. Louis Blues'], ['TBL', 'Tampa Bay Lightning'], ['TOR', 'Toronto Maple Leafs'],
    ['UTA', 'Utah Mammoth'], ['VAN', 'Vancouver Canucks'], ['VGK', 'Vegas Golden Knights'],
    ['WSH', 'Washington Capitals'], ['WPG', 'Winnipeg Jets'],
  ];

  const STORAGE_KEY = 'adm_jersey_staged_v1';
  const MAX_DIMENSION = 700; // downscale anything bigger, for speed — matches the scale jerseys/borr.jpg was processed at

  const el = {
    teamSelect: document.getElementById('jerseyTeamSelect'),
    nameInput: document.getElementById('jerseyNameInput'),
    fileInput: document.getElementById('jerseyFileInput'),
    processingNote: document.getElementById('jerseyProcessingNote'),
    previewRow: document.getElementById('jerseyPreviewRow'),
    originalImg: document.getElementById('jerseyOriginalImg'),
    outCanvas: document.getElementById('jerseyOutCanvas'),
    downloadBtn: document.getElementById('jerseyDownloadBtn'),
    stageBtn: document.getElementById('jerseyStageBtn'),
    saveStatus: document.getElementById('jerseySaveStatus'),
    stagedEmpty: document.getElementById('jerseyStagedEmpty'),
    stagedList: document.getElementById('jerseyStagedList'),
    clearStagedBtn: document.getElementById('jerseyClearStagedBtn'),
    alreadyTransparent: document.getElementById('jerseyAlreadyTransparent'),
    opaqueWarning: document.getElementById('jerseyOpaqueWarning'),
  };

  let loaded = false;
  let processedBlob = null; // current processed PNG, ready to download/stage
  let processedThumb = null; // small dataURL for the staged-list thumbnail

  function escapeHtmlLocal(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function slugify(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'jersey';
  }

  function clip8(v) { return Math.max(0, Math.min(255, Math.round(v))); }

  /** Border-seeded flood-fill background removal — see file header.
   *  Returns { canvas } cropped to the strong-alpha content bbox. */
  function removeBackground(imageData) {
    const { width: w, height: h, data } = imageData;
    const n = w * h;
    const bg = new Uint8Array(n);
    const visited = new Uint8Array(n);
    const queue = new Int32Array(n);
    let qHead = 0;
    let qTail = 0;

    const idx = (x, y) => y * w + x;
    const colorAt = (i) => { const p = i * 4; return [data[p], data[p + 1], data[p + 2]]; };

    function seed(x, y) {
      const i = idx(x, y);
      if (!visited[i]) { visited[i] = 1; bg[i] = 1; queue[qTail++] = i; }
    }
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

    const tol = 64; // tuned against jerseys/borr.jpg's flat bg + its darker drop-shadow halo
    while (qHead < qTail) {
      const i = queue[qHead++];
      const x = i % w;
      const y = (i / w) | 0;
      const c0 = colorAt(i);
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = idx(nx, ny);
        if (visited[ni]) continue;
        visited[ni] = 1;
        const c1 = colorAt(ni);
        const dist = Math.abs(c0[0] - c1[0]) + Math.abs(c0[1] - c1[1]) + Math.abs(c0[2] - c1[2]);
        if (dist <= tol) { bg[ni] = 1; queue[qTail++] = ni; }
      }
    }

    // Light 3x3 box blur on the hard 0/255 mask for feathered (not
    // jagged) edges — cheap stand-in for the Gaussian blur the Python
    // version used.
    const alpha0 = new Float32Array(n);
    for (let i = 0; i < n; i++) alpha0[i] = bg[i] ? 0 : 255;
    const alpha = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            sum += alpha0[idx(nx, ny)];
            cnt++;
          }
        }
        alpha[idx(x, y)] = sum / cnt;
      }
    }

    // Strong-alpha bbox (only "clearly foreground" pixels count) so a
    // faint low-alpha fringe at the true border doesn't drag the crop
    // out to the image edge, plus a floor that zeroes anything fainter
    // than that as noise, and decontaminate the rest against local
    // luminance so kept edge pixels don't carry a gray halo.
    const STRONG = 190;
    const FLOOR = 150;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    const out = new Uint8ClampedArray(n * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x, y);
        const p = i * 4;
        let a = alpha[i];
        if (a >= STRONG) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        let r = data[p];
        let g = data[p + 1];
        let b = data[p + 2];
        if (a < FLOOR) {
          a = 0; r = 0; g = 0; b = 0;
        } else if (a < 255) {
          const af = a / 255;
          const lum = (r + g + b) / 3;
          r = clip8((r - (1 - af) * lum) / af);
          g = clip8((g - (1 - af) * lum) / af);
          b = clip8((b - (1 - af) * lum) / af);
        }
        out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = Math.round(a);
      }
    }
    if (x1 < x0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; } // nothing detected as strong-fg — bail to the full frame rather than an empty crop

    const full = new ImageData(out, w, h);
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = w; fullCanvas.height = h;
    fullCanvas.getContext('2d').putImageData(full, 0, 0);

    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const cropped = document.createElement('canvas');
    cropped.width = bw; cropped.height = bh;
    cropped.getContext('2d').drawImage(fullCanvas, x0, y0, bw, bh, 0, 0, bw, bh);
    return cropped;
  }

  /** For a PNG that's already had its background removed elsewhere —
   *  trusts the existing alpha channel completely (no flood fill, no
   *  decontamination, no floor) and only trims the excess transparent
   *  margin down to the real content, same as removeBackground()'s
   *  crop step. Running the flood-fill remover on an image like this
   *  would be actively harmful: it only looks at RGB, not the alpha
   *  that's already doing the real work, so it could reclassify parts
   *  of an already-clean cutout as "background." Returns
   *  { canvas, hasTransparency } — hasTransparency false means nothing
   *  in the file was actually transparent, which the caller surfaces
   *  as a warning rather than silently shipping an opaque "cutout." */
  function trimTransparent(imageData) {
    const { width: w, height: h, data } = imageData;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    let hasTransparency = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a < 250) hasTransparency = true;
        if (a > 5) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; } // fully transparent file — nothing to trim to, bail to the full frame

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = w; srcCanvas.height = h;
    srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const cropped = document.createElement('canvas');
    cropped.width = bw; cropped.height = bh;
    cropped.getContext('2d').drawImage(srcCanvas, x0, y0, bw, bh, 0, 0, bw, bh);
    return { canvas: cropped, hasTransparency };
  }

  function processFile(file) {
    el.processingNote.hidden = false;
    el.previewRow.hidden = true;
    el.downloadBtn.disabled = true;
    el.stageBtn.disabled = true;
    el.opaqueWarning.hidden = true;
    processedBlob = null;
    processedThumb = null;

    const skipRemoval = el.alreadyTransparent.checked;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (Math.max(w, h) > MAX_DIMENSION) {
          const scale = MAX_DIMENSION / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = w; srcCanvas.height = h;
        const sctx = srcCanvas.getContext('2d');
        sctx.drawImage(img, 0, 0, w, h);

        let outCanvas;
        try {
          if (skipRemoval) {
            const { canvas, hasTransparency } = trimTransparent(sctx.getImageData(0, 0, w, h));
            outCanvas = canvas;
            el.opaqueWarning.hidden = hasTransparency;
          } else {
            outCanvas = removeBackground(sctx.getImageData(0, 0, w, h));
          }
        } catch (err) {
          el.processingNote.textContent = `Couldn't process that image: ${err.message}`;
          return;
        }

        el.originalImg.src = reader.result;
        el.outCanvas.width = outCanvas.width;
        el.outCanvas.height = outCanvas.height;
        el.outCanvas.getContext('2d').drawImage(outCanvas, 0, 0);
        el.previewRow.hidden = false;
        el.processingNote.hidden = true;

        outCanvas.toBlob((blob) => {
          processedBlob = blob;
          el.downloadBtn.disabled = false;
          el.stageBtn.disabled = false;
        }, 'image/png');

        // Small thumbnail for the staged-list row, kept modest so a
        // handful of staged entries don't blow past localStorage's
        // per-origin quota (each thumb is a few KB as a dataURL, vs.
        // the full processed PNG which can be 100KB+).
        const thumbCanvas = document.createElement('canvas');
        const thumbSize = 64;
        thumbCanvas.width = thumbSize; thumbCanvas.height = thumbSize;
        const tctx = thumbCanvas.getContext('2d');
        const scale = Math.min(thumbSize / outCanvas.width, thumbSize / outCanvas.height);
        const tw = outCanvas.width * scale;
        const th = outCanvas.height * scale;
        tctx.drawImage(outCanvas, (thumbSize - tw) / 2, (thumbSize - th) / 2, tw, th);
        processedThumb = thumbCanvas.toDataURL('image/png');
      };
      img.onerror = () => { el.processingNote.textContent = "Couldn't load that file as an image."; };
      img.src = reader.result;
    };
    reader.onerror = () => { el.processingNote.textContent = "Couldn't read that file."; };
    reader.readAsDataURL(file);
  }

  function downloadFilename() {
    const team = el.teamSelect.value || 'jersey';
    const name = el.nameInput.value.trim();
    return `${slugify(team)}${name ? '-' + slugify(name) : ''}.png`;
  }

  function downloadProcessed() {
    if (!processedBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(processedBlob);
    a.download = downloadFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function loadStaged() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
  }
  function saveStaged(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function snippetFor(entry) {
    return `  ${entry.team}: { name: '${entry.name.replace(/'/g, "\\'")}', image: 'jerseys/${entry.filename}' },`;
  }

  function renderStaged() {
    const list = loadStaged();
    el.stagedEmpty.hidden = list.length > 0;
    el.stagedList.innerHTML = list.map((entry, i) => `
      <div class="adm-jersey-staged-item" data-index="${i}">
        <div class="adm-jersey-staged-head">
          <img class="adm-jersey-staged-thumb" src="${entry.thumb}" alt="">
          <div class="adm-jersey-staged-info">
            <strong>${escapeHtmlLocal(entry.name)}</strong>
            <span>${escapeHtmlLocal(entry.team)} — ${escapeHtmlLocal(entry.filename)}</span>
          </div>
          <div class="adm-jersey-staged-actions">
            <button type="button" class="link-btn" data-remove="${i}">Remove</button>
          </div>
        </div>
        <textarea class="adm-jersey-staged-snippet" rows="1" readonly onclick="this.select()">${escapeHtmlLocal(snippetFor(entry))}</textarea>
      </div>
    `).join('');
  }

  function stageCurrent() {
    if (!processedThumb) return;
    const team = el.teamSelect.value;
    const name = el.nameInput.value.trim();
    if (!name) {
      el.saveStatus.textContent = 'Give it a name first.';
      setTimeout(() => { el.saveStatus.textContent = ''; }, 2500);
      return;
    }
    const list = loadStaged();
    list.push({ team, name, filename: downloadFilename(), thumb: processedThumb });
    saveStaged(list);
    renderStaged();
    el.saveStatus.textContent = 'Staged. Download the PNG above if you haven’t already.';
    setTimeout(() => { el.saveStatus.textContent = ''; }, 3500);
  }

  function wireEvents() {
    el.fileInput.addEventListener('change', () => {
      const file = el.fileInput.files?.[0];
      if (file) processFile(file);
    });
    el.downloadBtn.addEventListener('click', downloadProcessed);
    el.stageBtn.addEventListener('click', stageCurrent);
    el.clearStagedBtn.addEventListener('click', () => {
      if (!confirm('Clear all staged jersey entries? This only affects this browser.')) return;
      saveStaged([]);
      renderStaged();
    });
    el.stagedList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      const list = loadStaged();
      list.splice(Number(btn.dataset.remove), 1);
      saveStaged(list);
      renderStaged();
    });
  }

  function init() {
    el.teamSelect.innerHTML = TEAMS.map(([abbrev, name]) => `<option value="${abbrev}">${escapeHtmlLocal(name)} (${abbrev})</option>`).join('');
    wireEvents();
    renderStaged();
  }

  window.__adminJerseysTab = {
    ensureLoaded() {
      if (loaded) return;
      loaded = true;
      init();
    },
  };
})();
