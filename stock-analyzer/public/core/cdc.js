// CDC ActionZone V3 (2020) — faithful port of the public Pine script
// (published on TradingView by piriya33).
//
//   src  = ohlc4
//   AP   = EMA(src, 2)              // smoothed price
//   Fast = EMA(AP, 12)              // short EMA
//   Slow = EMA(AP, 26)              // long EMA
//   Bullish = Fast > Slow,  Bearish = Fast < Slow
//   Green  = Bullish and AP > Fast  -> Buy zone
//   Red    = Bearish and AP < Fast  -> Sell zone
//   Yellow = Bullish and AP < Fast  -> Pre-sell (uptrend losing momentum)
//   Blue   = Bearish and AP > Fast  -> Pre-buy (downtrend losing momentum)
//   Buycond  = Green and not Green[1];  Sellcond = Red and not Red[1]
//   bullish  = barssince(Buycond) < barssince(Sellcond)
//   buy  = bearish[1] and Buycond;     sell = bullish[1] and Sellcond
//
// Everything at bar i uses bars <= i only (signals fire at the bar close).

import { ema, ohlc4, isNum } from './indicators.js';

export const ZONES = {
  green: { th: 'เขียว (Buy Zone)', meaning: 'แนวโน้มขาขึ้น (Fast>Slow) และราคาเหนือ Fast — โซนถือ/ซื้อ' },
  red: { th: 'แดง (Sell Zone)', meaning: 'แนวโน้มขาลง (Fast<Slow) และราคาต่ำกว่า Fast — โซนขาย/ถือเงินสด' },
  yellow: { th: 'เหลือง (Pre-Sell)', meaning: 'ยังเป็นขาขึ้น แต่ราคาหลุด Fast — โมเมนตัมอ่อน ระวัง/ทยอยลดพอร์ต' },
  blue: { th: 'ฟ้า (Pre-Buy)', meaning: 'ยังเป็นขาลง แต่ราคายืนเหนือ Fast — แรงขายอ่อน เฝ้าดูจังหวะเข้า' },
};

export function cdcActionZone(candles, { fast = 12, slow = 26, smoothing = 2 } = {}) {
  const n = candles.length;
  const ap = ema(ohlc4(candles), smoothing);
  const f = ema(ap, fast);
  const s = ema(ap, slow);
  const zone = new Array(n).fill(null);
  const buy = new Array(n).fill(false);
  const sell = new Array(n).fill(false);
  const state = new Array(n).fill(null); // 'bull' | 'bear' | null (barssince comparison)
  let lastBuyCond = -1;
  let lastSellCond = -1;
  let prevGreen = false;
  let prevRed = false;
  let prevState = null;
  for (let i = 0; i < n; i++) {
    if (!isNum(ap[i]) || !isNum(f[i]) || !isNum(s[i])) { state[i] = prevState; continue; }
    const bull = f[i] > s[i];
    const bear = f[i] < s[i];
    const green = bull && ap[i] > f[i];
    const red = bear && ap[i] < f[i];
    const yellow = bull && ap[i] < f[i];
    const blue = bear && ap[i] > f[i];
    zone[i] = green ? 'green' : red ? 'red' : yellow ? 'yellow' : blue ? 'blue' : null;
    const buyCond = green && !prevGreen;
    const sellCond = red && !prevRed;
    if (buyCond) lastBuyCond = i;
    if (sellCond) lastSellCond = i;
    // barssince(x) < barssince(y)  <=>  last x more recent than last y (both must exist; na compares false)
    let st = null;
    if (lastBuyCond >= 0 && lastSellCond >= 0) st = lastBuyCond > lastSellCond ? 'bull' : lastSellCond > lastBuyCond ? 'bear' : null;
    else if (lastBuyCond >= 0 && lastSellCond < 0) st = null; // Pine: barssince(Sellcond) is na -> comparison false
    state[i] = st;
    buy[i] = prevState === 'bear' && buyCond;
    sell[i] = prevState === 'bull' && sellCond;
    prevGreen = green;
    prevRed = red;
    prevState = st;
  }
  return { ap, fast: f, slow: s, zone, buy, sell, state, params: { fast, slow, smoothing } };
}

/** Summarise the latest CDC state for reports. */
export function cdcSummary(cdc, candles) {
  const n = candles.length;
  let i = n - 1;
  while (i >= 0 && !cdc.zone[i]) i--;
  if (i < 0) return null;
  let lastBuy = -1;
  let lastSell = -1;
  for (let k = n - 1; k >= 0 && (lastBuy < 0 || lastSell < 0); k--) {
    if (lastBuy < 0 && cdc.buy[k]) lastBuy = k;
    if (lastSell < 0 && cdc.sell[k]) lastSell = k;
  }
  // How long has the current zone lasted?
  let run = 0;
  for (let k = i; k >= 0 && cdc.zone[k] === cdc.zone[i]; k--) run++;
  const lastSignal = lastBuy > lastSell ? { type: 'buy', i: lastBuy } : lastSell >= 0 ? { type: 'sell', i: lastSell } : null;
  return {
    zone: cdc.zone[i],
    zoneInfo: ZONES[cdc.zone[i]],
    zoneBars: run,
    trend: cdc.fast[i] > cdc.slow[i] ? 'up' : 'down',
    fast: cdc.fast[i],
    slow: cdc.slow[i],
    ap: cdc.ap[i],
    spreadPct: ((cdc.fast[i] - cdc.slow[i]) / cdc.slow[i]) * 100,
    lastSignal: lastSignal ? { ...lastSignal, t: candles[lastSignal.i].t, price: candles[lastSignal.i].c, barsAgo: n - 1 - lastSignal.i } : null,
  };
}
