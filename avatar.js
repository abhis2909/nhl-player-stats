'use strict';

/* ======================================================================
   Fantasy Hub — shared avatar renderer. One function, buildAvatarImg(url,
   sizePx, variant), used everywhere an avatar shows up (fantasy-auth.js's
   header widget, fantasy-hub.js's Trade Analyzer/Recent Transactions/My
   Avatar panels) so every page renders it identically.

   Avatars are commissioner-managed pixel-art images, not a live
   self-serve upload feature (no upload endpoint exists, and the site's
   already at Vercel Hobby's 12-function cap) — the workflow is: the
   site owner sends Claude a photo/reference image per manager in chat,
   Claude saves the actual file under /avatars (served as a plain static
   file, same as any other image on the site; the background is
   recolored to match the site's dark theme before it's committed — see
   the "site owner asked for X" notes in project memory, not something
   this file does at render time) and points that manager's account at
   it via fantasy-hub/scripts/set-avatar.js. Swappable any time during
   the season by just running that script again with a new URL.

   `url` is whatever's stored on User.avatarUrl (prisma/schema.prisma) —
   a site-relative path or a full external URL. null/missing, or a URL
   that fails to load, renders a plain placeholder silhouette instead of
   a blank/broken image.

   `variant` — 'full' (default): the whole image, letting a full-body
   portrait show head-to-shoe (used by the "My Avatar" panel). 'bust':
   cropped/zoomed to roughly the head-and-shoulders region, circular —
   used anywhere space is tight (the header widget) where a full body
   would just read as a tiny smudge.
   ====================================================================== */

const PLACEHOLDER_SVG = `<svg viewBox="0 0 16 20" style="display:block" role="img" aria-hidden="true">
  <rect width="16" height="20" fill="#232d3b"/>
  <circle cx="8" cy="7" r="4" fill="#5b6470"/>
  <path d="M2 19c0-4 2.7-6.5 6-6.5S14 15 14 19z" fill="#5b6470"/>
</svg>`;

// How far to zoom in for the 'bust' crop, anchored at top-center — tuned
// against these full-body chibi portraits (head+shoulders occupy
// roughly the top ~40% of the source image, centered horizontally).
const BUST_SCALE = 2.2;

function escapeAttr(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function placeholderSpan(size, variant) {
  const radius = variant === 'bust' ? '50%' : '8px';
  return `<span class="fh-avatar-img" style="width:${size}px;height:${size}px;display:inline-block;overflow:hidden;border-radius:${radius};">${PLACEHOLDER_SVG}</span>`;
}

// Referenced by the inline onerror handler below — a broken/unreachable
// avatarUrl falls back to the same silhouette as "not set" rather than
// the browser's default broken-image icon.
window.__avatarImgError = function avatarImgError(imgEl, size, variant) {
  imgEl.parentElement.outerHTML = placeholderSpan(size, variant);
};

/** Builds a self-contained avatar element (or a placeholder silhouette)
 *  for one avatar. `url` — User.avatarUrl, or null/undefined for "not
 *  set yet". `sizePx` — rendered width AND height in CSS pixels (always
 *  square, regardless of variant — 'bust' just crops+zooms into that
 *  square, it doesn't change its footprint). `variant` — 'full' | 'bust'
 *  (default 'full'), see the file header comment. */
function buildAvatarImg(url, sizePx, variant) {
  const size = Number(sizePx) > 0 ? Number(sizePx) : 40;
  const v = variant === 'bust' ? 'bust' : 'full';
  if (!url) return placeholderSpan(size, v);

  const imgStyle = v === 'bust'
    ? `width:100%;height:100%;object-fit:cover;transform:scale(${BUST_SCALE});transform-origin:50% 0%;display:block;`
    : `width:100%;height:100%;object-fit:cover;display:block;`;
  const radius = v === 'bust' ? '50%' : '8px';

  return `<span class="fh-avatar-img" style="width:${size}px;height:${size}px;display:inline-block;overflow:hidden;border-radius:${radius};background:#131a24;">` +
    `<img src="${escapeAttr(url)}" alt="" loading="lazy" style="${imgStyle}" onerror="window.__avatarImgError(this, ${size}, '${v}')">` +
    `</span>`;
}
