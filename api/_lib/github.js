'use strict';

/* Minimal GitHub Contents API client — just enough to create or update
   one file in this repo. Used by admin-settings.js's jersey-image
   publish action (Admin -> Jerseys -> Publish to GitHub); kept as its
   own _lib module (not counted against the Hobby-plan 12-function cap
   — see the other api/_lib/*.js files' underscore-prefix convention)
   in case anything else here ever wants the same "commit a file"
   primitive.

   Needs a GITHUB_TOKEN env var — a fine-grained Personal Access Token
   scoped to just this repo with "Contents: Read and write" permission.
   Nothing here works without it (see requireToken() below); every
   caller gets that as a clear 501-ish error rather than a confusing
   401 from GitHub. GITHUB_REPO ("owner/repo") and GITHUB_TARGET_BRANCH
   are both optional, defaulting to this repo's actual values — override
   only if either ever changes. */

const GITHUB_API = 'https://api.github.com';

function repoTarget() {
  const [owner, repo] = (process.env.GITHUB_REPO || 'abhis2909/nhl-player-stats').split('/');
  return { owner, repo, branch: process.env.GITHUB_TARGET_BRANCH || 'main' };
}

function requireToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const err = new Error('GITHUB_TOKEN is not configured on the server.');
    err.code = 'no_github_token';
    throw err;
  }
  return token;
}

async function ghFetch(path, options = {}) {
  const token = requireToken();
  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

/** Creates or updates one file at `path` (repo-relative, e.g.
 *  "jerseys/bos-orr.png") with `base64Content`, committing directly to
 *  the configured target branch (no PR — same "push straight to the
 *  working branch" flow the rest of this project's git workflow uses).
 *  Looks up the file's current sha first if it already exists, since
 *  GitHub's contents API requires that to update rather than create.
 *  Returns { ok, commitUrl, path } or throws an Error with a message
 *  safe to relay to the client (no token or other internals in it). */
async function putRepoFile(path, base64Content, message) {
  const { owner, repo, branch } = repoTarget();
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const base = `/repos/${owner}/${repo}/contents/${encodedPath}`;

  let sha;
  const existing = await ghFetch(`${base}?ref=${encodeURIComponent(branch)}`);
  if (existing.status === 200) {
    const json = await existing.json();
    sha = json.sha;
  } else if (existing.status !== 404) {
    const detail = await existing.text().catch(() => '');
    throw new Error(`GitHub lookup failed (${existing.status}): ${detail.slice(0, 200)}`);
  }

  const putRes = await ghFetch(base, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64Content, branch, ...(sha ? { sha } : {}) }),
  });
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => '');
    throw new Error(`GitHub commit failed (${putRes.status}): ${detail.slice(0, 200)}`);
  }
  const result = await putRes.json();
  return { ok: true, commitUrl: result.commit?.html_url, path };
}

module.exports = { putRepoFile, repoTarget };
