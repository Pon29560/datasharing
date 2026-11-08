// "Prove it" layer: everything needed to decide whether a backtest result is an edge
// or an accident — in-sample vs out-of-sample, walk-forward optimisation, parameter
// robustness, random-entry permutation test, bootstrap, Probabilistic & Deflated Sharpe.

import { runBacktest, buyAndHold } from './backtest.js';
import { STRATEGIES, buildSignals } from './strategies.js';
import { atr as atrFn } from './indicators.js';
import { randomEntryTest, bootstrapMean, monteCarloTrades, deflatedSharpe, tTest, mean, std } from './stats.js';
import { barsPerYear } from './resample.js';

function gridCombos(grid) {
  const out = [];
  for (const xv of grid.x.values) for (const yv of grid.y.values) out.push({ [grid.x.key]: xv, [grid.y.key]: yv });
  return out;
}

/**
 * Full validation run.
 * @param opts { strategy, params, feePct, slipPct, atrStopMult, oosFrac, tf, tzOffsetSec, warmup }
 */
export function validateStrategy(candles, opts) {
  const { strategy, params = {}, feePct = 0.1, slipPct = 0.05, atrStopMult = 0, oosFrac = 0.3, tf = '1D', tzOffsetSec = 0 } = opts;
  const n = candles.length;
  const bpy = barsPerYear(candles);
  const warmup = Math.min(Math.max(opts.warmup ?? 60, 30), Math.floor(n / 4));
  const ctx = { tf, tzOffsetSec };
  const st = STRATEGIES[strategy];
  const p = { ...st.defaults, ...params };
  const atr = atrFn(candles.map((b) => b.h), candles.map((b) => b.l), candles.map((b) => b.c), 14);
  const base = { feePct, slipPct, atrStopMult, bpy, atr };
  const sig = buildSignals(strategy, candles, p, ctx);
  if (!sig) throw new Error('พารามิเตอร์ไม่ถูกต้อง (เช่น Fast ต้องน้อยกว่า Slow)');

  const from = warmup;
  const to = n - 1;
  const full = runBacktest(candles, sig, { ...base, from, to });
  const bh = buyAndHold(candles, { ...base, from, to });

  // ---- In-sample / out-of-sample (fixed parameters; the split is chronological) ----
  const split = Math.floor(from + (to - from) * (1 - oosFrac));
  const isRes = runBacktest(candles, sig, { ...base, from, to: split });
  const oosRes = runBacktest(candles, sig, { ...base, from: split, to });
  const oosBH = buyAndHold(candles, { ...base, from: split, to });

  // ---- Parameter robustness grid (also the trial set for the Deflated Sharpe) ----
  const combos = gridCombos(st.grid);
  const cache = new Map();
  const sigFor = (pp) => {
    const key = JSON.stringify(pp);
    if (!cache.has(key)) cache.set(key, buildSignals(strategy, candles, { ...p, ...pp }, ctx));
    return cache.get(key);
  };
  const heat = combos.map((pp) => {
    const s = sigFor(pp);
    if (!s) return { params: pp, valid: false };
    const r = runBacktest(candles, s, { ...base, from, to });
    const m = mean(r.returns); const sd = std(r.returns);
    return { params: pp, valid: true, totalReturn: r.metrics.totalReturn, sharpe: r.metrics.sharpe, maxDD: r.metrics.maxDrawdown, trades: r.metrics.trades, srPerBar: sd > 0 ? m / sd : NaN };
  });
  const validHeat = heat.filter((h) => h.valid);
  const profitableShare = validHeat.length ? validHeat.filter((h) => h.totalReturn > 0).length / validHeat.length : NaN;
  const beatBHShare = validHeat.length ? validHeat.filter((h) => h.totalReturn > bh.metrics.totalReturn).length / validHeat.length : NaN;
  const dsr = deflatedSharpe(full.returns, validHeat.map((h) => h.srPerBar));

  // ---- Walk-forward optimisation: optimise on a rolling train window, trade the next window ----
  const wf = walkForward(candles, strategy, p, combos, base, ctx, { from, to, bpy, sigFor });

  // ---- Statistical tests on trades ----
  const tradeRets = full.trades.map((t) => t.ret);
  const logOpen = candles.map((b) => Math.log(b.o));
  const costLog = -2 * Math.log(1 - (feePct + slipPct) / 100);
  const timingLog = full.trades.reduce((s, t) => s + logOpen[t.exitIdx] - logOpen[t.entryIdx] - costLog, 0);
  const perm = randomEntryTest(logOpen, full.trades, timingLog, costLog, { from: from + 1, to });
  const boot = bootstrapMean(tradeRets);
  const mc = monteCarloTrades(tradeRets);
  const tt = tTest(tradeRets);

  // ---- Evidence scorecard ----
  const checks = [
    { key: 'sample', name: 'จำนวนเทรดพอสำหรับสถิติ (≥ 30)', pass: full.metrics.trades >= 30, value: `${full.metrics.trades} เทรด`, why: 'ตัวอย่างน้อยเกินไป ผลลัพธ์อาจเป็นแค่ความบังเอิญ' },
    { key: 'oos', name: 'กำไรในช่วง Out-of-Sample (ข้อมูลที่ไม่เคยเห็น)', pass: oosRes.metrics.totalReturn > 0 && oosRes.metrics.trades > 0, value: fmtPct(oosRes.metrics.totalReturn), why: 'ระบบที่ดีต้องทำกำไรกับข้อมูลใหม่ ไม่ใช่แค่ข้อมูลที่ใช้สร้าง' },
    { key: 'perm', name: 'ดีกว่าการเข้าแบบสุ่ม (p < 0.05)', pass: !!perm && perm.p < 0.05, value: perm ? `p = ${perm.p.toFixed(3)}` : 'n/a', why: 'ทดสอบว่า “จังหวะ” เข้า/ออกมีความหมาย ไม่ใช่ได้กำไรเพราะตลาดขึ้นเฉยๆ' },
    { key: 'psr', name: 'Probabilistic Sharpe ≥ 95%', pass: full.metrics.psr >= 0.95, value: fmtPct(full.metrics.psr), why: 'ความน่าจะเป็นที่ Sharpe จริง > 0 เมื่อคิดความเบ้/หางอ้วนของผลตอบแทน' },
    { key: 'dsr', name: 'Deflated Sharpe ≥ 95% (หักผลของการลองหลายพารามิเตอร์)', pass: dsr.dsr >= 0.95, value: fmtPct(dsr.dsr), why: `ลองมา ${dsr.nTrials} ชุดพารามิเตอร์ — ยิ่งลองมากยิ่งมีโอกาสเจอผลดีโดยบังเอิญ` },
    { key: 'robust', name: 'พารามิเตอร์ข้างเคียงกำไรด้วย (≥ 70% ของตาราง)', pass: profitableShare >= 0.7, value: fmtPct(profitableShare), why: 'ถ้ากำไรเฉพาะค่าเดียว = Overfitting' },
    { key: 'wf', name: 'Walk-Forward ทำกำไร (เลือกพารามิเตอร์จากอดีตแล้วเทรดอนาคต)', pass: !!wf && wf.oosReturn > 0, value: wf ? fmtPct(wf.oosReturn) : 'ข้อมูลไม่พอ', why: 'จำลองการใช้งานจริง: ไม่รู้อนาคตตอนเลือกพารามิเตอร์' },
    { key: 'risk', name: 'ความเสี่ยงต่อผลตอบแทนดีกว่า Buy & Hold (Calmar หรือ Sharpe)', pass: (full.metrics.calmar > bh.metrics.calmar) || (full.metrics.sharpe > bh.metrics.sharpe), value: `Sharpe ${num(full.metrics.sharpe)} vs ${num(bh.metrics.sharpe)}`, why: 'ถ้าไม่ดีกว่าถือเฉยๆ ก็ไม่คุ้มที่จะเทรด' },
  ];
  const passed = checks.filter((c) => c.pass).length;
  const critical = ['oos', 'perm', 'dsr'].every((k) => checks.find((c) => c.key === k).pass);
  const grade = passed >= 7 && critical ? 'strong' : passed >= 5 && checks.find((c) => c.key === 'oos').pass ? 'moderate' : 'weak';

  return {
    strategy, strategyName: st.name, params: p, bpy, warmup,
    full, bh, isRes, oosRes, oosBH, split,
    grid: { def: st.grid, cells: heat, profitableShare, beatBHShare },
    dsr, wf, perm, boot, mc, tTest: tt,
    checks, passed, grade,
  };
}

