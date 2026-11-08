// Core technical indicators — pure functions, shared by browser and Node.
// Conventions
//   * Inputs are plain arrays of numbers; missing values are NaN.
//   * Outputs have the same length as the input; NaN where undefined (warm-up).
//   * Every value at index i depends ONLY on inputs at indices <= i (no look-ahead),
//     except pivot detection, which is explicitly delayed by `right` bars and
//     reports the bar at which it becomes known (`confirmedAt`).
// Formulas follow the TradingView Pine reference implementations so numbers match
// what traders see on their charts (ta.ema / ta.rma / ta.rsi / ta.atr).

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Simple moving average over `period` consecutive valid values. */
export function sma(src, period) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!isNum(v)) { sum = 0; cnt = 0; continue; }
    sum += v; cnt++;
    if (cnt > period) { sum -= src[i - period]; cnt = period; }
    if (cnt === period) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential smoothing with factor `alpha`, seeded by the SMA of the first
 * `period` valid values (Pine: ta.ema / ta.rma). Gaps keep the previous value.
 */
function smooth(src, period, alpha) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  let prev = NaN;
  let seedSum = 0;
  let seedCnt = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!isNum(prev)) {
      if (!isNum(v)) { seedSum = 0; seedCnt = 0; continue; }
      seedSum += v; seedCnt++;
      if (seedCnt === period) { prev = seedSum / period; out[i] = prev; }
      continue;
    }
    if (isNum(v)) prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** EMA: alpha = 2 / (period + 1). */
export const ema = (src, period) => smooth(src, period, 2 / (period + 1));

/** Wilder's moving average (RMA / SMMA): alpha = 1 / period. */
export const rma = (src, period) => smooth(src, period, 1 / period);

/**
 * RSI (J. Welles Wilder, 1978).
 * RS = RMA(gain, n) / RMA(loss, n);  RSI = 100 - 100 / (1 + RS)
 */
export function rsi(close, period = 14) {
  const n = close.length;
  const up = new Array(n).fill(NaN);
  const dn = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (isNum(close[i]) && isNum(close[i - 1])) {
      const ch = close[i] - close[i - 1];
      up[i] = ch > 0 ? ch : 0;
      dn[i] = ch < 0 ? -ch : 0;
    }
  }
  const ru = rma(up, period);
  const rd = rma(dn, period);
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const u = ru[i];
    const d = rd[i];
    if (!isNum(u) || !isNum(d)) continue;
    out[i] = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  }
  return out;
}

/** True range; the first bar uses high - low. */
export function trueRange(high, low, close) {
  const n = close.length;
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const h = high[i];
    const l = low[i];
    if (!isNum(h) || !isNum(l)) continue;
    const pc = i > 0 ? close[i - 1] : NaN;
    out[i] = isNum(pc) ? Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)) : h - l;
  }
  return out;
}

/** Average True Range (Wilder). */
export const atr = (high, low, close, period = 14) => rma(trueRange(high, low, close), period);

/** Rolling highest / lowest over the last `period` bars (inclusive). */
export function highest(src, period) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (isNum(src[j]) && src[j] > m) m = src[j];
    if (m !== -Infinity) out[i] = m;
  }
  return out;
}

export function lowest(src, period) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (isNum(src[j]) && src[j] < m) m = src[j];
    if (m !== Infinity) out[i] = m;
  }
  return out;
}

/** Rolling population standard deviation. */
export function stdev(src, period) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  const m = sma(src, period);
  for (let i = period - 1; i < n; i++) {
    if (!isNum(m[i])) continue;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (src[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

/** (O + H + L + C) / 4 — the CDC ActionZone default source. */
export function ohlc4(c) {
  return c.map((b) => (b.o + b.h + b.l + b.c) / 4);
}

/**
 * Pivot highs/lows (Pine ta.pivothigh / ta.pivotlow semantics).
 * A pivot at bar i needs `left` bars before and `right` bars after it, so it
 * is only KNOWN at bar i + right. Returns [{ i, value, confirmedAt }].
 * Ties: strictly greater than the right side, >= the left side (one pivot per plateau).
 */
export function pivots(src, left, right, kind) {
  const res = [];
  const n = src.length;
  const better = kind === 'high' ? (a, b) => a > b : (a, b) => a < b;
  const betterEq = kind === 'high' ? (a, b) => a >= b : (a, b) => a <= b;
  for (let i = left; i + right < n; i++) {
    const v = src[i];
    if (!isNum(v)) continue;
    let ok = true;
    for (let j = i - left; j < i && ok; j++) if (!isNum(src[j]) || !betterEq(v, src[j])) ok = false;
    for (let j = i + 1; j <= i + right && ok; j++) if (!isNum(src[j]) || !better(v, src[j])) ok = false;
    if (ok) res.push({ i, value: v, confirmedAt: i + right });
  }
  return res;
}

/** Linear-regression slope of the last `period` values ending at i, in % of price per bar. */
export function slopePct(src, i, period) {
  if (i - period + 1 < 0) return NaN;
  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
  for (let k = 0; k < period; k++) {
    const y = src[i - period + 1 + k];
    if (!isNum(y)) return NaN;
    sx += k; sy += y; sxy += k * y; sxx += k * k;
  }
  const slope = (period * sxy - sx * sy) / (period * sxx - sx * sx);
  const mean = sy / period;
  return mean ? (slope / mean) * 100 : NaN;
}

/** Map arrays of candles to column arrays. */
export function columns(candles) {
  return {
    t: candles.map((b) => b.t),
    o: candles.map((b) => b.o),
    h: candles.map((b) => b.h),
    l: candles.map((b) => b.l),
    c: candles.map((b) => b.c),
    v: candles.map((b) => (isNum(b.v) ? b.v : 0)),
  };
}

export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i])) return arr[i];
  return NaN;
}
