// Orchestrator: multi-timeframe analysis -> transparent score -> trading plan.
// Top-down (Elder's Triple Screen idea): the long timeframe sets the tide, the
// medium timeframe the wave, the short timeframe the ripple / entry timing.

import { rsi as rsiFn, ema, atr as atrFn, isNum, last } from './indicators.js';
import { cdcActionZone, cdcSummary } from './cdc.js';
import { findDivergences, recentDivergences, rsiState } from './divergence.js';
import { zigzag, atrThresholds, SENSITIVITY } from './zigzag.js';
import { countElliott, DEGREE } from './elliott.js';
import { toWeekly, toMonthly, to4H, lastBarForming } from './resample.js';
import { psychologyReport } from './psychology.js';

export const TF_LABEL = { '1H': '1 ชั่วโมง', '4H': '4 ชั่วโมง', '1D': 'รายวัน (Daily)', '1W': 'รายสัปดาห์ (Weekly)', '1M': 'รายเดือน (Monthly)' };
export const HORIZON_TF = { short: '1D', medium: '1W', long: '1M' };
export const HORIZON_TH = {
  short: { th: 'ระยะสั้น', hold: 'ถือ ~ไม่กี่วัน – 4 สัปดาห์', tf: 'Daily (ใช้ 4H ช่วยจับจังหวะ)' },
  medium: { th: 'ระยะกลาง', hold: 'ถือ ~1 – 6 เดือน', tf: 'Weekly' },
  long: { th: 'ระยะยาว', hold: 'ถือ ~6 เดือน – หลายปี', tf: 'Monthly' },
};
const DIV_LOOKBACK = { '1H': 24, '4H': 20, '1D': 15, '1W': 8, '1M': 4 };

export function buildTimeframes(daily, hourly, tzOffsetSec = 0) {
  const tfs = { '1D': daily, '1W': toWeekly(daily, tzOffsetSec), '1M': toMonthly(daily, tzOffsetSec) };
  if (hourly && hourly.length) { tfs['1H'] = hourly; tfs['4H'] = to4H(hourly, tzOffsetSec); }
  return tfs;
}

/** Full single-timeframe technical read. */
export function analyzeTF(candles, tf, { sensitivity = 'standard', tzOffsetSec = 0, nowMs = Date.now() } = {}) {
  const n = candles.length;
  if (n < 35) return { tf, insufficient: true, n, note: `ข้อมูล ${TF_LABEL[tf]} มีเพียง ${n} แท่ง (ต้องการอย่างน้อย 35)` };
  const c = candles.map((b) => b.c);
  const r = rsiFn(c, 14);
  const cdc = cdcActionZone(candles);
  const div = findDivergences(candles, { rsiValues: r });
  const e50 = ema(c, 50);
  const e200 = ema(c, 200);
  const a = atrFn(candles.map((b) => b.h), candles.map((b) => b.l), c, 14);
  const mult = (SENSITIVITY[sensitivity] || SENSITIVITY.standard).mult;
  const { zz, ew } = elliottMulti(candles, r, mult, tf === '1M');
  const i = n - 1;
  const price = c[i];
  const cdcS = cdcSummary(cdc, candles);
  const recent = recentDivergences(div.list, i, DIV_LOOKBACK[tf] || 10);
  const rs = rsiState(r[i]);
  const forming = lastBarForming(tf, candles[i].t, nowMs, tzOffsetSec);

  // ---------------- Transparent score ----------------
  const comps = [];
  const add = (key, label, value, why) => comps.push({ key, label, value: Math.round(value * 10) / 10, why });
  if (cdcS) {
    const zv = { green: 30, yellow: 8, blue: -8, red: -30 }[cdcS.zone] || 0;
    add('cdc', `CDC ActionZone: ${cdcS.zoneInfo.th}`, zv, `${cdcS.zoneInfo.meaning} (ต่อเนื่อง ${cdcS.zoneBars} แท่ง)`);
  }
  if (isNum(e200[i])) add('ema200', price > e200[i] ? 'ราคาเหนือ EMA200' : 'ราคาใต้ EMA200', price > e200[i] ? 10 : -10, 'EMA200 = เส้นแบ่งแนวโน้มหลัก (Bull/Bear market)');
  else if (isNum(e50[i])) add('ema50', price > e50[i] ? 'ราคาเหนือ EMA50' : 'ราคาใต้ EMA50', price > e50[i] ? 6 : -6, 'ข้อมูลไม่พอสำหรับ EMA200 จึงใช้ EMA50');
  if (isNum(r[i])) {
    let mv = ((r[i] - 50) / 50) * 15;
    let why = `RSI(14) = ${r[i].toFixed(1)} → ${rs.label}`;
    if (r[i] > 75) { mv -= 8; why += ' · ยืดตัวมาก เสี่ยงย่อ'; }
    if (r[i] < 25) { mv += 8; why += ' · ขายมากเกินไป มีโอกาสเด้ง'; }
    add('rsi', 'โมเมนตัม RSI', mv, why);
  }
  const lb = DIV_LOOKBACK[tf] || 10;
  for (const d of recent.slice(0, 2)) {
    const ago = i - d.confirmedAt;
    const decay = 1 - 0.5 * (ago / lb);
    const base = d.type.startsWith('regular') ? 20 : 12;
    add('div', `${d.th} (ยืนยัน ${ago} แท่งก่อน)`, d.bias * base * (0.5 + 0.5 * d.strength) * decay, d.meaning);
  }
  if (ew.best) {
    const conf = Math.min(1, ew.best.score);
    add('elliott', `Elliott: ${ew.best.current.th}`, ew.best.bias * 20 * conf, `${ew.best.current.action} · ความสอดคล้องกฎ/Fibo ${(ew.best.conformance * 100).toFixed(0)}%`);
  }
  const score = Math.max(-100, Math.min(100, comps.reduce((s, x) => s + x.value, 0)));

  return {
    tf, label: TF_LABEL[tf], degree: DEGREE[tf], n, candles, price, forming,
    series: { rsi: r, ema50: e50, ema200: e200, atr: a, cdc },
    cdc: cdcS, rsi: { value: r[i], state: rs },
    divergences: div.list, recentDivergences: recent,
    zigzag: zz, elliott: ew,
    atr: a[i], ema50: e50[i], ema200: e200[i],
    components: comps, score, verdict: verdictOf(score),
  };
}

