// Does the "proof" layer lie? On a pure random walk NO strategy can have a real edge,
// so the validator must (almost) never grade a strategy "strong" there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStrategy } from '../public/core/validation.js';
import { mulberry32, normInv } from '../public/core/stats.js';

function randomWalk(seed, n = 2000) {
  const r = mulberry32(seed);
  const g = () => normInv(Math.min(0.999999, Math.max(0.000001, r())));
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p * Math.exp(0.003 * g());
    const c = o * Math.exp(0.015 * g()); // zero drift, constant volatility, no memory
    out.push({ t: Date.UTC(2015, 0, 1) + i * 86400000 * 1.4, o, h: Math.max(o, c) * (1 + 0.005 * Math.abs(g())), l: Math.min(o, c) * (1 - 0.005 * Math.abs(g())), c, v: 1e6 });
    p = c;
  }
  return out;
}

test('validator does not certify edges that cannot exist (pure random walks)', () => {
  let strong = 0; let permSig = 0; let total = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const d = randomWalk(seed);
    for (const strategy of ['cdc', 'rsiDiv', 'confluence']) {
      const v = validateStrategy(d, { strategy });
      total++;
      if (v.grade === 'strong') strong++;
      if (v.perm && v.perm.p < 0.05) permSig++;
    }
  }
  assert.ok(strong <= 1, `"strong" on random data ${strong}/${total} times`);
  assert.ok(permSig / total <= 0.2, `permutation test significant on random data ${permSig}/${total}`);
});
