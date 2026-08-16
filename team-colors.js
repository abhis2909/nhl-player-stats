'use strict';

/* Approximate NHL primary/secondary brand colors, keyed by team abbrev.
   Used purely for card background theming — tweak any value that looks
   off, it has no effect on data correctness. */

const TEAM_COLORS = {
  ANA: { primary: '#F47A38', secondary: '#111111' },
  BOS: { primary: '#FFB81C', secondary: '#111111' },
  BUF: { primary: '#002654', secondary: '#FCB514' },
  CGY: { primary: '#C8102E', secondary: '#F1BE48' },
  CAR: { primary: '#CC0000', secondary: '#111111' },
  CHI: { primary: '#CF0A2C', secondary: '#111111' },
  COL: { primary: '#6F263D', secondary: '#236192' },
  CBJ: { primary: '#002654', secondary: '#CE1126' },
  DAL: { primary: '#006847', secondary: '#111111' },
  DET: { primary: '#CE1126', secondary: '#111111' },
  EDM: { primary: '#041E42', secondary: '#FF4C00' },
  FLA: { primary: '#C8102E', secondary: '#041E42' },
  LAK: { primary: '#111111', secondary: '#A2AAAD' },
  MIN: { primary: '#154734', secondary: '#A6192E' },
  MTL: { primary: '#AF1E2D', secondary: '#192168' },
  NSH: { primary: '#FFB81C', secondary: '#041E42' },
  NJD: { primary: '#CE1126', secondary: '#111111' },
  NYI: { primary: '#00539B', secondary: '#F47D30' },
  NYR: { primary: '#0038A8', secondary: '#CE1126' },
  OTT: { primary: '#C52032', secondary: '#111111' },
  PHI: { primary: '#F74902', secondary: '#111111' },
  PIT: { primary: '#FCB514', secondary: '#111111' },
  SJS: { primary: '#006D75', secondary: '#111111' },
  SEA: { primary: '#001628', secondary: '#99D9D9' },
  STL: { primary: '#002F87', secondary: '#FCB514' },
  TBL: { primary: '#002868', secondary: '#FFFFFF' },
  TOR: { primary: '#00205B', secondary: '#FFFFFF' },
  UTA: { primary: '#010101', secondary: '#69B3E7' },
  VAN: { primary: '#00205B', secondary: '#00843D' },
  VGK: { primary: '#B4975A', secondary: '#333F42' },
  WSH: { primary: '#C8102E', secondary: '#041E42' },
  WPG: { primary: '#041E42', secondary: '#004C97' },
};

const DEFAULT_TEAM_COLOR = { primary: '#2c3e50', secondary: '#4fb3ff' };

function teamColor(abbrev) {
  return TEAM_COLORS[abbrev] || DEFAULT_TEAM_COLOR;
}
