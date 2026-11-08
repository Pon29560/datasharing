// The single most important property of an honest backtest: a value computed at bar i
// must be identical whether or not future bars exist. We check it by recomputing every
// signal on truncated histories and comparing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoCandles } from '../public/core/demo.js';
import { cdcActionZone } from '../public/core/cdc.js';
import { findDivergences } from '../public/core/divergence.js';
import { zigzag, atrThresholds } from '../public/core/zigzag.js';
import { STRATEGIES } from '../public/core/strategies.js';
import { rsi } from '../public/core/indicators.js';

const full = demoCandles({ days: 1500, seed: 77 });
const cuts = [400, 777, 1003, 1288];

test('CDC zones and signals are prefix-invariant', () => {
  const F = cdcActionZone(full);
  for (const k of cuts) {
    const P = cdcActionZone(full.slice(0, k));
    for (let i = 0; i < k; i++) {
      assert.equal(P.zone[i], F.zone[i]);
      assert.equal(P.buy[i], F.buy[i]);
      assert.equal(P.sell[i], F.sell[i]);
    }
  }
});

test('RSI divergences are known only at confirmedAt and never change afterwards', () => {
  const F = findDivergences(full).list;
  for (const k of cuts) {
    const P = findDivergences(full.slice(0, k)).list;
    const knownInFull = F.filter((d) => d.confirmedAt < k);
    assert.deepEqual(P.map((d) => `${d.type}:${d.i1}:${d.i2}:${d.confirmedAt}`), knownInFull.map((d) => `${d.type}:${d.i1}:${d.i2}:${d.confirmedAt}`));
    for (const d of P) assert.equal(d.confirmedAt, d.i2 + 5);
  }
});

test('ZigZag pivots are prefix-invariant once confirmed', () => {
  const th = atrThresholds(full, 3);
  const F = zigzag(full, th).pivots;
  for (const k of cuts) {
    const P = zigzag(full.slice(0, k), th.slice(0, k)).pivots;
    assert.deepEqual(P, F.filter((p) => p.confirmedAt < k));
    for (const p of P) assert.ok(p.confirmedAt > p.i, 'a swing cannot be confirmed on its own bar');
  }
});

test('every strategy produces prefix-invariant entry/exit signals', () => {
  for (const [key, st] of Object.entries(STRATEGIES)) {
    const ctx = { tf: '1D', tzOffsetSec: 0 };
    const F = st.build(full, st.defaults, ctx);
    for (const k of cuts) {
      const P = st.build(full.slice(0, k), st.defaults, ctx);
      for (let i = 0; i < k; i++) {
        assert.equal(P.entry[i], F.entry[i], `${key} entry @${i} (cut ${k})`);
        assert.equal(P.exit[i], F.exit[i], `${key} exit @${i} (cut ${k})`);
      }
    }
  }
});

test('RSI itself is causal', () => {
  const c = full.map((b) => b.c);
  const F = rsi(c, 14);
  const P = rsi(c.slice(0, 500), 14);
  for (let i = 0; i < 500; i++) assert.ok(Object.is(P[i], F[i]) || Math.abs(P[i] - F[i]) < 1e-12);
});
