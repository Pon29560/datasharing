// Elliott Wave counter — rule-checked, Fibonacci-scored, alternatives ranked.
//
// Source of the rules: R.N. Elliott (1938); A.J. Frost & R.R. Prechter,
// "Elliott Wave Principle" (1978).
//   HARD RULES (a count that breaks one is rejected):
//     R1  Wave 2 never retraces more than 100% of wave 1.
//     R2  Wave 3 always travels beyond the end of wave 1.
//     R3  Wave 3 is never the shortest of waves 1, 3 and 5.
//     R4  Wave 4 never enters the price territory of wave 1 (non-diagonal impulse).
//   GUIDELINES (scored, not enforced):
//     wave 2 ≈ 50–61.8% of 1 · wave 3 ≈ 161.8% of 1 · wave 4 ≈ 23.6–38.2% of 3
//     wave 5 ≈ wave 1 or 61.8% of 1 · alternation of 2 and 4 · wave 3 strongest momentum
//     wave 5 often shows RSI divergence vs wave 3 · B ≈ 50–61.8% of A (zigzag) ·
//     C ≈ 100% or 161.8% of A.
//
// Swings come from the ZigZag (confirmed pivots only). The leg after the last
// confirmed pivot is "in progress" and is checked against the rules live.
// Elliott counting is inherently subjective: the score is RULE/GUIDELINE CONFORMANCE,
// not a probability of being right. Always read it with its invalidation level.

import { isNum } from './indicators.js';

const LABELS = ['0', '1', '2', '3', '4', '5', 'A', 'B', 'C'];

function closeness(value, targets, tol) {
  let best = 0;
  for (const t of targets) best = Math.max(best, 1 - Math.abs(value - t) / tol);
  return Math.max(0, best);
}

// Position after k completed labels. `bull` / `bear` = action when the impulse is up / down.
const POSITION_TEXT = {
  1: { wave: '2', th: 'คลื่น 2 (ย่อ/เด้งสวนหลังคลื่น 1)', bull: 'รอซื้อเมื่อย่อ 50–61.8% ของคลื่น 1 แล้วมีสัญญาณกลับตัว — จุดเข้าก่อนคลื่น 3 ที่ R:R ดีที่สุด', bear: 'การเด้งในคลื่น 2 ของขาลง — มักเป็นจังหวะขาย ไม่ควรไล่ซื้อ' },
  2: { wave: '3', th: 'คลื่น 3 (แรงที่สุดของรอบ)', bull: 'ถือ / ซื้อเพิ่มเมื่อย่อ — แนวโน้มขึ้นแข็งแรงที่สุด', bear: 'ขาลงแรงที่สุด — หลีกเลี่ยงการซื้อ / ผู้ถือควรลดความเสี่ยง' },
  3: { wave: '4', th: 'คลื่น 4 (พักตัว)', bull: 'รอซื้อบริเวณ Fibo 23.6–38.2% ของคลื่น 3 ตราบใดที่ไม่หลุดยอดคลื่น 1', bear: 'การเด้งพักตัวในขาลง — ยังไม่ใช่จุดกลับตัว อย่าเพิ่งซื้อ' },
  4: { wave: '5', th: 'คลื่น 5 (ช่วงท้ายของรอบ)', bull: 'ถือแต่ยก Stop ตาม ไม่ควรเปิดสถานะใหม่ ระวัง RSI Divergence', bear: 'ช่วงท้ายของขาลง — เฝ้าดู Bullish Divergence เพื่อเตรียมซื้อ' },
  5: { wave: 'A', th: 'คลื่น 5 จบแล้ว → เข้าสู่คลื่น A (ปรับฐานสวนทาง)', bull: 'ลด/ขายทำกำไร หลีกเลี่ยงการซื้อใหม่', bear: 'ขาลงครบ 5 คลื่น — คาดการเด้ง A-B-C ทยอยสะสมได้เมื่อมีสัญญาณยืนยัน' },
  6: { wave: 'B', th: 'คลื่น B (สวนกลับชั่วคราว)', bull: 'การเด้งในคลื่น B มักเป็นจังหวะขาย ไม่ใช่จังหวะซื้อ', bear: 'การย่อในคลื่น B — จุดซื้อเพื่อเล่นคลื่น C ขึ้น ถ้าไม่หลุดจุดต่ำสุดคลื่น 5' },
  7: { wave: 'C', th: 'คลื่น C (ช่วงสุดท้ายของการปรับฐาน)', bull: 'เตรียมซื้อเมื่อคลื่น C ครบเป้า Fibo + มี Bullish Divergence', bear: 'คลื่น C ขึ้นเป็นช่วงสุดท้ายของการเด้ง — ขาย/ลดเมื่อครบเป้า' },
  8: { wave: '1', th: 'ABC จบแล้ว → อาจเริ่มรอบใหม่ (คลื่น 1)', bull: 'เฝ้าดูสัญญาณกลับตัวขึ้น รอคลื่น 2 ย่อเพื่อเข้า', bear: 'การเด้ง ABC จบ — ระวังขาลงรอบใหม่' },
};

