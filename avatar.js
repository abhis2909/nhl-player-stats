'use strict';

/* ======================================================================
   Fantasy Hub — shared avatar renderer. One function, buildAvatarImg(url,
   sizePx), used everywhere an avatar shows up (fantasy-auth.js's header
   widget, fantasy-hub.js's Trade Analyzer/Recent Transactions/My Avatar
   panels) so every page renders it identically.

   Avatars are commissioner-managed pixel-art images, not a live
   self-serve upload feature (no upload endpoint exists, and the site's
   already at Vercel Hobby's 12-function cap) — the workflow is: the
   site owner sends Claude a photo/reference image per manager in chat,
   Claude saves the actual PNG under /avatars (served as a plain static
   file, same as any other image on the site) and points that manager's
   account at it via fantasy-hub/scripts/set-avatar.js. Swappable any
   time during the season by just running that script again with a new
   URL — see its header comment.

   `url` is whatever's stored on User.avatarUrl (prisma/schema.prisma) —
   a site-relative path or a full external URL. null/missing, or a URL
   that fails to load, renders a plain placeholder silhouette instead of
   a blank/broken image.
   ====================================================================== */

const PLACEHOLDER_SVG = `<svg viewBox="0 0 16 20" style="display:block" role="img" aria-hidden="true">
  <rect width="16" height="20" fill="#232d3b"/>
  <circle cx="8" cy="7" r="4" fill="#5b6470"/>
  <path d="M2 19c0-4 2.7-6.5 6-6.5S14 15 14 19z" fill="#5b6470"/>
</svg>`;

function escapeAttr(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function placeholderSpan(size) {
  return `<span class="fh-avatar-img" style="width:${size}px;height:${size}px;display:inline-block;overflow:hidden;border-radius:8px;">${PLACEHOLDER_SVG}</span>`;
}

// Referenced by the inline onerror handler below — a broken/unreachable
// avatarUrl falls back to the same silhouette as "not set" rather than
// the browser's default broken-image icon.
window.__avatarImgError = function avatarImgError(imgEl, size) {
  imgEl.outerHTML = placeholderSpan(size);
};

/** Builds a self-contained <img> (or a placeholder <span><svg>) for one
 *  avatar. `url` — User.avatarUrl, or null/undefined for "not set yet".
 *  `sizePx` — rendered width in CSS pixels; height matches (avatar
 *  images are expected square, or at least framed square by
 *  object-fit: cover here). */
function buildAvatarImg(url, sizePx) {
  const size = Number(sizePx) > 0 ? Number(sizePx) : 40;
  if (!url) return placeholderSpan(size);
  return `<img class="fh-avatar-img" src="${escapeAttr(url)}" alt="" width="${size}" height="${size}" loading="lazy" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;display:inline-block;" onerror="window.__avatarImgError(this, ${size})">`;
}
