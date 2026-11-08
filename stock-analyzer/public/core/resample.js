// Timeframe aggregation (multi-timeframe / "กราฟซ้อนกราฟ").
// Every aggregated bar records startIdx/endIdx into the source array so a
// higher-timeframe value can be mapped back to lower-timeframe bars WITHOUT
// look-ahead (only fully-closed higher bars are visible to the lower bars).

const DAY = 86400000;

function localParts(tMs, tzOffsetSec) {
  const d = new Date(tMs + tzOffsetSec * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours() };
}

/** Key of the ISO week (Monday start) for a local date. */
function weekKey(tMs, tzOffsetSec) {
  const p = localParts(tMs, tzOffsetSec);
  const dayIdx = Math.floor(Date.UTC(p.y, p.m, p.day) / DAY);
  const mondayOffset = (p.wd + 6) % 7; // 0 = Monday
  return dayIdx - mondayOffset;
}

function monthKey(tMs, tzOffsetSec) {
  const p = localParts(tMs, tzOffsetSec);
  return p.y * 12 + p.m;
}

function dayKey(tMs, tzOffsetSec) {
  const p = localParts(tMs, tzOffsetSec);
  return Math.floor(Date.UTC(p.y, p.m, p.day) / DAY);
}

/**
 * Generic aggregation by key function.
 * @returns {Array<{t,o,h,l,c,v,startIdx,endIdx}>}
 */
export function aggregate(candles, keyFn) {
  const out = [];
  let cur = null;
  let curKey = null;
  for (let i = 0; i < candles.length; i++) {
    const b = candles[i];
    const k = keyFn(b.t, i);
    if (cur && k === curKey) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v || 0;
      cur.endIdx = i;
      if (b.adj !== undefined) cur.adj = b.adj;
    } else {
      if (cur) out.push(cur);
      cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, startIdx: i, endIdx: i };
      if (b.adj !== undefined) cur.adj = b.adj;
      curKey = k;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function toWeekly(daily, tzOffsetSec = 0) {
  return aggregate(daily, (t) => weekKey(t, tzOffsetSec));
}

export function toMonthly(daily, tzOffsetSec = 0) {
  return aggregate(daily, (t) => monthKey(t, tzOffsetSec));
}

/** Hourly -> 4H: blocks of 4 consecutive hourly bars within the same local trading day. */
export function to4H(hourly, tzOffsetSec = 0) {
  let lastDay = null;
  let n = 0;
  let block = 0;
  return aggregate(hourly, (t) => {
    const d = dayKey(t, tzOffsetSec);
    if (d !== lastDay) { lastDay = d; n = 0; block++; } else if (n % 4 === 0) block++;
    n++;
    return block;
  });
}

/**
 * Is the last aggregated bar still forming (its period contains `nowMs`)?
 * Used to warn that weekly / monthly signals on the last bar can still change.
 */
export function lastBarForming(tf, lastT, nowMs, tzOffsetSec = 0) {
  if (tf === '1W') return weekKey(lastT, tzOffsetSec) === weekKey(nowMs, tzOffsetSec);
  if (tf === '1M') return monthKey(lastT, tzOffsetSec) === monthKey(nowMs, tzOffsetSec);
  if (tf === '1D') return dayKey(lastT, tzOffsetSec) === dayKey(nowMs, tzOffsetSec);
  return false;
}

/**
 * Map higher-TF values onto lower-TF bars using only COMPLETED higher bars.
 * For lower bar i inside higher bar k, the visible value is higherValues[k - 1].
 */
export function mapClosedHigherTF(lowerLen, higherBars, higherValues) {
  const out = new Array(lowerLen).fill(undefined);
  for (let k = 0; k < higherBars.length; k++) {
    const hb = higherBars[k];
    const val = k > 0 ? higherValues[k - 1] : undefined;
    for (let i = hb.startIdx; i <= hb.endIdx && i < lowerLen; i++) out[i] = val;
  }
  return out;
}

/** Same as above but for display: the higher-TF value as known at the end of each lower bar (forming bar included). */
export function mapHigherTFStepped(lowerLen, higherBars, higherValues) {
  const out = new Array(lowerLen).fill(undefined);
  for (let k = 0; k < higherBars.length; k++) {
    const hb = higherBars[k];
    for (let i = hb.startIdx; i <= hb.endIdx && i < lowerLen; i++) out[i] = higherValues[k];
  }
  return out;
}

/** Estimate bars per year from timestamps (handles 5-day vs 7-day markets). */
export function barsPerYear(candles) {
  if (candles.length < 3) return 252;
  const years = (candles[candles.length - 1].t - candles[0].t) / (365.25 * DAY);
  if (years <= 0) return 252;
  return (candles.length - 1) / years;
}

/** Apply dividend/split adjustment using adjusted close (total-return series). */
export function adjustCandles(candles) {
  return candles.map((b) => {
    if (typeof b.adj !== 'number' || !Number.isFinite(b.adj) || !b.c) return { ...b };
    const r = b.adj / b.c;
    return { ...b, o: b.o * r, h: b.h * r, l: b.l * r, c: b.adj };
  });
}
