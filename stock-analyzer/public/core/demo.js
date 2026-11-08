// Deterministic synthetic market data for DEMO mode, offline use and tests.
// Regime-switching geometric random walk with volatility clustering — clearly
// labelled as SIMULATED wherever it is shown.

import { mulberry32, normInv } from './stats.js';

export function demoCandles({ days = 2600, seed = 42, start = 100, interval = 'day', endMs } = {}) {
  const rand = mulberry32(seed);
  const gauss = () => normInv(Math.min(0.999999, Math.max(0.000001, rand())));
  const step = interval === 'hour' ? 3600000 : 86400000;
  const end = endMs ?? Date.UTC(2026, 10, 6, 14, 30);
  const out = [];
  let price = start;
  let regime = 1; // 1 bull, -1 bear
  let vol = 0.015;
  let t = end - days * step * (interval === 'hour' ? 1 : 1.4);
  while (out.length < days) {
    t += step;
    const d = new Date(t);
    if (interval === 'day' && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue;
    if (interval === 'hour') { const h = d.getUTCHours(); if (h < 14 || h > 20 || d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; }
    if (rand() < 0.006) regime = -regime;
    vol = Math.max(0.006, Math.min(0.05, vol * (0.94 + 0.12 * rand()) + 0.0004 * (rand() - 0.5)));
    const drift = regime > 0 ? 0.0009 : -0.0007;
    const scale = interval === 'hour' ? 0.35 : 1;
    const ret = (drift + vol * gauss()) * scale;
    const o = price * (1 + 0.002 * gauss() * scale);
    const c = o * Math.exp(ret);
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6 * scale);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6 * scale);
    const v = Math.round(1e6 * (1 + Math.abs(ret) / vol) * (0.6 + rand()));
    out.push({ t, o: round(o), h: round(h), l: round(l), c: round(c), v });
    price = c;
  }
  return out;
}

const round = (x) => Math.round(x * 10000) / 10000;
