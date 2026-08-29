'use strict';

/* Jersey art registry — shared between packs.html (packs.js reads it to
   build the pullable pool, ALL_PLAYERS) and admin.html (admin-jerseys.js
   reads it to list every already-published jersey for reclassifying —
   see the "Reclassify Existing Jerseys" section on the Jerseys tab).
   Split out into its own file specifically so admin.html can load just
   this data without pulling in all of packs.js's pack-opening game
   logic (DOM refs it doesn't have, event listeners it doesn't need).

   `name`, `image`, and `tier` all set deliberately (by the Jerseys tab
   on admin.html's "Rarity class" select, or by hand here) rather than
   guessed. A team maps to either one entry (a single object) or an
   array of them — every entry, regardless of team, is one card in the
   pool a pull draws from (see packs.js's ALL_PLAYERS): there's no
   per-team pull step, so a team with zero entries just never comes up
   rather than falling back to a placeholder.

   Cleared out to a clean slate (previously held a handful of BOS/BUF
   test entries, published via Admin -> Jerseys while the pack UI was
   being built) so the full set of team grids about to be uploaded
   doesn't get mixed in with those earlier placeholders. packs.js
   guards against ALL_PLAYERS being empty (disables Open Pack with an
   explanatory note) so packs.html stays functional while this is
   empty. */
const JERSEY_ART = {};