/**
 * Count waves on three swing sizes around the chosen sensitivity (0.7x, 1x, 1.4x) and keep
 * the best-conforming count. Each count records which swing size (degree) it came from.
 */
export function elliottMulti(candles, r, mult, useLog) {
  const runs = [mult, mult * 0.7, mult * 1.4].map((m) => {
    const zz = zigzag(candles, atrThresholds(candles, m));
    const ew = countElliott(zz, { rsi: r, useLog });
    (ew.all || []).forEach((c) => { c.swingMult = m; });
    return { m, zz, ew };
  });
  const all = runs.flatMap((x) => (x.ew.all || []).map((c) => ({ c, zz: x.zz })));
  if (!all.length) return { zz: runs[0].zz, ew: runs[0].ew };
  all.sort((a, b) => b.c.score - a.c.score);
  // Distinct alternatives: different position or direction than the best.
  const best = all[0];
  const alts = [];
  for (const x of all.slice(1)) {
    if (alts.length >= 2) break;
    const same = [best, ...alts].some((y) => y.c.k === x.c.k && y.c.direction === x.c.direction && y.c.labels[0].i === x.c.labels[0].i);
    if (!same) alts.push(x);
  }
  const total = [best, ...alts].reduce((s, x) => s + x.c.score, 0);
  [best, ...alts].forEach((x) => { x.c.relative = x.c.score / total; });
  return { zz: best.zz, ew: { best: best.c, alternatives: alts.map((x) => x.c), altZigzags: alts.map((x) => x.zz), all: all.map((x) => x.c) } };
}

export function verdictOf(score) {
  if (score >= 45) return { key: 'strongBuy', th: 'ซื้อ / ถือ (แข็งแรง)', tone: 'good' };
  if (score >= 15) return { key: 'buy', th: 'เอนเอียงซื้อ', tone: 'good' };
  if (score > -15) return { key: 'neutral', th: 'รอ / ถือดูสถานการณ์', tone: 'neutral' };
  if (score > -45) return { key: 'sell', th: 'เอนเอียงขาย / ลดพอร์ต', tone: 'bad' };
  return { key: 'strongSell', th: 'ขาย / หลีกเลี่ยง', tone: 'bad' };
}