/**
 * Evaluate one labelling: seq = confirmed pivots labelled 0..k (alternating), live = in-progress extreme.
 * dirSign = +1 bullish impulse (0 is a low), -1 bearish impulse (0 is a high).
 */
function evaluate(seq, live, dirSign, ctx) {
  const k = seq.length - 1;
  const tf = ctx.useLog ? Math.log : (x) => x;
  const inv = ctx.useLog ? Math.exp : (x) => x;
  // Normalised coordinates: always "up" for an impulse in dirSign direction.
  const x = seq.map((p) => dirSign * tf(p.price));
  const liveX = live ? dirSign * tf(live.price) : null;
  const toPrice = (v) => inv(v * dirSign);
  const rules = [];
  const guides = [];
  const leg = (a, b) => x[b] - x[a];
  const L1 = leg(0, 1);
  // Human-readable leg size: % move on log charts, price units otherwise.
  const legTxt = (v) => (ctx.useLog ? `${((Math.exp(v) - 1) * 100).toFixed(1)}%` : fmt(v));
  if (!(L1 > 0)) return null;

  // ---------- HARD RULES ----------
  const rule = (name, pass, detail) => { rules.push({ name, pass, detail }); return pass; };
  if (k >= 2 && !rule('R1 คลื่น 2 ไม่ย่อเกิน 100% ของคลื่น 1', x[2] > x[0], `คลื่น 2 ย่อ ${pct((x[1] - x[2]) / L1)} ของคลื่น 1`)) return null;
  if (k >= 3 && !rule('R2 คลื่น 3 ต้องผ่านจุดสิ้นสุดคลื่น 1', x[3] > x[1], 'ยอดคลื่น 3 สูงกว่ายอดคลื่น 1')) return null;
  if (k >= 4 && !rule('R4 คลื่น 4 ไม่ทับซ้อนเขตราคาคลื่น 1', x[4] > x[1], `จุดจบคลื่น 4 ห่างจากจุดจบคลื่น 1 = ${pct(Math.abs(seq[4].price - seq[1].price) / seq[1].price)}`)) return null;
  if (k >= 5) {
    const L3 = leg(2, 3); const L5 = leg(4, 5);
    if (!rule('R3 คลื่น 3 ไม่ใช่คลื่นที่สั้นที่สุด', !(L3 < L1 && L3 < L5), `ความยาว 1/3/5 = ${legTxt(L1)} / ${legTxt(L3)} / ${legTxt(L5)}`)) return null;
  }
  // Live checks: the in-progress leg must not already have broken a rule.
  if (live && liveX !== null) {
    if (k === 1 && liveX <= x[0]) return null; // wave 2 in progress already retraced > 100% of wave 1
    if (k === 3 && liveX <= x[1]) return null; // wave 4 in progress overlaps wave 1 -> invalid
    if (k === 4) {
      const L3 = leg(2, 3);
      if (L3 < L1 && liveX - x[4] > L3) return null; // wave 5 would make wave 3 the shortest
    }
  }

  // ---------- GUIDELINES ----------
  const g = (name, score, value, ideal) => guides.push({ name, score: Math.max(0, Math.min(1, score)), value, ideal });
  const r = ctx.rsi;
  const rsiAt = (p) => (r && isNum(r[p.i]) ? r[p.i] : NaN);
  if (k === 1) {
    const r2live = liveX !== null ? (x[1] - liveX) / L1 : NaN;
    g('คลื่น 2 (กำลังเกิด) ย่อแล้วไม่เกิน 78.6%', isNum(r2live) ? (r2live <= 0.786 ? 0.7 : 0.35) : 0.5, r2live, '≤ 0.786 (เป้า 0.5–0.618)');
  }
  if (k >= 2) {
    const r2 = (x[1] - x[2]) / L1;
    g('คลื่น 2 ย่อ 50–61.8% ของคลื่น 1', Math.max(closeness(r2, [0.5, 0.618], 0.2), 0.6 * closeness(r2, [0.382, 0.786], 0.12)), r2, '0.5–0.618');
  }
  if (k >= 3) {
    const r3 = leg(2, 3) / L1;
    g('คลื่น 3 ≈ 1.618 เท่าคลื่น 1', r3 >= 1.382 ? Math.max(0.65, closeness(r3, [1.618, 2.618], 0.6)) : 0.5 * closeness(r3, [1.0], 0.3), r3, '1.618 (หรือ 2.618)');
    const t2 = seq[2].i - seq[1].i; const t1 = seq[1].i - seq[0].i;
    g('สัดส่วนเวลาคลื่น 2 เทียบคลื่น 1 สมเหตุสมผล', t1 > 0 && t2 / t1 >= 0.2 && t2 / t1 <= 5 ? 1 : 0.4, t1 > 0 ? t2 / t1 : NaN, '0.2–5 เท่า');
    if (isNum(rsiAt(seq[1])) && isNum(rsiAt(seq[3]))) {
      const m = dirSign > 0 ? rsiAt(seq[3]) >= rsiAt(seq[1]) - 2 : rsiAt(seq[3]) <= rsiAt(seq[1]) + 2;
      g('โมเมนตัม (RSI) คลื่น 3 แรงกว่าคลื่น 1', m ? 1 : 0.35, rsiAt(seq[3]) - rsiAt(seq[1]), dirSign > 0 ? 'RSI3 ≥ RSI1' : 'RSI3 ≤ RSI1');
    }
  }
  if (k >= 4) {
    const L3 = leg(2, 3);
    const r4 = (x[3] - x[4]) / L3;
    g('คลื่น 4 ย่อ 23.6–38.2% ของคลื่น 3', r4 <= 0.5 ? Math.max(0.55, closeness(r4, [0.236, 0.382], 0.15)) : closeness(r4, [0.5], 0.25) * 0.6, r4, '0.236–0.382');
    const r2 = (x[1] - x[2]) / L1;
    const deep2 = r2 > 0.5; const deep4 = r4 > 0.382;
    g('Alternation: คลื่น 2 กับ 4 มีลักษณะต่างกัน', deep2 !== deep4 ? 1 : 0.45, `${pct(r2)} / ${pct(r4)}`, 'ลึก/ตื้น สลับกัน');
  }
  if (k >= 5) {
    const r5 = leg(4, 5) / L1;
    const r5b = leg(4, 5) / (x[3] - x[0]);
    g('คลื่น 5 ≈ คลื่น 1 (หรือ 0.618)', Math.max(closeness(r5, [1.0, 0.618, 1.618], 0.2), closeness(r5b, [0.618], 0.12)), r5, '1.0 / 0.618 / 1.618');
    g('คลื่น 5 ไม่ Truncate (ผ่านยอดคลื่น 3)', x[5] > x[3] ? 1 : 0.3, null, 'ยอด 5 > ยอด 3');
    if (isNum(rsiAt(seq[3])) && isNum(rsiAt(seq[5]))) {
      const div = dirSign > 0 ? rsiAt(seq[5]) < rsiAt(seq[3]) : rsiAt(seq[5]) > rsiAt(seq[3]);
      g('RSI Divergence ระหว่างคลื่น 3 และ 5', div ? 1 : 0.45, rsiAt(seq[5]) - rsiAt(seq[3]), 'มี Divergence');
    }
  }
  if (k >= 7) {
    const LA = x[5] - x[6];
    const rB = (x[7] - x[6]) / LA;
    g('คลื่น B ย่อ 50–61.8% ของ A (Zigzag) หรือ ~100% (Flat)', Math.max(closeness(rB, [0.5, 0.618], 0.2), 0.7 * closeness(rB, [0.9, 1.0], 0.12)), rB, '0.5–0.618');
    g('คลื่น B ไม่เกินยอดคลื่น 5', x[7] < x[5] ? 1 : 0.5, null, 'B < 5');
  }
  if (k >= 8) {
    const LA = x[5] - x[6];
    const rC = (x[7] - x[8]) / LA;
    g('คลื่น C ≈ 100% หรือ 161.8% ของ A', closeness(rC, [1.0, 1.618, 0.618], 0.25), rC, '1.0 / 1.618');
  }
  // Significance of the start: wave 0 should be an extreme of the preceding swings.
  const prev = ctx.allPoints.filter((p) => p.i < seq[0].i).slice(-4);
  const startExtreme = prev.every((p) => dirSign * tf(p.price) >= x[0]);
  g('จุดเริ่ม (0) เป็นจุดต่ำสุด/สูงสุดสำคัญ', startExtreme ? 1 : 0.5, null, 'จุดสุดขั้ว');

  const avg = guides.reduce((s, q) => s + q.score, 0) / Math.max(1, guides.length);
  const evidence = 0.6 + 0.4 * Math.min(k, 5) / 5;
  const score = avg * evidence;

  // ---------- POSITION, TARGETS, INVALIDATION ----------
  const P = POSITION_TEXT[Math.min(k, 8)];
  const dirTh = dirSign > 0 ? 'รอบขาขึ้น' : 'รอบขาลง';
  const pos = { wave: P.wave, th: `${dirTh}: กำลังอยู่ใน${P.th}`, action: dirSign > 0 ? P.bull : P.bear };
  const targets = [];
  let invalidation = null;
  let invalidationNote = '';
  const T = (label, v) => targets.push({ label, price: toPrice(v) });
  const start = x[k];
  if (k === 1) {
    T('คลื่น 2 ย่อ 50%', x[1] - 0.5 * L1);
    T('คลื่น 2 ย่อ 61.8%', x[1] - 0.618 * L1);
    T('คลื่น 3 = 1.618 × คลื่น 1 (จากจุดย่อ 61.8%)', x[1] - 0.618 * L1 + 1.618 * L1);
    invalidation = toPrice(x[0]); invalidationNote = 'คลื่น 2 ห้ามย่อเกินจุดเริ่มคลื่น 1 — หลุดระดับนี้ count ผิด';
  } else if (k === 2) {
    T('คลื่น 3 = 1.0 × คลื่น 1', start + 1.0 * L1);
    T('คลื่น 3 = 1.618 × คลื่น 1', start + 1.618 * L1);
    T('คลื่น 3 = 2.618 × คลื่น 1', start + 2.618 * L1);
    invalidation = toPrice(x[2]); invalidationNote = 'ราคากลับไปต่ำกว่าจุดจบคลื่น 2 → count นี้ผิด (hard: ต่ำกว่าจุดเริ่มคลื่น 1)';
  } else if (k === 3) {
    const L3 = leg(2, 3);
    T('คลื่น 4 ย่อ 23.6%', x[3] - 0.236 * L3);
    T('คลื่น 4 ย่อ 38.2%', x[3] - 0.382 * L3);
    T('คลื่น 5 = คลื่น 1 (หลังคลื่น 4 จบ)', x[3] - 0.382 * L3 + L1);
    invalidation = toPrice(x[1]); invalidationNote = 'คลื่น 4 ห้ามทับเขตคลื่น 1 — หลุดระดับนี้ count ผิด';
  } else if (k === 4) {
    const L3 = leg(2, 3);
    T('คลื่น 5 = 0.618 × คลื่น 1', x[4] + 0.618 * L1);
    T('คลื่น 5 = 1.0 × คลื่น 1', x[4] + 1.0 * L1);
    T('คลื่น 5 = 0.618 × (0→3)', x[4] + 0.618 * (x[3] - x[0]));
    if (L3 < L1) T('เพดานคลื่น 5 (กฎ: 3 ห้ามสั้นสุด)', x[4] + L3);
    invalidation = toPrice(x[4]); invalidationNote = 'หลุดจุดจบคลื่น 4 ก่อนทำจุดสูงใหม่ → คลื่น 5 ล้มเหลว/นับผิด (hard: ทับคลื่น 1)';
  } else if (k === 5) {
    const span = x[5] - x[0];
    T('A ย่อ 38.2% ของทั้งรอบ', x[5] - 0.382 * span);
    T('A ย่อ 50% ของทั้งรอบ', x[5] - 0.5 * span);
    T('เขตคลื่น 4 ย่อย (แนวรับสำคัญ)', x[4]);
    invalidation = toPrice(x[5]); invalidationNote = 'ราคาไปไกลกว่าจุดจบคลื่น 5 → คลื่น 5 ยังไม่จบ (Extension)';
  } else if (k === 6) {
    const LA = x[5] - x[6];
    T('B เด้ง 50% ของ A', x[6] + 0.5 * LA);
    T('B เด้ง 61.8% ของ A', x[6] + 0.618 * LA);
    invalidation = toPrice(x[5]); invalidationNote = 'B ไปไกลกว่าจุดจบคลื่น 5 → อาจเป็น Expanded Flat หรือ count ผิด';
  } else if (k === 7) {
    const LA = x[5] - x[6];
    T('C = 0.618 × A', x[7] - 0.618 * LA);
    T('C = 1.0 × A', x[7] - 1.0 * LA);
    T('C = 1.618 × A', x[7] - 1.618 * LA);
    invalidation = toPrice(x[5]); invalidationNote = 'ราคาไปไกลกว่าจุดจบคลื่น 5 → การปรับฐานจบแล้ว/นับผิด';
  } else {
    T('รอบใหม่: คลื่น 1 เป้าแรก (50% ของ 5→C)', x[8] + 0.5 * (x[5] - x[8]));
    invalidation = toPrice(x[8]); invalidationNote = 'หลุดจุดจบคลื่น C → การปรับฐานยังไม่จบ';
  }

  // Trading bias implied by the current position (for the real price direction):
  // in 3 strong with-trend, in 4 buy-the-dip, in 5 late, in A/B/C against the impulse, after C a new cycle.
  const BIAS_BY_K = { 1: 0.25, 2: 1, 3: 0.35, 4: 0.2, 5: -0.8, 6: -0.45, 7: -0.3, 8: 0.5 };
  const bias = (BIAS_BY_K[Math.min(k, 8)] || 0) * dirSign;

  return {
    direction: dirSign > 0 ? 'up' : 'down',
    labels: seq.map((p, j) => ({ label: LABELS[j], i: p.i, price: p.price, type: p.type })),
    k,
    current: { ...pos, inProgressFrom: seq[k], liveExtreme: live || null },
    rules, guidelines: guides, score, conformance: avg,
    targets, invalidation, invalidationNote, bias,
  };
}

