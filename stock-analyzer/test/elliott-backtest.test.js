import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countElliott } from '../public/core/elliott.js';
import { runBacktest, buyAndHold } from '../public/core/backtest.js';
import { validateStrategy } from '../public/core/validation.js';
import { analyzeAll } from '../public/core/analyze.js';
import { demoCandles } from '../public/core/demo.js';

const P = (type, i, price) => ({ type, i, price, confirmedAt: i + 1 });

test('Elliott: a textbook impulse is counted as complete 5 waves (in wave A)', () => {
  // 0=100, 1=120 (+20), 2=108 (60% retrace), 3=140 (1.6x... ), 4=132, 5=152
  const pts = [P('H', 0, 115), P('L', 10, 100), P('H', 20, 120), P('L', 30, 108), P('H', 50, 140.4), P('L', 60, 132), P('H', 75, 152)];
  const ew = countElliott({ pivots: pts, tentative: { type: 'L', i: 80, price: 146, tentative: true } });
  assert.ok(ew.best, 'should find a count');
  const full = ew.all.find((c) => c.k === 5 && c.direction === 'up');
  assert.ok(full, 'complete up impulse should be among valid counts');
  assert.ok(full.rules.every((r) => r.pass));
  assert.equal(full.current.wave, 'A');
  assert.equal(full.invalidation, 152);
});

test('Elliott: wave 4 overlapping wave 1 is rejected (rule R4)', () => {
  const pts = [P('L', 0, 100), P('H', 10, 120), P('L', 20, 108), P('H', 30, 150), P('L', 40, 118), P('H', 50, 160)];
  const ew = countElliott({ pivots: pts, tentative: null });
  assert.ok(!(ew.all || []).some((c) => c.k === 5 && c.direction === 'up' && c.labels[0].i === 0));
});

test('Elliott: wave 3 can never be the shortest (rule R3)', () => {
  // L1 = 20, L3 = 15, L5 = 30 -> invalid
  const pts = [P('L', 0, 100), P('H', 10, 120), P('L', 20, 110), P('H', 30, 125), P('L', 40, 121), P('H', 50, 151)];
  const ew = countElliott({ pivots: pts, tentative: null });
  assert.ok(!(ew.all || []).some((c) => c.k === 5 && c.labels[0].i === 0 && c.direction === 'up'));
});

function synth(closes) {
  return closes.map((c, i) => ({ t: Date.UTC(2020, 0, 1) + i * 86400000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 }));
}

test('backtest fills at the NEXT bar open and charges costs on both sides', () => {
  const c = synth([10, 10, 10, 11, 12, 13, 14, 15]);
  c[2].o = 10; c[3].o = 11; c[6].o = 14;
  const entry = c.map((_, i) => i === 2); // signal at close of bar 2
  const exit = c.map((_, i) => i === 5); // signal at close of bar 5
  const r = runBacktest(c, { entry, exit }, { feePct: 0.1, slipPct: 0, from: 0 });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryIdx, 3, 'entry at bar 3 (open), not bar 2 close');
  assert.equal(t.exitIdx, 6);
  const expected = (1 - 0.001) * (14 / 11) * (1 - 0.001) - 1;
  assert.ok(Math.abs(t.ret - expected) < 1e-12, `${t.ret} vs ${expected}`);
});

test('stop loss gapping through fills at the (worse) open', () => {
  const c = synth([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  c[16] = { ...c[16], o: 80, h: 81, l: 79, c: 80 };
  const entry = c.map((_, i) => i === 14);
  const exit = c.map(() => false);
  const r = runBacktest(c, { entry, exit }, { feePct: 0, slipPct: 0, atrStopMult: 2, from: 0 });
  assert.equal(r.trades[0].reason, 'stop');
  assert.equal(r.trades[0].exitPrice, 80);
});

test('buy & hold equals the open-to-close price ratio minus costs', () => {
  const c = synth([10, 12, 9, 15, 20]);
  const r = buyAndHold(c, { feePct: 0, slipPct: 0 });
  assert.ok(Math.abs(r.metrics.totalReturn - (20 / 12 - 1)) < 1e-12);
});

test('validation pipeline runs end-to-end and produces a graded scorecard', () => {
  const d = demoCandles({ days: 2000, seed: 5 });
  for (const strategy of ['cdc', 'rsiDiv', 'confluence']) {
    const v = validateStrategy(d, { strategy });
    assert.ok(['strong', 'moderate', 'weak'].includes(v.grade));
    assert.equal(v.checks.length, 8);
    assert.ok(v.full.equity.length > 1000);
    assert.ok(v.dsr.nTrials >= 20);
    assert.ok(v.wf && v.wf.windows.length >= 3);
  }
});

test('multi-timeframe analysis produces three horizons with transparent components', () => {
  const a = analyzeAll({ daily: demoCandles({ days: 2600, seed: 42 }), meta: {}, settings: { nowMs: Date.UTC(2030, 0, 1) } });
  for (const k of ['short', 'medium', 'long']) {
    const hz = a.horizons[k];
    assert.ok(!hz.insufficient);
    const sum = hz.components.reduce((s, c) => s + c.value, 0);
    assert.ok(Math.abs(Math.max(-100, Math.min(100, sum)) - hz.score) < 1e-6, 'score must equal the sum of its components');
    assert.ok(hz.plan && hz.plan.stop.price < a.lastPrice);
  }
});
