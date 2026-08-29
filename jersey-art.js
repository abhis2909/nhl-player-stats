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
   array of them (BOS/BUF below) — every entry, regardless of team, is
   one card in the pool a pull draws from (see packs.js's ALL_PLAYERS):
   there's no per-team pull step anymore, so a team with zero entries
   just never comes up rather than falling back to a placeholder. Mirrors
   the shape admin-jerseys.js's localStorage-staged entries use (see
   admin.html) — copy an entry here verbatim to actually publish it
   site-wide, since this file (not localStorage) is what every visitor
   loads.

   `tier` currently defaults every entry below to 'silver' — real
   classification (which of these are actually Diamond-caliber legends
   vs. depth guys) is a call for the site owner to make via Admin ->
   Jerseys, not something to guess at here. Until that happens, every
   pull will land on silver (TIER_WEIGHTS' by-far-largest bucket) since
   nothing's classified into the other five yet — expected, not a bug. */
const JERSEY_ART = {
  BOS: [
    // borr-transparent.png (the original placeholder used since this
    // feature's earliest prototype) was deleted directly on GitHub and
    // replaced with a properly-published, correctly-tagged upload.
    { name: 'Bobby Orr — #4', image: 'jerseys/bos-bobby-orr.png', tier: 'silver' },
    // Published via Admin -> Jerseys with the team dropdown left on its
    // default (Anaheim) — the jersey itself is unmistakably Boston
    // (black/gold, ORR #4), so it's filed here rather than under ANA.
    // Filename kept as originally published (ana-bobby-orr.png); only
    // this registry entry's team placement was corrected.
    { name: 'Bobby Orr — #4 (alt)', image: 'jerseys/ana-bobby-orr.png', tier: 'silver' },
    { name: 'Ray Bourque — #77', image: 'jerseys/bos-ray-bourque.png', tier: 'silver' },
  ],
  BUF: [
    { name: 'Perreault — #11', image: 'jerseys/buf-perreault-11.png', tier: 'silver' },
    { name: 'Hasek — #39', image: 'jerseys/buf-hasek-39.png', tier: 'silver' },
    { name: 'Lafontaine — #16', image: 'jerseys/buf-lafontaine-16.png', tier: 'silver' },
    { name: 'Gare — #18', image: 'jerseys/buf-gare-18.png', tier: 'silver' },
    { name: 'Andreychuk — #26', image: 'jerseys/buf-andreychuk-26.png', tier: 'silver' },
    { name: 'Ruff — #22', image: 'jerseys/buf-ruff-22.png', tier: 'silver' },
    { name: 'Ramsay — #14', image: 'jerseys/buf-ramsay-14.png', tier: 'silver' },
    { name: 'Martin — #7', image: 'jerseys/buf-martin-7.png', tier: 'silver' },
    { name: 'Robert — #8', image: 'jerseys/buf-robert-8.png', tier: 'silver' },
    { name: 'Miller — #30', image: 'jerseys/buf-miller-30.png', tier: 'silver' },
    { name: 'Vanek — #26', image: 'jerseys/buf-vanek-26.png', tier: 'silver' },
    { name: 'Drury — #23', image: 'jerseys/buf-drury-23.png', tier: 'silver' },
    { name: 'Briere — #48', image: 'jerseys/buf-briere-48.png', tier: 'silver' },
    { name: 'Pominville — #29', image: 'jerseys/buf-pominville-29.png', tier: 'silver' },
    { name: 'Afinogenov — #61', image: 'jerseys/buf-afinogenov-61.png', tier: 'silver' },
    { name: 'Roy — #9', image: 'jerseys/buf-roy-9.png', tier: 'silver' },
    { name: 'Thompson — #72', image: 'jerseys/buf-thompson-72.png', tier: 'silver' },
    { name: 'Schoenfeld — #6', image: 'jerseys/buf-schoenfeld-6.png', tier: 'silver' },
    { name: 'Korab — #4', image: 'jerseys/buf-korab-4.png', tier: 'silver' },
    { name: 'Dahlin — #26', image: 'jerseys/buf-dahlin-26.png', tier: 'silver' },
  ],
};
