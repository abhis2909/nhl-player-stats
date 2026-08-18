# Avatar images

Static image files for Fantasy Hub user avatars — plain files served
directly by Vercel (and `server.js` locally) at `/avatars/<filename>`,
same as any other static asset on this site. Not a live upload feature.

**Workflow**: the site owner sends Claude a reference image per manager
in chat, Claude saves the actual file here (e.g. `avatars/ludo.png`)
and points that manager's account at it with:

```bash
npm run set-avatar -- <username> /avatars/<filename>
```

Swap a manager's look any time during the season by just running that
command again with a new file/URL. `npm run set-avatar -- --clear
<username>` removes it (falls back to the placeholder silhouette).

See `fantasy-hub/scripts/set-avatar.js` and `avatar.js`
(`buildAvatarImg()`) for the render side.
