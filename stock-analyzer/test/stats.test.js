import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, normInv, tPValueOneSided, probabilisticSharpe, randomEntryTest, mulberry32, bootstrapMean } from '../public/core/stats.js';
import { analyzeNews, scoreText } from '../public/core/sentiment.js';
import { parseCsv } from '../public/core/csv.js';

test('normal CDF / inverse are accurate', () => {
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  for (const p of [0.001, 0.05, 0.3, 0.5, 0.9, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
});

test('Student t p-values match tables', () => {
  assert.ok(Math.abs(tPValueOneSided(2.228, 10) - 0.025) < 5e-4); // t(0.975, 10) = 2.228
  assert.ok(Math.abs(tPValueOneSided(1.645, 1e6) - 0.05) < 5e-4);
  assert.ok(Math.abs(tPValueOneSided(0, 7) - 0.5) < 1e-9);
});

test('PSR is ~0.5 for zero-mean noise and high for a strong positive drift', () => {
  const r = mulberry32(1);
  const noise = Array.from({ length: 2000 }, () => normInv(r()) * 0.01);
  const m = noise.reduce((s, x) => s + x, 0) / noise.length;
  const centred = noise.map((x) => x - m);
  assert.ok(Math.abs(probabilisticSharpe(centred) - 0.5) < 0.05);
  assert.ok(probabilisticSharpe(noise.map((x) => x + 0.003)) > 0.99);
});

test('random-entry test: perfect hindsight gets p≈0, random timing does not', () => {
  const r = mulberry32(9);
  const logOpen = [0];
  for (let i = 1; i < 3000; i++) logOpen.push(logOpen[i - 1] + normInv(r()) * 0.01);
  // cheater: enters before every 10-bar window that rises the most
  const trades = [];
  for (let i = 0; i + 10 < 3000; i += 30) {
    let best = i; for (let j = i; j < i + 20 && j + 10 < 3000; j++) if (logOpen[j + 10] - logOpen[j] > logOpen[best + 10] - logOpen[best]) best = j;
    trades.push({ entryIdx: best, exitIdx: best + 10 });
  }
  const actual = trades.reduce((s, t) => s + logOpen[t.exitIdx] - logOpen[t.entryIdx], 0);
  const cheat = randomEntryTest(logOpen, trades, actual, 0);
  assert.ok(cheat.p < 0.01, `cheater p=${cheat.p}`);
  // honest random trades: p-values should not be systematically tiny
  let small = 0;
  for (let s = 0; s < 20; s++) {
    const rr = mulberry32(100 + s);
    const tr = [];
    for (let i = 0; i + 10 < 3000; i += 30) { const e = i + Math.floor(rr() * 19); tr.push({ entryIdx: e, exitIdx: e + 10 }); }
    const act = tr.reduce((a, t) => a + logOpen[t.exitIdx] - logOpen[t.entryIdx], 0);
    if (randomEntryTest(logOpen, tr, act, 0, { iters: 300, seed: s }).p < 0.05) small++;
  }
  assert.ok(small <= 4, `random strategies flagged significant ${small}/20 times`);
});

test('bootstrap 95% CI: correct width, contains the sample mean, ~95% coverage of the true mean', () => {
  let covered = 0;
  const N = 60;
  for (let s = 0; s < N; s++) {
    const r = mulberry32(1000 + s);
    const a = Array.from({ length: 200 }, () => 0.01 + normInv(r()) * 0.02);
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const b = bootstrapMean(a, { iters: 1000, seed: s });
    assert.ok(b.lo < m && m < b.hi);
    const se = 0.02 / Math.sqrt(200);
    assert.ok(Math.abs((b.hi - b.lo) / (2 * 1.96 * se) - 1) < 0.2, 'CI width ≈ 2 × 1.96 × SE');
    if (b.lo < 0.01 && 0.01 < b.hi) covered++;
  }
  assert.ok(covered / N >= 0.85, `coverage ${covered}/${N}`);
});

test('sentiment: polarity, negation and Thai keywords', () => {
  assert.ok(scoreText('Apple beats estimates, shares surge to record').score > 0.3);
  assert.ok(scoreText('Company misses guidance, stock plunges').score < -0.3);
  assert.ok(scoreText('Regulator did not approve the deal').score < 0);
  assert.ok(scoreText('Fed raises interest rates amid inflation fears').score < 0, 'rate hike is negative for equities');
  assert.ok(scoreText('Central bank cuts rates to support growth').score > 0, 'rate cut is positive for equities');
  assert.ok(scoreText('Morgan Stanley cuts price target on Tesla').score < 0);
  assert.ok(scoreText('Company raises full-year guidance').score > 0);
  assert.ok(scoreText('ธนาคารกลางขึ้นดอกเบี้ย').score < 0);
  assert.ok(scoreText('หุ้นร่วงหนัก ขาดทุนต่อเนื่อง').score < 0);
  assert.ok(scoreText('กำไรเพิ่ม แนะนำซื้อ').score > 0);
  const now = Date.UTC(2026, 0, 10);
  const n = analyzeNews([
    { title: 'Fed raises interest rates amid inflation fears', publishedAt: now - 86400000 },
    { title: 'Analyst upgrade: price target raised', publishedAt: now - 3600000 },
  ], now);
  assert.ok(n.factors.some((f) => f.key === 'macro'));
  assert.ok(n.factors.some((f) => f.key === 'analyst'));
  assert.ok(Number.isFinite(n.horizons.short.score));
});

test('CSV import handles common formats and rejects junk', () => {
  const rows = ['Date,Open,High,Low,Close,Adj Close,Volume'];
  for (let i = 0; i < 40; i++) rows.push(`2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:0${i % 10}:00,${10 + i},${11 + i},${9 + i},"${10.5 + i}",${10.4 + i},"1,000"`);
  const c = parseCsv(rows.join('\n'));
  assert.ok(c.length >= 30);
  assert.ok(c.every((b) => b.h >= b.l && b.v === 1000));
  assert.throws(() => parseCsv('foo,bar\n1,2\n3,4'), /Date/);
});