/** Concrete plan: entry, stop, targets, R:R, size, and the exact triggers to buy / sell. */
export function tradePlan(ta, { capital = 100000, riskPct = 1 } = {}) {
  if (!ta || ta.insufficient) return null;
  const price = ta.price;
  const atr = isNum(ta.atr) ? ta.atr : price * 0.02;
  const pivots = ta.zigzag.pivots;
  const lows = pivots.filter((p) => p.type === 'L' && p.price < price).slice(-3);
  const highs = pivots.filter((p) => p.type === 'H' && p.price > price).slice(-3);
  const ew = ta.elliott.best;
  const bullish = ta.score >= 15;
  const bearish = ta.score <= -15;

  // Stop: structural (last swing low / Elliott invalidation) with a 0.5 ATR buffer; cap at 4 ATR.
  const cands = [];
  if (lows.length) cands.push({ price: lows[lows.length - 1].price - 0.5 * atr, why: 'ใต้ Swing Low ล่าสุด − 0.5 ATR' });
  if (ew && isNum(ew.invalidation) && ew.invalidation < price && ew.bias > 0) cands.push({ price: ew.invalidation - 0.25 * atr, why: 'ใต้จุด Invalidation ของ Elliott count' });
  let stop = cands.filter((s) => s.price < price).sort((a, b) => b.price - a.price)[0];
  if (!stop || price - stop.price > 4 * atr) stop = { price: price - 2.5 * atr, why: '2.5 × ATR (โครงสร้างไกลเกินไป จึงใช้ความผันผวนแทน)' };
  const risk = price - stop.price;

  const tg = [];
  if (ew && ew.bias > 0) for (const t of ew.targets) if (t.price > price * 1.002) tg.push({ price: t.price, why: `Elliott: ${t.label}` });
  for (const h of highs) tg.push({ price: h.price, why: 'แนวต้าน Swing High เดิม' });
  if (!tg.length || tg.every((t) => (t.price - price) / risk < 1.5)) { tg.push({ price: price + 2 * risk, why: '2R' }); tg.push({ price: price + 3 * risk, why: '3R' }); }
  const targets = tg.sort((a, b) => a.price - b.price).filter((t, k, arr) => k === 0 || t.price / arr[k - 1].price > 1.005).slice(0, 3)
    .map((t) => ({ ...t, r: (t.price - price) / risk }));
  const rr = targets.length ? targets[0].r : NaN;
  const size = risk > 0 ? Math.floor((capital * riskPct / 100) / risk) : 0;

  const cdcFast = ta.series.cdc.fast[ta.n - 1];
  const cdcSlow = ta.series.cdc.slow[ta.n - 1];
  const buyTriggers = [];
  const sellTriggers = [];
  if (ta.cdc) {
    if (ta.cdc.zone === 'red' || ta.cdc.zone === 'blue') buyTriggers.push(`CDC กลับเป็นแท่งเขียว: ต้องให้ EMA Fast (${fx(cdcFast)}) ตัดขึ้นเหนือ EMA Slow (${fx(cdcSlow)}) และราคาปิดเหนือ Fast`);
    if (ta.cdc.zone === 'yellow') buyTriggers.push(`ปิดกลับเหนือ EMA Fast ${fx(cdcFast)} → กลับสู่โซนเขียว`);
    if (ta.cdc.zone === 'green') buyTriggers.push(`CDC เขียวอยู่แล้ว — ย่อมาใกล้ EMA Fast ${fx(cdcFast)} แล้วยืนได้ = จุดเข้าที่ความเสี่ยงต่ำ`);
    if (ta.cdc.zone === 'green' || ta.cdc.zone === 'yellow') sellTriggers.push(`CDC เปลี่ยนเป็นแดง: EMA Fast ตัดลงใต้ Slow (${fx(cdcSlow)}) และราคาปิดใต้ Fast`);
    else sellTriggers.push('CDC อยู่ฝั่งขาลง — ผู้ถือควรลด/ออกตามระบบ');
  }
  buyTriggers.push('เกิด Bullish Divergence (RSI ทำ Higher Low ขณะราคาทำ Lower Low) และได้รับการยืนยัน');
  sellTriggers.push('เกิด Regular Bearish Divergence (RSI ทำ Lower High ขณะราคาทำ Higher High) ใกล้แนวต้าน/เป้าหมาย');
  if (ew) {
    if (ew.bias > 0) sellTriggers.push(`ราคาหลุด ${fx(ew.invalidation)} → Elliott count ขาขึ้นใช้ไม่ได้ (${ew.invalidationNote})`);
    else buyTriggers.push(`Elliott: ${ew.current.action}`);
  }
  sellTriggers.push(`ราคาหลุด Stop ${fx(stop.price)} (${stop.why})`);
  if (targets.length) sellTriggers.push(`ถึงเป้าหมาย ${targets.map((t) => fx(t.price)).join(' / ')} → ทยอยขายทำกำไร`);

  // A bullish read is only actionable when the reward justifies the risk.
  const rrOk = isNum(rr) && rr >= 1.5;
  const stance = bullish ? (rrOk ? 'long' : 'pullback') : bearish ? 'avoid' : 'wait';
  // Entry price at which T1 gives R:R = 2 with the same stop: (T1 + 2*stop) / 3
  const betterEntry = bullish && !rrOk && targets.length ? (targets[0].price + 2 * stop.price) / 3 : NaN;
  const sizeAt = (px) => (px - stop.price > 0 ? Math.floor((capital * riskPct / 100) / (px - stop.price)) : 0);
  const finalSize = stance === 'pullback' && isNum(betterEntry) ? sizeAt(betterEntry) : size;
  if (stance === 'pullback' && isNum(betterEntry)) buyTriggers.unshift(`ย่อลงมาใกล้ ${fx(betterEntry)} (จุดที่ R:R = 1:2 กับ Stop ${fx(stop.price)}) แล้วมีแท่งกลับตัว`);
  return {
    stance,
    entry: stance === 'long' ? { price, zoneLow: Math.min(price, isNum(cdcFast) ? cdcFast : price), zoneHigh: price } : stance === 'pullback' && isNum(betterEntry) ? { price: betterEntry, zoneLow: betterEntry, zoneHigh: betterEntry } : null,
    stop, targets, rr, risk, size: finalSize, capital, riskPct, betterEntry,
    buyTriggers, sellTriggers,
    note: stance === 'long'
      ? (rr >= 2 ? 'Risk:Reward ≥ 2 — ผ่านเกณฑ์' : 'Risk:Reward 1.5–2 — พอรับได้ ควรลดขนาดสถานะ')
      : stance === 'pullback' ? `แนวโน้มเป็นบวก แต่ ณ ราคาปัจจุบัน Risk:Reward = 1:${isNum(rr) ? rr.toFixed(2) : '—'} ไม่คุ้ม — รอย่อ ไม่ไล่ราคา`
        : bearish ? 'แนวโน้มไม่เอื้อ: ยังไม่ควรเปิดสถานะซื้อ ผู้ถือควรใช้ Stop/ลดสัดส่วน' : 'สัญญาณยังขัดแย้งกัน: รอให้ Trigger ข้างล่างเกิดก่อน',
  };
}

