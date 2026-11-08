// RSI Divergence — port of TradingView's built-in "RSI Divergence Indicator" logic.
//
// Pivots are found on the RSI line (pivotlow/pivothigh with lbL bars on the left and
// lbR bars on the right) and price is compared at the SAME bars:
//   Regular Bullish : price Lower Low  + RSI Higher Low  -> possible reversal UP
//   Hidden  Bullish : price Higher Low + RSI Lower Low   -> uptrend continuation
//   Regular Bearish : price Higher High + RSI Lower High -> possible reversal DOWN
//   Hidden  Bearish : price Lower High + RSI Higher High -> downtrend continuation
// The two pivots must be between rangeLower and rangeUpper bars apart.
//
// IMPORTANT (no look-ahead): a pivot at bar i is only known at bar i + lbR, so every
// divergence carries `confirmedAt`. Backtests and live signals use confirmedAt, never i.

import { pivots, rsi as rsiFn, isNum } from './indicators.js';

export const DIV_INFO = {
  regularBull: { th: 'Regular Bullish Divergence', short: 'Bull', bias: 1, meaning: 'ราคาทำ Lower Low แต่ RSI ทำ Higher Low → แรงขายอ่อนลง มีโอกาสกลับตัวขึ้น' },
  hiddenBull: { th: 'Hidden Bullish Divergence', short: 'H Bull', bias: 1, meaning: 'ราคาทำ Higher Low แต่ RSI ทำ Lower Low → การย่อตัวในขาขึ้น แนวโน้มขึ้นมีโอกาสไปต่อ' },
  regularBear: { th: 'Regular Bearish Divergence', short: 'Bear', bias: -1, meaning: 'ราคาทำ Higher High แต่ RSI ทำ Lower High → แรงซื้ออ่อนลง มีโอกาสกลับตัวลง' },
  hiddenBear: { th: 'Hidden Bearish Divergence', short: 'H Bear', bias: -1, meaning: 'ราคาทำ Lower High แต่ RSI ทำ Higher High → การเด้งในขาลง แนวโน้มลงมีโอกาสไปต่อ' },
};

export function findDivergences(candles, opts = {}) {
  const { rsiLen = 14, lbL = 5, lbR = 5, rangeLower = 5, rangeUpper = 60, rsiValues } = opts;
  const r = rsiValues || rsiFn(candles.map((b) => b.c), rsiLen);
  const lows = pivots(r, lbL, lbR, 'low');
  const highs = pivots(r, lbL, lbR, 'high');
  const out = [];
  const inRange = (a, b) => {
    const bars = b.i - a.i;
    return bars >= rangeLower && bars <= rangeUpper;
  };
  for (let k = 1; k < lows.length; k++) {
    const a = lows[k - 1];
    const b = lows[k];
    if (!inRange(a, b)) continue;
    const pa = candles[a.i].l;
    const pb = candles[b.i].l;
    let type = null;
    if (pb < pa && b.value > a.value) type = 'regularBull';
    else if (pb > pa && b.value < a.value) type = 'hiddenBull';
    if (type) out.push(make(type, a, b, pa, pb));
  }
  for (let k = 1; k < highs.length; k++) {
    const a = highs[k - 1];
    const b = highs[k];
    if (!inRange(a, b)) continue;
    const pa = candles[a.i].h;
    const pb = candles[b.i].h;
    let type = null;
    if (pb > pa && b.value < a.value) type = 'regularBear';
    else if (pb < pa && b.value > a.value) type = 'hiddenBear';
    if (type) out.push(make(type, a, b, pa, pb));
  }
  out.sort((x, y) => x.confirmedAt - y.confirmedAt);
  return { list: out, rsi: r, params: { rsiLen, lbL, lbR, rangeLower, rangeUpper } };

  function make(type, a, b, pa, pb) {
    // Strength heuristic (0..1): size of the RSI disagreement, plus extreme-zone bonus
    // (bullish pivots from oversold <35, bearish from overbought >65 are the textbook setups).
    const rsiGap = Math.min(1, Math.abs(b.value - a.value) / 15);
    const priceGap = Math.min(1, Math.abs(pb - pa) / Math.max(1e-9, Math.min(pa, pb)) / 0.08);
    const bull = type.endsWith('Bull');
    const extreme = bull ? Math.min(a.value, b.value) < 35 : Math.max(a.value, b.value) > 65;
    const strength = Math.min(1, 0.45 * rsiGap + 0.25 * priceGap + (extreme ? 0.3 : 0));
    return {
      type, i1: a.i, i2: b.i, confirmedAt: b.confirmedAt,
      price1: pa, price2: pb, rsi1: a.value, rsi2: b.value,
      strength, extreme, ...DIV_INFO[type],
    };
  }
}

/** Per-bar arrays (indexed by confirmation bar) for strategies. */
export function divergenceSeries(n, list) {
  const series = { regularBull: new Array(n).fill(null), hiddenBull: new Array(n).fill(null), regularBear: new Array(n).fill(null), hiddenBear: new Array(n).fill(null) };
  for (const d of list) if (d.confirmedAt < n) series[d.type][d.confirmedAt] = d;
  return series;
}

/** Divergences confirmed within the last `bars` bars (most recent first). */
export function recentDivergences(list, lastIdx, bars) {
  return list.filter((d) => d.confirmedAt <= lastIdx && lastIdx - d.confirmedAt <= bars).sort((a, b) => b.confirmedAt - a.confirmedAt);
}

export function rsiState(v) {
  if (!isNum(v)) return { label: '—', bias: 0 };
  if (v >= 80) return { label: 'Overbought รุนแรง (≥80)', bias: -1 };
  if (v >= 70) return { label: 'Overbought (≥70)', bias: -0.5 };
  if (v > 55) return { label: 'โมเมนตัมขาขึ้น (>55)', bias: 0.5 };
  if (v >= 45) return { label: 'กลาง (45–55)', bias: 0 };
  if (v > 30) return { label: 'โมเมนตัมขาลง (<45)', bias: -0.5 };
  if (v > 20) return { label: 'Oversold (≤30)', bias: 0.5 };
  return { label: 'Oversold รุนแรง (≤20)', bias: 1 };
}
