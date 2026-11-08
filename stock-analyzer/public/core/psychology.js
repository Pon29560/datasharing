// Crowd psychology — measurable proxies for what traders FEEL, and where that feeling
// tends to push price against what the indicators "should" do.
//   * Fear & Greed composite (per asset) from RSI, stretch vs EMA50 in ATR, 52-week
//     range position, volatility regime and volume pressure (+ news if supplied).
//   * Trap statistics: how often breakouts / breakdowns in THIS asset failed (bull/bear traps).
//   * Volume climaxes (capitulation / euphoria bars).
//   * Market-cycle phase (heuristic map of the "Wall Street cheat sheet").
//   * Sentiment vs price divergence (news euphoric but price weak = distribution, etc.).

import { rsi as rsiFn, ema, atr as atrFn, highest, lowest, stdev, sma, isNum } from './indicators.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const logistic = (z) => 1 / (1 + Math.exp(-z));

/** Fear & Greed series (0 = extreme fear, 100 = extreme greed). Causal: uses bars <= i. */
export function fearGreedSeries(candles) {
  const n = candles.length;
  const c = candles.map((b) => b.c);
  const h = candles.map((b) => b.h);
  const l = candles.map((b) => b.l);
  const v = candles.map((b) => b.v || 0);
  const r = rsiFn(c, 14);
  const e50 = ema(c, 50);
  const a = atrFn(h, l, c, 14);
  const look = Math.min(252, Math.max(20, Math.floor(n / 3)));
  const hh = highest(h, look);
  const ll = lowest(l, look);
  const rets = c.map((x, i) => (i > 0 && c[i - 1] ? Math.log(x / c[i - 1]) : NaN));
  const vol20 = stdev(rets, 20);
  const out = new Array(n).fill(NaN);
  const parts = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!isNum(r[i]) || !isNum(e50[i]) || !isNum(a[i]) || !isNum(hh[i]) || !isNum(vol20[i])) continue;
    const pRsi = r[i];
    const pStretch = 100 * logistic((c[i] - e50[i]) / a[i] / 1.5);
    const pRange = hh[i] > ll[i] ? 100 * (c[i] - ll[i]) / (hh[i] - ll[i]) : 50;
    // volatility percentile over the lookback: high vol = fear
    let below = 0; let cnt = 0;
    for (let j = Math.max(0, i - look + 1); j <= i; j++) if (isNum(vol20[j])) { cnt++; if (vol20[j] <= vol20[i]) below++; }
    const pVol = cnt ? 100 * (1 - below / cnt) : 50;
    // up-volume vs down-volume over 20 bars
    let up = 0; let dn = 0;
    for (let j = Math.max(1, i - 19); j <= i; j++) { if (c[j] > c[j - 1]) up += v[j]; else if (c[j] < c[j - 1]) dn += v[j]; }
    const pVolume = up + dn > 0 ? 100 * up / (up + dn) : 50;
    const val = 0.25 * pRsi + 0.2 * pStretch + 0.2 * pRange + 0.15 * pVol + 0.2 * pVolume;
    out[i] = clamp(val, 0, 100);
    parts[i] = { rsi: pRsi, stretch: pStretch, range: pRange, volatility: pVol, volume: pVolume };
  }
  return { values: out, parts };
}

export function fearGreedLabel(v) {
  if (!isNum(v)) return { th: '—', key: 'na' };
  if (v < 20) return { th: 'กลัวสุดขีด (Extreme Fear)', key: 'xfear' };
  if (v < 40) return { th: 'กลัว (Fear)', key: 'fear' };
  if (v <= 60) return { th: 'เป็นกลาง (Neutral)', key: 'neutral' };
  if (v <= 80) return { th: 'โลภ (Greed)', key: 'greed' };
  return { th: 'โลภสุดขีด (Extreme Greed)', key: 'xgreed' };
}

/**
 * Breakout follow-through vs traps over the history.
 * Bull trap: close breaks above the prior `look`-bar high, then within `confirm` bars closes back below that level.
 */