function walkForward(candles, strategy, p, combos, base, ctx, { from, to, bpy, sigFor }) {
  const train = Math.round(bpy * 3);
  const test = Math.round(bpy * 1);
  if (to - from < train + test) return null;
  const windows = [];
  let eq = 1;
  const curve = [];
  for (let s = from; s + train + 1 < to; s += test) {
    const trEnd = s + train;
    const teEnd = Math.min(to, trEnd + test);
    let best = null;
    for (const pp of combos) {
      const sg = sigFor(pp);
      if (!sg) continue;
      const r = runBacktest(candles, sg, { ...base, from: s, to: trEnd });
      const score = Number.isFinite(r.metrics.sharpe) ? r.metrics.sharpe : -Infinity;
      if (!best || score > best.score) best = { pp, score, trainReturn: r.metrics.totalReturn };
    }
    if (!best) break;
    const r = runBacktest(candles, sigFor(best.pp), { ...base, from: trEnd, to: teEnd });
    for (let k = 1; k < r.equity.length; k++) { eq *= r.equity[k] / r.equity[k - 1]; curve.push({ i: trEnd + k, eq }); }
    windows.push({ trainFrom: candles[s].t, trainTo: candles[trEnd].t, testTo: candles[teEnd].t, params: best.pp, trainSharpe: best.score, trainReturn: best.trainReturn, testReturn: r.metrics.totalReturn, testTrades: r.metrics.trades });
    if (teEnd >= to) break;
  }
  if (!windows.length) return null;
  const isAnn = mean(windows.map((w) => w.trainReturn)) / 3;
  const oosAnn = mean(windows.map((w) => w.testReturn));
  return { windows, curve, oosReturn: eq - 1, efficiency: isAnn !== 0 ? oosAnn / isAnn : NaN, trainYears: 3, testYears: 1 };
}

function fmtPct(v) { return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—'; }
function num(v) { return Number.isFinite(v) ? v.toFixed(2) : '—'; }
