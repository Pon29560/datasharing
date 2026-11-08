// ZigZag swing detection with an adaptive (ATR-based) reversal threshold.
// A swing high/low is CONFIRMED only when price reverses by the threshold; the bar
// where that happens is recorded as `confirmedAt` so nothing downstream can peek.
// The leg currently in progress is returned separately as `tentative`.

import { atr, isNum } from './indicators.js';

/**
 * Per-bar reversal threshold as a fraction of price: mult * ATR(14) / close,
 * clamped to [minPct, maxPct].
 */
export function atrThresholds(candles, mult = 3, minPct = 0.02, maxPct = 0.35) {
  const a = atr(candles.map((b) => b.h), candles.map((b) => b.l), candles.map((b) => b.c), 14);
  return candles.map((b, i) => {
    const v = isNum(a[i]) && b.c > 0 ? (mult * a[i]) / b.c : NaN;
    if (!isNum(v)) return Math.max(minPct, 0.05);
    return Math.min(maxPct, Math.max(minPct, v));
  });
}

/**
 * @param candles [{h,l}]
 * @param threshold number (fraction) or per-bar array
 * @returns {{pivots: Array<{type:'H'|'L', i:number, price:number, confirmedAt:number}>, tentative: object|null}}
 */
export function zigzag(candles, threshold) {
  const th = (i) => (typeof threshold === 'number' ? threshold : threshold[i]);
  const pivots = [];
  let dir = 0;
  let hi = -Infinity; let hiI = -1;
  let lo = Infinity; let loI = -1;
  for (let i = 0; i < candles.length; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    if (!isNum(h) || !isNum(l)) continue;
    const t = th(i);
    if (dir === 0) {
      if (h > hi) { hi = h; hiI = i; }
      if (l < lo) { lo = l; loI = i; }
      const upOk = i > loI && hi >= lo * (1 + t) && loI < hiI;
      const dnOk = i > hiI && lo <= hi * (1 - t) && hiI < loI;
      if (upOk) {
        // hi/hiI already hold the highest high after loI
        pivots.push({ type: 'L', i: loI, price: lo, confirmedAt: i });
        dir = 1;
      } else if (dnOk) {
        // lo/loI already hold the lowest low after hiI
        pivots.push({ type: 'H', i: hiI, price: hi, confirmedAt: i });
        dir = -1;
      }
    } else if (dir === 1) {
      if (h > hi) { hi = h; hiI = i; } else if (l <= hi * (1 - t)) {
        pivots.push({ type: 'H', i: hiI, price: hi, confirmedAt: i });
        dir = -1; lo = l; loI = i;
      }
    } else if (l < lo) { lo = l; loI = i; } else if (h >= lo * (1 + t)) {
      pivots.push({ type: 'L', i: loI, price: lo, confirmedAt: i });
      dir = 1; hi = h; hiI = i;
    }
  }
  let tentative = null;
  if (dir === 1 && hiI >= 0) tentative = { type: 'H', i: hiI, price: hi, tentative: true };
  if (dir === -1 && loI >= 0) tentative = { type: 'L', i: loI, price: lo, tentative: true };
  return { pivots, tentative };
}

/** Pivots known at bar `idx` (confirmedAt <= idx). */
export function pivotsKnownAt(zz, idx) {
  return zz.pivots.filter((p) => p.confirmedAt <= idx);
}

export const SENSITIVITY = {
  fine: { mult: 2, label: 'ละเอียด (คลื่นย่อย)' },
  standard: { mult: 3, label: 'มาตรฐาน' },
  coarse: { mult: 5, label: 'หยาบ (คลื่นใหญ่)' },
};