export function trapStats(candles, { look = 20, confirm = 3 } = {}) {
  const n = candles.length;
  const h = candles.map((b) => b.h);
  const l = candles.map((b) => b.l);
  const hh = highest(h, look);
  const ll = lowest(l, look);
  const events = [];
  let up = 0; let upFail = 0; let dn = 0; let dnFail = 0;
  for (let i = look + 1; i < n - confirm; i++) {
    const lvlUp = hh[i - 1];
    const lvlDn = ll[i - 1];
    if (isNum(lvlUp) && candles[i].c > lvlUp && candles[i - 1].c <= lvlUp) {
      up++;
      let fail = false;
      for (let j = i + 1; j <= i + confirm; j++) if (candles[j].c < lvlUp) { fail = true; break; }
      if (fail) { upFail++; events.push({ type: 'bullTrap', i, level: lvlUp }); }
    }
    if (isNum(lvlDn) && candles[i].c < lvlDn && candles[i - 1].c >= lvlDn) {
      dn++;
      let fail = false;
      for (let j = i + 1; j <= i + confirm; j++) if (candles[j].c > lvlDn) { fail = true; break; }
      if (fail) { dnFail++; events.push({ type: 'bearTrap', i, level: lvlDn }); }
    }
  }
  return {
    breakouts: up, bullTraps: upFail, bullTrapRate: up ? upFail / up : NaN,
    breakdowns: dn, bearTraps: dnFail, bearTrapRate: dn ? dnFail / dn : NaN,
    recent: events.filter((e) => e.i >= n - 60).slice(-5),
    params: { look, confirm },
  };
}

/** Volume climax bars: volume z-score > zMin with a decisive close. */
export function volumeClimaxes(candles, { zMin = 2.5, look = 50 } = {}) {
  const v = candles.map((b) => b.v || 0);
  const m = sma(v, look);
  const s = stdev(v, look);
  const c = candles.map((b) => b.c);
  const e20 = ema(c, 20);
  const out = [];
  for (let i = look; i < candles.length; i++) {
    if (!isNum(m[i - 1]) || !s[i - 1]) continue;
    const z = (v[i] - m[i - 1]) / s[i - 1];
    if (z < zMin) continue;
    const b = candles[i];
    const range = b.h - b.l || 1e-9;
    const closePos = (b.c - b.l) / range;
    const afterDecline = isNum(e20[i]) && b.c < e20[i];
    let type;
    if (afterDecline && closePos > 0.5) type = 'sellingClimax'; // panic bar absorbed (long lower wick)
    else if (afterDecline) type = 'panic';
    else if (closePos < 0.5) type = 'buyingClimax'; // euphoria bar sold into (upper wick)
    else type = 'breakoutVolume';
    out.push({ i, z, type, closePos });
  }
  return out;
}

export const CLIMAX_TEXT = {
  sellingClimax: 'Selling Climax — วอลุ่มสูงผิดปกติแต่ปิดเหนือกลางแท่ง: แรงขายตื่นตระหนกถูกดูดซับ (มักใกล้จุดต่ำ)',
  panic: 'Panic Selling — วอลุ่มสูงและปิดใกล้ต่ำสุด: คนยังกลัวอยู่ อาจยังไม่จบ',
  buyingClimax: 'Buying Climax — วอลุ่มสูงแต่ปิดต่ำกว่ากลางแท่ง: คนไล่ซื้อแต่ถูกขายใส่ (ระวังยอด)',
  breakoutVolume: 'Breakout Volume — วอลุ่มยืนยันแรงซื้อ',
};

