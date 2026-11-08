// Strategy definitions. Each builds entry/exit boolean arrays evaluated at bar CLOSE,
// using only information available at that bar (confirmed pivots, closed higher-TF bars).

import { cdcActionZone } from './cdc.js';
import { findDivergences, divergenceSeries } from './divergence.js';
import { ema, rsi, isNum } from './indicators.js';
import { toWeekly, mapClosedHigherTF } from './resample.js';

const CDC_GRID = {
  x: { key: 'fast', label: 'EMA Fast', values: [5, 8, 10, 12, 15, 20] },
  y: { key: 'slow', label: 'EMA Slow', values: [20, 26, 30, 40, 50, 60] },
};

export const STRATEGIES = {
  cdc: {
    name: 'CDC ActionZone V3 (EMA 12/26)',
    description: 'ซื้อเมื่อเกิดสัญญาณ Buy (แท่งเขียวแรกหลังสถานะขาลง) ขายเมื่อเกิดสัญญาณ Sell (แท่งแดงแรกหลังสถานะขาขึ้น) — ตามนิยามดั้งเดิม',
    defaults: { fast: 12, slow: 26 },
    grid: CDC_GRID,
    build(candles, p) {
      const cdc = cdcActionZone(candles, { fast: p.fast, slow: p.slow });
      // Faithful Pine signals (note: Pine's first Buy only appears after a prior Sell).
      const entry = cdc.buy.slice();
      const exit = cdc.sell.slice();
      return { entry, exit, valid: p.fast < p.slow };
    },
  },
  rsiDiv: {
    name: 'RSI Divergence (Regular + Hidden Bullish)',
    description: 'ซื้อเมื่อ Bullish Divergence (ปกติหรือซ่อน) ได้รับการยืนยัน (หลัง pivot + lbR แท่ง) ขายเมื่อ Regular Bearish Divergence ยืนยัน หรือ CDC เข้าโซนแดง',
    defaults: { rsiLen: 14, lbR: 5 },
    grid: {
      x: { key: 'rsiLen', label: 'RSI Length', values: [7, 9, 14, 21, 28] },
      y: { key: 'lbR', label: 'Pivot Right', values: [2, 3, 5, 8] },
    },
    build(candles, p) {
      const n = candles.length;
      const d = findDivergences(candles, { rsiLen: p.rsiLen, lbL: 5, lbR: p.lbR });
      const s = divergenceSeries(n, d.list);
      const cdc = cdcActionZone(candles, { fast: 12, slow: 26 });
      const entry = new Array(n).fill(false);
      const exit = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        entry[i] = !!(s.regularBull[i] || s.hiddenBull[i]);
        exit[i] = !!s.regularBear[i] || (cdc.zone[i] === 'red' && cdc.zone[i - 1] !== 'red');
      }
      return { entry, exit, valid: true };
    },
  },
  confluence: {
    name: 'Confluence (CDC + RSI + Divergence + Weekly Trend)',
    description: 'เข้าซื้อเมื่อ “หลายหลักฐานตรงกัน”: CDC เขียว + RSI>50 + EMA200 ขาขึ้น (หรือ Weekly CDC ขาขึ้น) และไม่มี Bearish Divergence ล่าสุด หรือ Bullish Divergence + CDC ไม่ใช่แดง — ออกเมื่อ CDC แดง หรือ Bearish Divergence ขณะ RSI สูง',
    defaults: { fast: 12, slow: 26 },
    grid: CDC_GRID,
    build(candles, p, ctx = {}) {
      const n = candles.length;
      const close = candles.map((b) => b.c);
      const cdc = cdcActionZone(candles, { fast: p.fast, slow: p.slow });
      const r = rsi(close, 14);
      const e200 = ema(close, 200);
      const d = findDivergences(candles, { rsiValues: r, lbL: 5, lbR: 5 });
      const s = divergenceSeries(n, d.list);
      // Weekly trend from CLOSED weekly bars only.
      let wTrend = new Array(n).fill(undefined);
      if (ctx.tf === '1D') {
        const weekly = toWeekly(candles, ctx.tzOffsetSec || 0);
        const wc = cdcActionZone(weekly, { fast: 12, slow: 26 });
        wTrend = mapClosedHigherTF(n, weekly, weekly.map((_, k) => (isNum(wc.fast[k]) && isNum(wc.slow[k]) ? wc.fast[k] > wc.slow[k] : undefined)));
      }
      const entry = new Array(n).fill(false);
      const exit = new Array(n).fill(false);
      let lastBear = -1e9; let lastBull = -1e9;
      for (let i = 0; i < n; i++) {
        if (s.regularBear[i]) lastBear = i;
        if (s.regularBull[i] || s.hiddenBull[i]) lastBull = i;
        const trendUp = wTrend[i] !== undefined ? wTrend[i] : (isNum(e200[i]) ? close[i] > e200[i] : true);
        const momentum = isNum(r[i]) && r[i] > 50;
        const a = cdc.zone[i] === 'green' && momentum && trendUp && i - lastBear > 10;
        const b = i - lastBull <= 3 && cdc.zone[i] !== 'red' && (cdc.zone[i] === 'blue' || cdc.zone[i] === 'green');
        entry[i] = a || b;
        exit[i] = cdc.zone[i] === 'red' || (!!s.regularBear[i] && isNum(r[i]) && r[i] > 60);
      }
      return { entry, exit, valid: p.fast < p.slow };
    },
  },
};

/** Apply a parameter set; returns null if the combination is invalid. */
export function buildSignals(key, candles, params, ctx) {
  const st = STRATEGIES[key];
  const p = { ...st.defaults, ...params };
  const res = st.build(candles, p, ctx);
  return res.valid ? res : null;
}
