// Statistics used to PROVE (or disprove) that a strategy has an edge.
// Everything is deterministic given a seed so results are reproducible.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

export function variance(a, sample = true) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - (sample ? 1 : 0));
}

export const std = (a, sample = true) => Math.sqrt(variance(a, sample));

export function skewness(a) {
  const n = a.length;
  if (n < 3) return 0;
  const m = mean(a);
  const s = std(a, false);
  if (!s) return 0;
  return a.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / n;
}

/** Non-excess kurtosis (normal = 3). */
export function kurtosis(a) {
  const n = a.length;
  if (n < 4) return 3;
  const m = mean(a);
  const s = std(a, false);
  if (!s) return 3;
  return a.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / n;
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(a) {
  return quantile([...a].sort((x, y) => x - y), 0.5);
}

// ---- Normal distribution ----
/** erfc via Chebyshev fit (Numerical Recipes), |error| < 1.2e-7. */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

export const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);

/** Inverse normal CDF (Acklam's algorithm, relative error < 1.15e-9). */
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---- Student t distribution (via regularized incomplete beta) ----
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z; let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betacf(a, b, x) {
  const MAXIT = 200; const EPS = 3e-12; const FPMIN = 1e-300;
  const qab = a + b; const qap = a + 1; const qam = a - 1;
  let c = 1; let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** One-sided p-value P(T >= t) for Student t with df degrees of freedom. */
export function tPValueOneSided(t, df) {
  if (!Number.isFinite(t) || df < 1) return NaN;
  const x = df / (df + t * t);
  const twoSided = betai(df / 2, 0.5, x);
  return t >= 0 ? twoSided / 2 : 1 - twoSided / 2;
}

/** One-sample t-test of mean > 0. */
export function tTest(a) {
  const n = a.length;
  if (n < 3) return { t: NaN, p: NaN, n };
  const s = std(a);
  const t = s > 0 ? mean(a) / (s / Math.sqrt(n)) : (mean(a) > 0 ? Infinity : 0);
  return { t, p: Number.isFinite(t) ? tPValueOneSided(t, n - 1) : (t > 0 ? 0 : 1), n };
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado, 2012).
 * Probability that the true (per-period) Sharpe exceeds `srBenchmark`, given sample
 * length, skewness and kurtosis of returns.
 */
export function probabilisticSharpe(returns, srBenchmark = 0) {
  const n = returns.length;
  if (n < 10) return NaN;
  const s = std(returns);
  if (!s) return NaN;
  const sr = mean(returns) / s;
  const g3 = skewness(returns);
  const g4 = kurtosis(returns);
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  return normCdf(((sr - srBenchmark) * Math.sqrt(n - 1)) / denom);
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014): PSR against the Sharpe ratio
 * you would expect from the BEST of `nTrials` strategies with zero true skill.
 * @param srTrials per-period Sharpe ratios of all configurations tried
 */
export function deflatedSharpe(returns, srTrials) {
  const N = srTrials.filter(Number.isFinite).length;
  if (N < 2) return { dsr: probabilisticSharpe(returns, 0), sr0: 0, nTrials: N };
  const v = variance(srTrials.filter(Number.isFinite));
  const gamma = 0.5772156649;
  const sr0 = Math.sqrt(Math.max(0, v)) * ((1 - gamma) * normInv(1 - 1 / N) + gamma * normInv(1 - 1 / (N * Math.E)));
  return { dsr: probabilisticSharpe(returns, sr0), sr0, nTrials: N };
}

/** Bootstrap the mean of `a`: returns CI and probability mean > 0. */
export function bootstrapMean(a, { iters = 2000, seed = 7, ci = 0.95 } = {}) {
  const n = a.length;
  if (n < 3) return null;
  const rand = mulberry32(seed);
  const means = new Array(iters);
  let pos = 0;
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += a[Math.floor(rand() * n)];
    means[k] = s / n;
    if (means[k] > 0) pos++;
  }
  means.sort((x, y) => x - y);
  return { lo: quantile(means, (1 - ci) / 2), hi: quantile(means, 1 - (1 - ci) / 2), pPositive: pos / iters, iters };
}

/**
 * Monte Carlo of trade ORDER: shuffle the realised trade returns to see the
 * distribution of max drawdown / final equity that the same edge could produce.
 */
export function monteCarloTrades(tradeReturns, { iters = 1000, seed = 11 } = {}) {
  const n = tradeReturns.length;
  if (n < 3) return null;
  const rand = mulberry32(seed);
  const dds = []; const finals = [];
  const arr = tradeReturns.slice();
  for (let k = 0; k < iters; k++) {
    for (let j = n - 1; j > 0; j--) { const r = Math.floor(rand() * (j + 1)); [arr[j], arr[r]] = [arr[r], arr[j]]; }
    let eq = 1; let peak = 1; let mdd = 0;
    for (const r of arr) { eq *= 1 + r; if (eq > peak) peak = eq; mdd = Math.max(mdd, 1 - eq / peak); }
    dds.push(mdd); finals.push(eq);
  }
  dds.sort((x, y) => x - y); finals.sort((x, y) => x - y);
  return { ddMedian: quantile(dds, 0.5), dd95: quantile(dds, 0.95), finalP5: quantile(finals, 0.05), finalMedian: quantile(finals, 0.5), iters };
}

/**
 * Random-entry permutation test.
 * Null hypothesis: the strategy's entries are no better than random entries with the
 * SAME number of trades and the SAME holding periods placed randomly (non-overlapping)
 * in the same price history, paying the same costs.
 * p-value = (#random >= actual + 1) / (iters + 1).
 * @param logOpen   log(open) per bar (entries and exits happen at the open)
 * @param trades    [{entryIdx, exitIdx}] actual trades
 * @param actualLogReturn sum of the actual trades' net log returns
 * @param costLog   round-trip cost in log terms per trade
 */
export function randomEntryTest(logOpen, trades, actualLogReturn, costLog, { iters = 1000, seed = 23, from = 0, to = logOpen.length - 1 } = {}) {
  const K = trades.length;
  if (K < 3) return null;
  const durs = trades.map((t) => Math.max(1, t.exitIdx - t.entryIdx));
  const total = durs.reduce((s, d) => s + d, 0);
  const span = to - from;
  const free = span - total;
  if (free < 0) return null;
  const rand = mulberry32(seed);
  let better = 0;
  const dist = [];
  const order = durs.slice();
  for (let k = 0; k < iters; k++) {
    // random permutation of durations
    for (let j = K - 1; j > 0; j--) { const r = Math.floor(rand() * (j + 1)); [order[j], order[r]] = [order[r], order[j]]; }
    // random composition of `free` idle bars into K+1 gaps (stars & bars)
    const cuts = [];
    for (let j = 0; j < K; j++) cuts.push(Math.floor(rand() * (free + 1)));
    cuts.sort((a, b) => a - b);
    let pos = from;
    let prevCut = 0;
    let sum = 0;
    for (let j = 0; j < K; j++) {
      pos += cuts[j] - prevCut; prevCut = cuts[j];
      const a = pos; const b = pos + order[j];
      sum += logOpen[b] - logOpen[a] - costLog;
      pos = b;
    }
    dist.push(sum);
    if (sum >= actualLogReturn) better++;
  }
  dist.sort((a, b) => a - b);
  return { p: (better + 1) / (iters + 1), iters, randomMedian: quantile(dist, 0.5), random95: quantile(dist, 0.95), actual: actualLogReturn };
}