function pct(v) { return isNum(v) ? `${(v * 100).toFixed(1)}%` : '—'; }
function fmt(v) { return isNum(v) ? v.toFixed(4) : '—'; }

/**
 * Find the best Elliott counts ending at the most recent confirmed pivot.
 * @param zz output of zigzag()
 * @param ctx { rsi?: number[], useLog?: boolean, lastPrice?: number }
 */
export function countElliott(zz, ctx = {}) {
  const pts = zz.pivots;
  const live = zz.tentative || null;
  const counts = [];
  if (pts.length < 3) return { best: null, alternatives: [], note: 'จุดกลับตัว (swing) ยังไม่พอสำหรับนับคลื่น — ลองลด sensitivity หรือใช้ข้อมูลยาวขึ้น' };
  const full = { ...ctx, allPoints: pts };
  for (let k = 1; k <= 8; k++) {
    const s = pts.length - 1 - k;
    if (s < 0) break;
    const seq = pts.slice(s);
    const dirSign = seq[0].type === 'L' ? 1 : -1;
    const res = evaluate(seq, live, dirSign, full);
    if (res) counts.push(res);
  }
  counts.sort((a, b) => b.score - a.score);
  if (!counts.length) return { best: null, alternatives: [], note: 'ไม่พบ count ที่ผ่านกฎ Elliott ครบทุกข้อในช่วงล่าสุด — ตลาดอาจอยู่ในการปรับฐานซับซ้อน (W-X-Y / Triangle) หรือ Diagonal' };
  const total = counts.reduce((s, c) => s + c.score, 0);
  counts.forEach((c) => { c.relative = c.score / total; });
  return { best: counts[0], alternatives: counts.slice(1, 3), all: counts };
}

/** Elliott degree naming by timeframe (approximate, per Frost & Prechter's degree table). */
export const DEGREE = {
  '1H': 'Minuette / Subminuette', '4H': 'Minute / Minuette', '1D': 'Minor / Minute', '1W': 'Intermediate', '1M': 'Primary / Cycle',
};
