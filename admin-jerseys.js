'use strict';

/* Admin page — Jerseys sub-tab: prepares jersey art for the Player
   Jersey Packs stage (see packs.js's JERSEY_ART / buildJerseyPiece)
   and, via "Publish to GitHub", commits it straight into this repo's
   jerseys/ folder. Two tools, both entirely client-side (Canvas), no
   upload until Publish is clicked:

   1. Single jersey (this section) — by default the photo is used
      as-is, background included: packs.js now renders jersey art as a
      plain rounded-rect photo card (box-shadow tier glow, no alpha
      masking needed), so there's no requirement for a cutout anymore.
      The "Remove background" checkbox is an opt-in for anyone who
      still wants that floating-cutout look — it runs a border-seeded
      flood fill (tolerant of a gradual halo/vignette a flat chroma-key
      would miss; box blur for feathered edges; a strong-alpha bbox for
      the crop so faint stray fringe doesn't leak into it; a low-alpha
      floor to kill JPEG-ringing noise; edge decontamination against
      local luminance) — originally a one-off Python script (see
      jerseys/borr-transparent.png), ported to run live here.

   2. Grid splitter (below) — for a poster-style sheet of many jerseys
      in one image (e.g. a generated "Top 20" grid): set rows/columns
      and trim margins, preview the slice lines, then cut it into one
      canvas per cell (plain rectangular crops, same as the single-photo
      default — no background removal) so each player just needs its
      team/name confirmed instead of a separate upload.

   Both tools also let you pull in an image already committed to
   jerseys/ (fetchImageFromRepo()) instead of only a fresh upload —
   handy when images get pushed to GitHub directly (no GITHUB_TOKEN
   configured) and you still want to run them through cropping/
   background removal here afterwards. That fetch is same-origin, so
   it works with no token; only Publish needs one. Download always
   works either way — the result is meant to be dragged back into
   GitHub by hand in that case.

   "Staged" entries are localStorage only, one browser, purely so the
   person doing this doesn't lose track of names/teams they've already
   processed mid-session. Lazy-loaded
   (window.__adminJerseysTab.ensureLoaded()). */
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
    publishBtn: document.getElementById('jerseyPublishBtn'),
    stageBtn: document.getElementById('jerseyStageBtn'),
    saveStatus: document.getElementById('jerseySaveStatus'),
    stagedEmpty: document.getElementById('jerseyStagedEmpty'),
    stagedList: document.getElementById('jerseyStagedList'),
    clearStagedBtn: document.getElementById('jerseyClearStagedBtn'),
    removeBg: document.getElementById('jerseyRemoveBackground'),
    repoFilenameInput: document.getElementById('jerseyRepoFilename'),
    repoLoadBtn: document.getElementById('jerseyLoadRepoBtn'),
    repoLoadStatus: document.getElementById('jerseyRepoLoadStatus'),
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

  /** Core processing pipeline, shared by "upload a file" and "load an
   *  existing jerseys/<file> for re-editing" — everything downstream of
   *  having a loaded <img> (downscale, optional background removal,
   *  preview, blob/thumb prep) is identical either way. `originalSrc` is
   *  just what the "Original" preview <img> points at. */
  function processImage(img, originalSrc) {
    el.previewRow.hidden = true;
    el.downloadBtn.disabled = true;
    el.publishBtn.disabled = true;
    el.stageBtn.disabled = true;
    processedBlob = null;
    processedThumb = null;

    const removeBg = el.removeBg.checked;

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

    // Default: used exactly as uploaded (background included) — the
    // pack-opening stage renders jersey art as a plain photo card
    // now, no cutout required. "Remove background" is opt-in for
    // whoever still wants that floating look.
    let outCanvas;
    try {
      outCanvas = removeBg ? removeBackground(sctx.getImageData(0, 0, w, h)) : srcCanvas;
    } catch (err) {
      el.processingNote.hidden = false;
      el.processingNote.textContent = `Couldn't process that image: ${err.message}`;
      return;
    }

    el.originalImg.src = originalSrc;
    el.outCanvas.width = outCanvas.width;
    el.outCanvas.height = outCanvas.height;
    el.outCanvas.getContext('2d').drawImage(outCanvas, 0, 0);
    el.previewRow.hidden = false;
    el.processingNote.hidden = true;

    outCanvas.toBlob((blob) => {
      processedBlob = blob;
      el.downloadBtn.disabled = false;
      el.publishBtn.disabled = false;
      el.stageBtn.disabled = false;
    }, 'image/png');

    // Kept modest (64px) so a handful of staged entries don't blow
    // past localStorage's per-origin quota (each thumb is a few KB
    // as a dataURL, vs. the full processed PNG which can be 100KB+).
    processedThumb = thumbFromCanvas(outCanvas);
  }

  function processFile(file) {
    el.processingNote.hidden = false;
    el.processingNote.textContent = 'Processing…';
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => processImage(img, reader.result);
      img.onerror = () => { el.processingNote.hidden = false; el.processingNote.textContent = "Couldn't load that file as an image."; };
      img.src = reader.result;
    };
    reader.onerror = () => { el.processingNote.hidden = false; el.processingNote.textContent = "Couldn't read that file."; };
    reader.readAsDataURL(file);
  }

  /** Fetches an already-committed image from this site's own /jerseys/
   *  folder (same-origin, so no CORS issue) so it can be re-run through
   *  the same processing pipeline as a fresh upload — for touching up
   *  something you already pushed to GitHub directly, without needing
   *  GITHUB_TOKEN configured to pull it back down. Publish still needs
   *  the token; Download never does. */
  async function fetchImageFromRepo(filename) {
    const path = filename.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`/jerseys/${path}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => reject(new Error("that's not a valid image"));
      img.src = url;
    });
  }

  function teamOptionsHtml() {
    return TEAMS.map(([abbrev, name]) => `<option value="${abbrev}">${escapeHtmlLocal(name)} (${abbrev})</option>`).join('');
  }

  function filenameFor(team, name) {
    return `${slugify(team || 'jersey')}${name ? '-' + slugify(name) : ''}.png`;
  }

  function thumbFromCanvas(canvas, size = 64) {
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = size; thumbCanvas.height = size;
    const tctx = thumbCanvas.getContext('2d');
    const scale = Math.min(size / canvas.width, size / canvas.height);
    const tw = canvas.width * scale;
    const th = canvas.height * scale;
    tctx.drawImage(canvas, (size - tw) / 2, (size - th) / 2, tw, th);
    return thumbCanvas.toDataURL('image/png');
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, 'image/png');
  }

  /** Commits `canvas` to jerseys/<filename> on GitHub via POST
   *  /api/fantasy/admin-settings (type: 'jersey-image' — see that
   *  file's handleJerseyImagePublish()). Image only: this does NOT
   *  touch packs.js's JERSEY_ART, so the snippet below still needs
   *  pasting in by hand (or via Claude) to actually put the published
   *  jersey in the game — see the tab's intro text. Returns
   *  { ok, message } rather than throwing, so callers (single-image or
   *  a grid cell) can show the result inline without a try/catch each. */
  async function publishCanvasToGithub(canvas, filename) {
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const res = await fetch('/api/fantasy/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'jersey-image', filename, dataUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return { ok: true, message: `Published jerseys/${filename}.` };
    } catch (err) {
      return { ok: false, message: `Couldn't publish: ${err.message}` };
    }
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

  function stageEntry(team, name, filename, thumb) {
    const list = loadStaged();
    list.push({ team, name, filename, thumb });
    saveStaged(list);
    renderStaged();
  }

  function downloadProcessed() {
    if (!processedBlob) return;
    downloadCanvas(el.outCanvas, filenameFor(el.teamSelect.value, el.nameInput.value.trim()));
  }

  async function publishToGithub() {
    if (el.outCanvas.width === 0) return;
    el.publishBtn.disabled = true;
    el.saveStatus.textContent = 'Publishing…';
    const filename = filenameFor(el.teamSelect.value, el.nameInput.value.trim());
    const result = await publishCanvasToGithub(el.outCanvas, filename);
    el.saveStatus.textContent = result.ok
      ? `${result.message} Still needs the JERSEY_ART snippet below wired into packs.js.`
      : result.message;
    el.publishBtn.disabled = false;
    setTimeout(() => { el.saveStatus.textContent = ''; }, 8000);
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
    stageEntry(team, name, filenameFor(team, name), processedThumb);
    el.saveStatus.textContent = 'Staged. Download the PNG above if you haven’t already.';
    setTimeout(() => { el.saveStatus.textContent = ''; }, 3500);
  }

  /* ---------------------------------------------------------------
     Grid splitter: upload a poster-style sheet of many jerseys, set
     rows/cols + trim margins, preview the slice lines, cut it into one
     plain rectangular canvas per cell (no background removal — same
     "used as-is" default as the single-photo tool above), then let
     each cell get its own team/name and Download/Publish/Stage,
     reusing the exact same helpers the single-photo flow uses.
     --------------------------------------------------------------- */
  let gridImg = null; // the loaded <img>, source of truth for both the preview and the actual slice (slicing reads pixels straight from this, not from the scaled preview canvas)
  let gridCells = []; // [{ canvas, blob, team, name }] — one per sliced cell, in row-major order

  function gridTrimRect() {
    const top = Number(document.getElementById('gridTrimTop').value) || 0;
    const bottom = Number(document.getElementById('gridTrimBottom').value) || 0;
    const left = Number(document.getElementById('gridTrimLeft').value) || 0;
    const right = Number(document.getElementById('gridTrimRight').value) || 0;
    const rows = Math.max(1, Number(document.getElementById('gridRows').value) || 1);
    const cols = Math.max(1, Number(document.getElementById('gridCols').value) || 1);
    return { top, bottom, left, right, rows, cols };
  }

  /** Draws the loaded grid image plus red gridlines at the current
   *  rows/cols/trim settings, so misalignment (a title bar not fully
   *  trimmed, an off-by-one row) is obvious before committing to a
   *  slice — recomputed live on every input change. */
  function renderGridPreview() {
    if (!gridImg) return;
    const canvas = document.getElementById('gridPreviewCanvas');
    const maxW = 760;
    const scale = Math.min(1, maxW / gridImg.naturalWidth);
    const w = Math.round(gridImg.naturalWidth * scale);
    const h = Math.round(gridImg.naturalHeight * scale);
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(gridImg, 0, 0, w, h);

    const { top, bottom, left, right, rows, cols } = gridTrimRect();
    const x0 = (left / 100) * w;
    const x1 = w - (right / 100) * w;
    const y0 = (top / 100) * h;
    const y1 = h - (bottom / 100) * h;

    ctx.strokeStyle = 'rgba(255, 60, 60, 0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    for (let c = 1; c < cols; c++) {
      const x = x0 + ((x1 - x0) * c) / cols;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const y = y0 + ((y1 - y0) * r) / rows;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }

    document.getElementById('gridPreviewWrap').hidden = false;
    document.getElementById('gridSliceBtn').disabled = false;
  }

  function sliceGrid() {
    if (!gridImg) return;
    const { top, bottom, left, right, rows, cols } = gridTrimRect();
    const W = gridImg.naturalWidth;
    const H = gridImg.naturalHeight;
    const x0 = (left / 100) * W;
    const x1 = W - (right / 100) * W;
    const y0 = (top / 100) * H;
    const y1 = H - (bottom / 100) * H;
    const cellW = (x1 - x0) / cols;
    const cellH = (y1 - y0) / rows;

    gridCells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(cellW);
        canvas.height = Math.round(cellH);
        canvas.getContext('2d').drawImage(
          gridImg,
          x0 + c * cellW, y0 + r * cellH, cellW, cellH,
          0, 0, canvas.width, canvas.height,
        );
        gridCells.push({ canvas, team: TEAMS[0][0], name: '' });
      }
    }
    document.getElementById('gridSliceStatus').textContent = `Sliced into ${gridCells.length} cells.`;
    setTimeout(() => { document.getElementById('gridSliceStatus').textContent = ''; }, 3000);
    renderGridCells();
  }

  function renderGridCells() {
    const list = document.getElementById('gridCellsList');
    list.innerHTML = gridCells.map((cell, i) => `
      <div class="adm-grid-cell" data-index="${i}">
        <div class="adm-jersey-checker"><canvas class="adm-grid-cell-canvas" width="${cell.canvas.width}" height="${cell.canvas.height}"></canvas></div>
        <select class="adm-grid-cell-team" data-cell-team="${i}">${teamOptionsHtml()}</select>
        <input type="text" class="adm-grid-cell-name" data-cell-name="${i}" placeholder="Name / label" value="${escapeHtmlLocal(cell.name)}">
        <div class="adm-grid-cell-actions">
          <button type="button" class="ghost-btn" data-cell-download="${i}">⬇</button>
          <button type="button" class="primary-btn" data-cell-publish="${i}">☁ Publish</button>
          <button type="button" class="ghost-btn" data-cell-stage="${i}">Stage</button>
        </div>
        <span class="adm-grid-cell-status" data-cell-status="${i}"></span>
      </div>
    `).join('');

    // Paint each cell's already-sliced canvas into its display <canvas>
    // (rebuilt fresh by innerHTML above, so this can't be done inline).
    gridCells.forEach((cell, i) => {
      const target = list.querySelector(`.adm-grid-cell[data-index="${i}"] .adm-grid-cell-canvas`);
      target.getContext('2d').drawImage(cell.canvas, 0, 0);
      const teamSelect = list.querySelector(`[data-cell-team="${i}"]`);
      teamSelect.value = cell.team;
    });
  }

  function wireGridEvents() {
    const rowsEl = document.getElementById('gridRows');
    const colsEl = document.getElementById('gridCols');
    const trimTop = document.getElementById('gridTrimTop');
    const trimBottom = document.getElementById('gridTrimBottom');
    const trimLeft = document.getElementById('gridTrimLeft');
    const trimRight = document.getElementById('gridTrimRight');
    [rowsEl, colsEl, trimTop, trimBottom, trimLeft, trimRight].forEach((input) => {
      input.addEventListener('input', renderGridPreview);
    });

    document.getElementById('gridFileInput').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => { gridImg = img; renderGridPreview(); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('gridSliceBtn').addEventListener('click', sliceGrid);

    document.getElementById('gridLoadRepoBtn').addEventListener('click', async () => {
      const input = document.getElementById('gridRepoFilename');
      const status = document.getElementById('gridRepoLoadStatus');
      const filename = input.value.trim().replace(/^\/?jerseys\//, '');
      if (!filename) return;
      status.textContent = 'Loading…';
      try {
        const { img } = await fetchImageFromRepo(filename);
        gridImg = img;
        renderGridPreview();
        status.textContent = `Loaded jerseys/${filename}.`;
        setTimeout(() => { status.textContent = ''; }, 3000);
      } catch (err) {
        status.textContent = `Couldn't load jerseys/${filename} — ${err.message}.`;
      }
    });

    const list = document.getElementById('gridCellsList');
    list.addEventListener('change', (e) => {
      const teamI = e.target.dataset.cellTeam;
      if (teamI !== undefined) { gridCells[Number(teamI)].team = e.target.value; return; }
      const nameI = e.target.dataset.cellName;
      if (nameI !== undefined) { gridCells[Number(nameI)].name = e.target.value; return; }
    });
    list.addEventListener('input', (e) => {
      const nameI = e.target.dataset.cellName;
      if (nameI !== undefined) gridCells[Number(nameI)].name = e.target.value;
    });
    list.addEventListener('click', async (e) => {
      const statusFor = (i) => list.querySelector(`[data-cell-status="${i}"]`);

      const dlBtn = e.target.closest('[data-cell-download]');
      if (dlBtn) {
        const i = Number(dlBtn.dataset.cellDownload);
        const cell = gridCells[i];
        downloadCanvas(cell.canvas, filenameFor(cell.team, cell.name));
        return;
      }

      const stageBtn = e.target.closest('[data-cell-stage]');
      if (stageBtn) {
        const i = Number(stageBtn.dataset.cellStage);
        const cell = gridCells[i];
        if (!cell.name.trim()) { statusFor(i).textContent = 'Give it a name first.'; return; }
        const filename = filenameFor(cell.team, cell.name);
        stageEntry(cell.team, cell.name, filename, thumbFromCanvas(cell.canvas));
        statusFor(i).textContent = 'Staged.';
        return;
      }

      const pubBtn = e.target.closest('[data-cell-publish]');
      if (pubBtn) {
        const i = Number(pubBtn.dataset.cellPublish);
        const cell = gridCells[i];
        pubBtn.disabled = true;
        statusFor(i).textContent = 'Publishing…';
        const filename = filenameFor(cell.team, cell.name);
        const result = await publishCanvasToGithub(cell.canvas, filename);
        statusFor(i).textContent = result.message;
        pubBtn.disabled = false;
      }
    });
  }

  function wireEvents() {
    el.fileInput.addEventListener('change', () => {
      const file = el.fileInput.files?.[0];
      if (file) processFile(file);
    });
    el.downloadBtn.addEventListener('click', downloadProcessed);
    el.publishBtn.addEventListener('click', publishToGithub);
    el.stageBtn.addEventListener('click', stageCurrent);
    el.repoLoadBtn.addEventListener('click', async () => {
      const filename = el.repoFilenameInput.value.trim().replace(/^\/?jerseys\//, '');
      if (!filename) return;
      el.repoLoadStatus.textContent = 'Loading…';
      try {
        const { img, url } = await fetchImageFromRepo(filename);
        processImage(img, url);
        el.repoLoadStatus.textContent = `Loaded jerseys/${filename}.`;
        setTimeout(() => { el.repoLoadStatus.textContent = ''; }, 3000);
      } catch (err) {
        el.repoLoadStatus.textContent = `Couldn't load jerseys/${filename} — ${err.message}.`;
      }
    });
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
    wireGridEvents();
  }

  function init() {
    el.teamSelect.innerHTML = teamOptionsHtml();
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