/** Heuristic cycle phase from trend structure + fear/greed + stretch. */
export function cyclePhase(candles, fg) {
  const n = candles.length;
  const c = candles.map((b) => b.c);
  const e50 = ema(c, 50);
  const e200 = ema(c, Math.min(200, Math.max(50, Math.floor(n / 2))));
  const i = n - 1;
  const v = fg.values[i];
  if (!isNum(e50[i]) || !isNum(e200[i]) || !isNum(v)) return { key: 'unknown', th: 'ข้อมูลไม่พอ', desc: '' };
  const up = c[i] > e200[i];
  const above50 = c[i] > e50[i];
  const e50Rising = e50[i] > e50[Math.max(0, i - 10)];
  if (up && above50 && v > 80) return { key: 'euphoria', th: 'Euphoria / Thrill (ความโลภสุดขีด)', desc: 'ทุกคนมั่นใจ ข่าวดีเต็มหน้า ราคายืดเกิน EMA — โอกาสเกิด Buying climax/Bearish divergence สูง จังหวะ “ขายให้คนที่ตื่นเต้น” มากกว่าไล่ซื้อ' };
  if (up && above50 && v > 60) return { key: 'belief', th: 'Belief / Optimism (เชื่อมั่น)', desc: 'แนวโน้มขาขึ้นแข็งแรง คนส่วนใหญ่เริ่มเชื่อ — ถือตามเทรนด์ ใช้ Trailing stop' };
  if (up && above50) return { key: 'hope', th: 'Hope / Disbelief (ยังไม่เชื่อ)', desc: 'ราคาเริ่มฟื้นแต่คนยังไม่เชื่อ (ความรู้สึกเป็นกลาง) — ช่วงที่ Risk/Reward ดีที่สุดถ้ากรอบใหญ่ยืนยัน' };
  if (up && !above50) return { key: 'anxiety', th: 'Complacency → Anxiety (เริ่มกังวล)', desc: 'ยังอยู่เหนือเส้นยาวแต่หลุดเส้นกลาง — คนส่วนใหญ่คิดว่า “แค่ย่อ” ระวังการปฏิเสธความจริง (Denial)' };
  if (!up && v < 20) return { key: 'capitulation', th: 'Panic / Capitulation (ยอมแพ้)', desc: 'กลัวสุดขีด ขายทิ้งไม่ดูราคา — มักเกิดใกล้จุดต่ำสำคัญ แต่ต้องรอสัญญาณยืนยัน (Bullish divergence / CDC ฟ้า→เขียว)' };
  if (!up && !above50 && !e50Rising) return { key: 'denial', th: 'Denial / Fear (ขาลง)', desc: 'แนวโน้มขาลงชัดเจน การเด้งมักถูกขายใส่ — ไม่รับมีด' };
  if (!up && above50) return { key: 'depression', th: 'Depression → Hope (ฐานกำลังก่อตัว)', desc: 'ราคาใต้เส้นยาวแต่เริ่มยืนเหนือเส้นกลาง — เฝ้าดูการสร้างฐานและ Higher Low' };
  return { key: 'fear', th: 'Fear (กลัว)', desc: 'ใต้เส้นค่าเฉลี่ยสำคัญ ความรู้สึกติดลบ' };
}

/** News-vs-price disagreement — the classic "crowd vs tape" check. */
export function sentimentPriceDivergence(candles, newsScore) {
  if (!isNum(newsScore)) return null;
  const n = candles.length;
  const look = Math.min(20, n - 1);
  const change = candles[n - 1].c / candles[n - 1 - look].c - 1;
  if (newsScore > 0.25 && change < -0.03) return { key: 'distribution', th: 'ข่าวดีแต่ราคาลง', desc: 'ข่าวเป็นบวกแต่ราคาไม่ตอบสนอง/ลดลง → อาจมีการขายออก (Distribution) หรือข่าวถูก “Price in” ไปแล้ว — “Buy the rumor, sell the news”' };
  if (newsScore < -0.25 && change > 0.03) return { key: 'accumulation', th: 'ข่าวร้ายแต่ราคาขึ้น', desc: 'ข่าวเป็นลบแต่ราคายืนได้/ขึ้น → แรงขายถูกดูดซับ (Accumulation) ข่าวร้ายถูก Price in แล้ว — สัญญาณเชิงบวกเชิงสวนกระแส' };
  if (newsScore > 0.25 && change > 0.08) return { key: 'confirmation-hot', th: 'ข่าวดี + ราคาวิ่งแรง', desc: 'ทั้งข่าวและราคาไปทางเดียวกัน — เทรนด์แข็งแรง แต่ถ้า RSI > 70 ระวัง FOMO' };
  if (newsScore < -0.25 && change < -0.08) return { key: 'confirmation-cold', th: 'ข่าวร้าย + ราคาลงแรง', desc: 'ข่าวและราคายืนยันกัน — อย่ารับมีด รอ Selling climax หรือ Divergence' };
  return { key: 'neutral', th: 'ข่าวกับราคาไม่ขัดแย้งกัน', desc: 'ไม่มีความไม่สอดคล้องที่มีนัยสำคัญระหว่างข่าวและพฤติกรรมราคา' };
}

export function psychologyReport(candles, newsScore) {
  const fg = fearGreedSeries(candles);
  const i = candles.length - 1;
  let current = fg.values[i];
  const parts = fg.parts[i];
  let withNews = current;
  if (isNum(current) && isNum(newsScore)) withNews = clamp(0.85 * current + 0.15 * (50 + 50 * newsScore), 0, 100);
  current = withNews;
  return {
    fearGreed: current,
    label: fearGreedLabel(current),
    parts,
    series: fg.values,
    phase: cyclePhase(candles, fg),
    traps: trapStats(candles),
    climaxes: volumeClimaxes(candles).filter((x) => x.i >= candles.length - 120).slice(-6),
    newsVsPrice: sentimentPriceDivergence(candles, newsScore),
  };
}
