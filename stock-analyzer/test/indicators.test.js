import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsi, ema, sma, rma, atr, pivots } from '../public/core/indicators.js';
import { cdcActionZone } from '../public/core/cdc.js';
import { toWeekly, toMonthly, mapClosedHigherTF } from '../public/core/resample.js';
import { demoCandles } from '../public/core/demo.js';

// StockCharts ChartSchool RSI worksheet (Wilder's method) — published reference values.
const SC_CLOSE = [44.3389, 44.0902, 44.1497, 43.6124, 44.2779, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
const SC_RSI = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];

test('RSI matches the StockCharts (Wilder) reference table to 2 decimals', () => {
  const r = rsi(SC_CLOSE, 14);
  for (let i = 0; i < 14; i++) assert.ok(Number.isNaN(r[i]), `warm-up bar ${i} must be NaN`);
  SC_RSI.forEach((v, k) => assert.equal(r[14 + k].toFixed(2), v.toFixed(2), `bar ${14 + k}`));
});

test('EMA is seeded with the SMA of the first n values (TradingView ta.ema)', () => {
  const src = [1, 2, 3, 4, 5, 6];
  const e = ema(src, 3);
  assert.ok(Number.isNaN(e[1]));
  assert.equal(e[2], 2);
  assert.equal(e[3], 0.5 * 4 + 0.5 * 2);
  assert.deepEqual(sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  assert.equal(rma([2, 2, 2, 5], 3)[3], 2 + (5 - 2) / 3);
});

test('ATR of a constant-range series equals that range', () => {
  const n = 40;
  const a = atr(new Array(n).fill(11), new Array(n).fill(9), new Array(n).fill(10), 14);
  assert.ok(Math.abs(a[n - 1] - 2) < 1e-12);
});

test('pivots are reported with their confirmation bar (i + right)', () => {
  const src = [1, 2, 3, 9, 3, 2, 1, 2, 3];
  const p = pivots(src, 2, 2, 'high');
  assert.equal(p.length, 1);
  assert.equal(p[0].i, 3);
  assert.equal(p[0].confirmedAt, 5);
});

test('CDC ActionZone: zones follow the published definition', () => {
  const candles = demoCandles({ days: 600, seed: 3 });
  const cdc = cdcActionZone(candles);
  for (let i = 40; i < candles.length; i++) {
    const { ap, fast, slow, zone } = cdc;
    const expected = fast[i] > slow[i] ? (ap[i] > fast[i] ? 'green' : ap[i] < fast[i] ? 'yellow' : null) : fast[i] < slow[i] ? (ap[i] < fast[i] ? 'red' : ap[i] > fast[i] ? 'blue' : null) : null;
    assert.equal(zone[i], expected, `bar ${i}`);
  }
  // Buy and Sell signals must alternate.
  let last = null;
  cdc.buy.forEach((b, i) => {
    if (b) { assert.notEqual(last, 'buy', `two buys in a row at ${i}`); last = 'buy'; }
    if (cdc.sell[i]) { assert.notEqual(last, 'sell', `two sells in a row at ${i}`); last = 'sell'; }
  });
});

test('weekly/monthly resampling preserves OHLC and volume', () => {
  const d = demoCandles({ days: 300, seed: 9 });
  for (const agg of [toWeekly(d), toMonthly(d)]) {
    let vol = 0;
    for (const b of agg) {
      const slice = d.slice(b.startIdx, b.endIdx + 1);
      assert.equal(b.o, slice[0].o);
      assert.equal(b.c, slice[slice.length - 1].c);
      assert.equal(b.h, Math.max(...slice.map((x) => x.h)));
      assert.equal(b.l, Math.min(...slice.map((x) => x.l)));
      vol += b.v;
    }
    assert.equal(vol, d.reduce((s, x) => s + x.v, 0));
  }
});

test('higher-TF mapping only exposes CLOSED higher bars', () => {
  const d = demoCandles({ days: 120, seed: 1 });
  const w = toWeekly(d);
  const mapped = mapClosedHigherTF(d.length, w, w.map((_, k) => k));
  for (let k = 0; k < w.length; k++) {
    for (let i = w[k].startIdx; i <= w[k].endIdx; i++) assert.equal(mapped[i], k > 0 ? k - 1 : undefined);
  }
});
