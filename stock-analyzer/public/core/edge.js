// Edge study: "when this condition happened before in THIS asset, what happened next?"
// Forward return from the NEXT bar's open to the close h bars later (realistic entry).
// Statistics are reported with sample size; the t-test uses NON-overlapping events
// (spaced >= h bars apart) because overlapping windows inflate significance.

import { cdcActionZone } from './cdc.js';
import { findDivergences, divergenceSeries } from './divergence.js';
import { rsi as rsiFn, ema, isNum } from './indicators.js';
import { fearGreedSeries } from './psychology.js';
import { mean, median, tTest } from './stats.js';

export const HORIZON_BARS = [5, 20, 60];

export function conditionSeries(candles) {
  const n = candles.length;
  const c = candles.map((b) => b.c);
  const cdc = cdcActionZone(candles);
  const r = rsiFn(c, 14);
  const d = findDivergences(candles, { rsiValues: r });
  const s = divergenceSeries(n, d.list);
  const e200 = ema(c, 200);
  const fg = fearGreedSeries(candles).values;
  const recent = (arr, i, k) => { for (let j = Math.max(0, i - k + 1); j <= i; j++) if (arr[j]) return true; return false; };
  return {
    cdcBuy: { th: 'CDC สัญญาณ Buy (เขียวแรก)', test: (i) => cdc.buy[i] },
    cdcSell: { th: 'CDC สัญญาณ Sell (แดงแรก)', test: (i) => cdc.sell[i] },
    cdcGreen: { th: 'CDC อยู่โซนเขียว', test: (i) => cdc.zone[i] === 'green' },
    cdcRed: { th: 'CDC อยู่โซนแดง', test: (i) => cdc.zone[i] === 'red' },
    cdcBlue: { th: 'CDC โซนฟ้า (Pre-Buy)', test: (i) => cdc.zone[i] === 'blue' },
    cdcYellow: { th: 'CDC โซนเหลือง (Pre-Sell)', test: (i) => cdc.zone[i] === 'yellow' },
    bullDiv: { th: 'Regular Bullish Divergence (ยืนยันภายใน 3 แท่ง)', test: (i) => recent(s.regularBull, i, 3) },
    hiddenBullDiv: { th: 'Hidden Bullish Divergence (ภายใน 3 แท่ง)', test: (i) => recent(s.hiddenBull, i, 3) },
    bearDiv: { th: 'Regular Bearish Divergence (ภายใน 3 แท่ง)', test: (i) => recent(s.regularBear, i, 3) },
    rsiOversold: { th: 'RSI < 30', test: (i) => isNum(r[i]) && r[i] < 30 },
    rsiOverbought: { th: 'RSI > 70', test: (i) => isNum(r[i]) && r[i] > 70 },
    aboveEma200: { th: 'ราคาเหนือ EMA200', test: (i) => isNum(e200[i]) && c[i] > e200[i] },
    belowEma200: { th: 'ราคาใต้ EMA200', test: (i) => isNum(e200[i]) && c[i] < e200[i] },
    extremeFear: { th: 'Fear & Greed < 20 (กลัวสุดขีด)', test: (i) => isNum(fg[i]) && fg[i] < 20 },
    extremeGreed: { th: 'Fear & Greed > 80 (โลภสุดขีด)', test: (i) => isNum(fg[i]) && fg[i] > 80 },
  };
}

function fwd(candles, i, h) {
  if (i + h >= candles.length || i + 1 >= candles.length) return NaN;
  return candles[i + h].c / candles[i + 1].o - 1;
}

export function edgeStudy(candles, { horizons = HORIZON_BARS, minEvents = 5 } = {}) {
  const n = candles.length;
  const conds = conditionSeries(candles);
  const baseline = {};
  for (const h of horizons) {
    const all = [];
    for (let i = 0; i + h < n; i++) { const v = fwd(candles, i, h); if (isNum(v)) all.push(v); }
    baseline[h] = { mean: mean(all), win: all.filter((x) => x > 0).length / Math.max(1, all.length), n: all.length };
  }
  const rows = [];
  for (const [key, cd] of Object.entries(conds)) {
    const nowActive = !!cd.test(n - 1);
    const row = { key, th: cd.th, nowActive, h: {} };
    for (const h of horizons) {
      const vals = [];
      const nonOverlap = [];
      let lastTaken = -Infinity;
      for (let i = 0; i + h < n; i++) {
        if (!cd.test(i)) continue;
        const v = fwd(candles, i, h);
        if (!isNum(v)) continue;
        vals.push(v);
        if (i - lastTaken >= h) { nonOverlap.push(v); lastTaken = i; }
      }
      if (vals.length < minEvents) { row.h[h] = { n: vals.length, insufficient: true }; continue; }
      const tt = tTest(nonOverlap.map((v) => v - baseline[h].mean));
      row.h[h] = {
        n: vals.length, nIndependent: nonOverlap.length,
        mean: mean(vals), median: median(vals), win: vals.filter((x) => x > 0).length / vals.length,
        edge: mean(vals) - baseline[h].mean, t: tt.t, p: Number.isFinite(tt.p) ? 2 * Math.min(tt.p, 1 - tt.p) : NaN, // two-sided
      };
    }
    rows.push(row);
  }
  return { baseline, rows, horizons };
}
