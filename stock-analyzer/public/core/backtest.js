// Event-driven, long-only backtest engine designed to be HONEST:
//   * Signals are evaluated at the CLOSE of bar i using data <= i only.
//   * Orders fill at the OPEN of bar i+1 (never at the signal bar's close).
//   * Protective stops are checked intrabar from bar i+1 on; a gap through the stop
//     fills at the (worse) open price.
//   * Commission and slippage are charged on every entry and exit.
//   * The last open position is marked to market at the final close (flagged "open").

import { isNum, atr as atrFn } from './indicators.js';
import { mean, std, probabilisticSharpe } from './stats.js';

/**
 * @param candles [{t,o,h,l,c}]
 * @param sig { entry: bool[], exit: bool[] }  evaluated at bar close
 * @param opt { feePct, slipPct, atrStopMult, from, to, bpy }
 */
export function runBacktest(candles, sig, opt = {}) {
  const { feePct = 0.1, slipPct = 0.05, atrStopMult = 0, from = 0, to = candles.length - 1, bpy = 252, initial = 1 } = opt;
  const fee = feePct / 100;
  const slip = slipPct / 100;
  const atr = atrStopMult > 0 ? (opt.atr || atrFn(candles.map((b) => b.h), candles.map((b) => b.l), candles.map((b) => b.c), 14)) : null;
  const equity = [];
  const trades = [];
  let cash = initial;
  let shares = 0;
  let entry = null; // { idx, price, stop, equityBefore }
  let pendingEntry = false;
  let pendingExit = false;
  let stop = NaN;
  let barsIn = 0;

  const closeTrade = (i, rawPrice, reason) => {
    const px = rawPrice * (1 - slip);
    const proceeds = shares * px * (1 - fee);
    const ret = proceeds / entry.equityBefore - 1;
    trades.push({
      entryIdx: entry.idx, exitIdx: i, entryT: candles[entry.idx].t, exitT: candles[i].t,
      entryPrice: entry.price, exitPrice: px, ret, bars: i - entry.idx, reason, open: false,
    });
    cash = proceeds; shares = 0; entry = null; stop = NaN;
  };

  for (let i = from; i <= to; i++) {
    const b = candles[i];
    // 1) execute orders queued at the previous close, at this bar's open
    if (pendingExit && shares > 0) closeTrade(i, b.o, 'signal');
    if (pendingEntry && shares === 0 && i > from) {
      const px = b.o * (1 + slip);
      const equityBefore = cash;
      shares = (cash * (1 - fee)) / px;
      cash = 0;
      entry = { idx: i, price: px, equityBefore };
      if (atr && isNum(atr[i - 1])) stop = candles[i - 1].c - atrStopMult * atr[i - 1];
    }
    pendingEntry = false; pendingExit = false;
    // 2) intrabar protective stop
    if (shares > 0 && isNum(stop) && b.l <= stop) {
      closeTrade(i, Math.min(b.o, stop), 'stop');
    }
    // 3) mark to market
    const eq = cash + shares * b.c;
    equity.push(eq);
    if (shares > 0) barsIn++;
    // 4) evaluate signals at the close (for next bar)
    if (i < to) {
      if (shares > 0) {
        if (sig.exit[i]) pendingExit = true;
        if (atr && isNum(atr[i])) stop = Math.max(isNum(stop) ? stop : -Infinity, b.c - atrStopMult * atr[i]); // trailing
      } else if (sig.entry[i]) pendingEntry = true;
    }
  }
  if (shares > 0) {
    const last = candles[to];
    const px = last.c * (1 - slip);
    const value = shares * px * (1 - fee);
    trades.push({ entryIdx: entry.idx, exitIdx: to, entryT: candles[entry.idx].t, exitT: last.t, entryPrice: entry.price, exitPrice: px, ret: value / entry.equityBefore - 1, bars: to - entry.idx, reason: 'open', open: true });
  }
  return finalize(candles, equity, trades, { from, to, bpy, barsIn, initial, feePct, slipPct });
}

/** Buy & hold over the same window with the same costs (entry at the first open after `from`). */
export function buyAndHold(candles, opt = {}) {
  const n = candles.length;
  const entry = new Array(n).fill(false);
  const exit = new Array(n).fill(false);
  entry[opt.from || 0] = true;
  return runBacktest(candles, { entry, exit }, { ...opt, atrStopMult: 0 });
}

function finalize(candles, equity, trades, { from, to, bpy, barsIn, initial, feePct, slipPct }) {
  const rets = [];
  for (let k = 1; k < equity.length; k++) rets.push(equity[k] / equity[k - 1] - 1);
  let peak = -Infinity; let mdd = 0; const dd = [];
  for (const e of equity) { if (e > peak) peak = e; const d = 1 - e / peak; dd.push(-d); if (d > mdd) mdd = d; }
  const final = equity.length ? equity[equity.length - 1] : initial;
  const years = (candles[to].t - candles[from].t) / (365.25 * 86400000);
  const totalReturn = final / initial - 1;
  const cagr = years > 0 && final > 0 ? (final / initial) ** (1 / years) - 1 : NaN;
  const sd = std(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const sharpe = sd > 0 ? (mean(rets) / sd) * Math.sqrt(bpy) : NaN;
  const sortino = downside > 0 ? (mean(rets) / downside) * Math.sqrt(bpy) : NaN;
  const closed = trades.filter((t) => !t.open);
  const all = trades;
  const wins = all.filter((t) => t.ret > 0);
  const losses = all.filter((t) => t.ret <= 0);
  const grossWin = wins.reduce((s, t) => s + t.ret, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.ret, 0);
  let maxConsecLoss = 0; let cur = 0;
  for (const t of all) { if (t.ret <= 0) { cur++; maxConsecLoss = Math.max(maxConsecLoss, cur); } else cur = 0; }
  return {
    equity, drawdown: dd, returns: rets, trades, from, to,
    metrics: {
      totalReturn, cagr, maxDrawdown: mdd, sharpe, sortino,
      calmar: mdd > 0 && isNum(cagr) ? cagr / mdd : NaN,
      trades: all.length, closedTrades: closed.length,
      winRate: all.length ? wins.length / all.length : NaN,
      avgWin: wins.length ? grossWin / wins.length : NaN,
      avgLoss: losses.length ? -grossLoss / losses.length : NaN,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : NaN),
      expectancy: all.length ? mean(all.map((t) => t.ret)) : NaN,
      avgBars: all.length ? mean(all.map((t) => t.bars)) : NaN,
      exposure: equity.length ? barsIn / equity.length : 0,
      best: all.length ? Math.max(...all.map((t) => t.ret)) : NaN,
      worst: all.length ? Math.min(...all.map((t) => t.ret)) : NaN,
      maxConsecLoss,
      psr: probabilisticSharpe(rets, 0),
      years, feePct, slipPct,
    },
  };
}

/** Index of the first bar with time >= t. */
export function indexAtOrAfter(candles, t) {
  let lo = 0; let hi = candles.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}