function fx(v) {
  if (!isNum(v)) return '—';
  const d = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function alignmentText(s, m, l) {
  const sg = (x) => (x >= 15 ? 1 : x <= -15 ? -1 : 0);
  const [a, b, c] = [sg(s), sg(m), sg(l)];
  if (a === 1 && b === 1 && c === 1) return { tone: 'good', th: 'ทุกกรอบเวลาเป็นขาขึ้นสอดคล้องกัน (Full alignment) — ความน่าเชื่อถือของสัญญาณซื้อสูงสุด' };
  if (a === -1 && b === -1 && c === -1) return { tone: 'bad', th: 'ทุกกรอบเวลาเป็นขาลง — หลีกเลี่ยงการซื้อ การเด้งคือโอกาสขาย' };
  if (c >= 0 && b === 1 && a <= 0) return { tone: 'neutral', th: 'แนวโน้มใหญ่/กลางขึ้น แต่ระยะสั้นย่อตัว — ตามหลัก Triple Screen นี่คือ “จังหวะหาจุดซื้อ” เมื่อสัญญาณรายวันกลับเป็นบวก' };
  if (c === -1 && a === 1) return { tone: 'neutral', th: 'ระยะสั้นขึ้นสวนแนวโน้มใหญ่ขาลง — เป็นการเด้งในขาลง เทรดสั้นเท่านั้นและตั้ง Stop เข้ม' };
  if (c === 1 && b === -1) return { tone: 'neutral', th: 'แนวโน้มยาวยังขึ้น แต่ระยะกลางปรับฐาน — นักลงทุนระยะยาวรอสะสมเมื่อ Weekly กลับตัว' };
  return { tone: 'neutral', th: 'สัญญาณระหว่างกรอบเวลายังไม่สอดคล้องกัน — ลดขนาดสถานะ หรือรอ' };
}

/**
 * Analyse everything.
 * @param input { daily, hourly?, meta, news? (analyzeNews output), settings }
 */
export function analyzeAll({ daily, hourly, meta = {}, news = null, settings = {} }) {
  const tz = meta.tzOffsetSec || 0;
  const tfs = buildTimeframes(daily, hourly, tz);
  const opts = { sensitivity: settings.sensitivity || 'standard', tzOffsetSec: tz, nowMs: settings.nowMs || Date.now() };
  const ta = {};
  for (const [tf, candles] of Object.entries(tfs)) ta[tf] = analyzeTF(candles, tf, opts);

  const psych = psychologyReport(daily, news ? news.overall : NaN);
  const horizons = {};
  for (const [hk, tf] of Object.entries(HORIZON_TF)) {
    const t = ta[tf];
    if (!t || t.insufficient) { horizons[hk] = { ...HORIZON_TH[hk], key: hk, tf, insufficient: true, note: t ? t.note : 'ไม่มีข้อมูล' }; continue; }
    const comps = t.components.slice();
    const nz = news && news.horizons[hk];
    if (nz && isNum(nz.score) && nz.count > 0) comps.push({ key: 'news', label: `ข่าว (${nz.count} ชิ้น, ถ่วงตามความใหม่)`, value: Math.round(nz.score * 12 * 10) / 10, why: `Sentiment ${nz.score.toFixed(2)} — ข่าวมีผลต่อ${HORIZON_TH[hk].th}ตาม Factor ที่จัดกลุ่มไว้` });
    if (hk === 'short' && isNum(psych.fearGreed)) {
      const fg = psych.fearGreed;
      const hasBear = t.recentDivergences.some((d) => d.type === 'regularBear');
      const hasBull = t.recentDivergences.some((d) => d.type === 'regularBull');
      if (fg > 80 && hasBear) comps.push({ key: 'psych', label: 'จิตวิทยา: โลภสุดขีด + Bearish Divergence', value: -10, why: 'ฝูงชนไล่ราคาแต่แรงส่งลดลง — โอกาสเกิด Bull trap' });
      else if (fg < 20 && hasBull) comps.push({ key: 'psych', label: 'จิตวิทยา: กลัวสุดขีด + Bullish Divergence', value: 10, why: 'ฝูงชนตื่นตระหนกแต่แรงขายลดลง — โอกาสกลับตัว (Contrarian)' });
      else if (fg > 85) comps.push({ key: 'psych', label: 'จิตวิทยา: โลภสุดขีด', value: -5, why: 'ราคาไปไกลกว่าค่าเฉลี่ยมาก ความเสี่ยงย่อสูงขึ้น' });
      else if (fg < 15) comps.push({ key: 'psych', label: 'จิตวิทยา: กลัวสุดขีด', value: 5, why: 'Sentiment ติดลบสุดขั้วมักเกิดใกล้จุดต่ำระยะสั้น' });
    }
    const score = Math.max(-100, Math.min(100, comps.reduce((s, x) => s + x.value, 0)));
    const taAdj = { ...t, score, components: comps };
    horizons[hk] = { ...HORIZON_TH[hk], key: hk, tf, score, verdict: verdictOf(score), components: comps, plan: tradePlan(taAdj, settings), forming: t.forming };
  }
  const sc = (k) => (horizons[k] && !horizons[k].insufficient ? horizons[k].score : 0);
  const alignment = alignmentText(sc('short'), sc('medium'), sc('long'));
  return { meta, tfs, ta, horizons, alignment, psych, news, lastPrice: last(daily.map((b) => b.c)), asOf: daily[daily.length - 1].t };
}
