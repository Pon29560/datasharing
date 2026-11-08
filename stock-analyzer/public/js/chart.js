// Canvas charts with zero dependencies: candlesticks + overlays + RSI pane, and a
// line chart for equity curves. Pan (drag / horizontal swipe), zoom (wheel / pinch /
// buttons / +/-), crosshair tooltip (mouse, tap, keyboard arrows). DPR-aware.

import { fmtPrice, fmtDate, fmtBig, isNum } from './dom.js';

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function theme() {
  return {
    bg: cssVar('--surface', '#ffffff'),
    grid: cssVar('--grid', '#ecebe7'),
    axis: cssVar('--text-2', '#52514e'),
    text: cssVar('--text', '#0b0b0b'),
    muted: cssVar('--muted', '#8a8983'),
    up: cssVar('--up', '#16a34a'),
    down: cssVar('--down', '#dc2626'),
    cross: cssVar('--muted', '#8a8983'),
    font: '11px system-ui, -apple-system, "Segoe UI", sans-serif',
    fontBold: '600 11px system-ui, -apple-system, "Segoe UI", sans-serif',
  };
}

function niceStep(range, ticks) {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

class BaseChart {
  constructor(host, { height = 420, ariaLabel = 'กราฟ' } = {}) {
    this.host = host;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', ariaLabel);
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    host.classList.add('chart-host');
    host.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.cursor = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  resize() {
    const w = Math.max(200, this.host.clientWidth);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = w; this.hgt = this.height;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  destroy() { this.ro.disconnect(); }
}

/**
 * model = {
 *   candles, barColors?, lines?: [{values,color,width,dash,label}], band?: {a,b,up,down},
 *   markers?: [{i, side:'above'|'below', color, text}], segments?: [{pane,i1,v1,i2,v2,color,dash,width}],
 *   labels?: [{i, v, text, side, color}], hlines?: [{v,color,dash,text}], rsi?: {values}, volume?: bool,
 *   log?: bool, compare?: {values,color,label}, intraday?: bool, tzOffsetSec?: number, info?: (i)=>string[]
 * }
 */
export class CandleChart extends BaseChart {
  constructor(host, opts = {}) {
    super(host, { height: opts.height || 460, ariaLabel: opts.ariaLabel || 'กราฟแท่งเทียนพร้อมตัวชี้วัด' });
    this.m = null;
    this.view = { start: 0, count: 150 };
    this.bindEvents();
  }

  setModel(model, { keepView = false } = {}) {
    const prevN = this.m ? this.m.candles.length : 0;
    this.m = model;
    const n = model.candles.length;
    if (!keepView || prevN !== n) {
      const count = Math.min(n, model.initialBars || (this.w < 520 ? 90 : 160));
      this.view = { start: Math.max(0, n - count), count: Math.max(10, count) };
    }
    this.draw();
  }

  clampView() {
    const n = this.m ? this.m.candles.length : 0;
    this.view.count = Math.max(10, Math.min(Math.max(10, n), this.view.count));
    this.view.start = Math.max(-this.view.count * 0.3, Math.min(n - 5, this.view.start));
  }

  zoom(factor, anchorX) {
    if (!this.m) return;
    const plotW = this.w - 64;
    const ax = anchorX === undefined ? plotW : anchorX;
    const idxAtAnchor = this.view.start + (ax / plotW) * this.view.count;
    this.view.count *= factor;
    this.clampView();
    this.view.start = idxAtAnchor - (ax / plotW) * this.view.count;
    this.clampView();
    this.draw();
  }

  pan(bars) { if (!this.m) return; this.view.start += bars; this.clampView(); this.draw(); }

  reset() { if (this.m) { this.setModel(this.m); } }

  bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    let dragStart = null;
    let pinchDist = null;
    c.addEventListener('wheel', (e) => {
      if (!this.m) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); this.pan((e.deltaX / (this.w - 64)) * this.view.count); return; }
      // Mouse wheel / trackpad pinch (ctrlKey) zooms; small trackpad scrolls keep scrolling the page.
      if (!e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 50) return;
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) dragStart = { x: e.clientX, start: this.view.start, moved: false };
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); dragStart = null; }
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchDist) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) { this.zoom(pinchDist / d, (a.x + b.x) / 2 - rect.left); pinchDist = d; }
        return;
      }
      if (dragStart && pointers.size === 1) {
        const dx = e.clientX - dragStart.x;
        if (Math.abs(dx) > 4) dragStart.moved = true;
        if (dragStart.moved) {
          const bw = (this.w - 64) / this.view.count;
          this.view.start = dragStart.start - dx / bw;
          this.clampView();
        }
      }
      this.cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.draw();
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = null;
      if (pointers.size === 0) dragStart = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this.cursor = null; this.draw(); } });
    c.addEventListener('dblclick', () => this.reset());
    c.addEventListener('keydown', (e) => {
      if (!this.m) return;
      const step = Math.max(1, Math.round(this.view.count / 10));
      if (e.key === 'ArrowLeft') { this.pan(-step); e.preventDefault(); } else if (e.key === 'ArrowRight') { this.pan(step); e.preventDefault(); } else if (e.key === '+' || e.key === '=') { this.zoom(1 / 1.2); e.preventDefault(); } else if (e.key === '-') { this.zoom(1.2); e.preventDefault(); } else if (e.key === '0') { this.reset(); e.preventDefault(); }
    });
  }

  draw() {
    const ctx = this.ctx;
    const T = theme();
    const W = this.w; const H = this.hgt;
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.m || !this.m.candles.length) {
      ctx.fillStyle = T.muted; ctx.font = T.font; ctx.textAlign = 'center';
      ctx.fillText('ยังไม่มีข้อมูล', W / 2, H / 2);
      return;
    }
    const m = this.m;
    const cs = m.candles;
    const n = cs.length;
    const axisW = 64; const xAxisH = 22;
    const plotW = W - axisW;
    const hasRsi = !!(m.rsi && m.rsi.values);
    const rsiH = hasRsi ? Math.round((H - xAxisH) * 0.24) : 0;
    const priceH = H - xAxisH - rsiH - (hasRsi ? 6 : 0);
    const rsiTop = priceH + 6;
    const bw = plotW / this.view.count;
    const s = Math.max(0, Math.floor(this.view.start));
    const e = Math.min(n - 1, Math.ceil(this.view.start + this.view.count));
    const xOf = (i) => (i - this.view.start + 0.5) * bw;
    const log = !!m.log;
    const tf = (v) => (log ? Math.log(Math.max(1e-12, v)) : v);

    // compare series scaled to the first visible bar (common base on ONE axis)
    let cmp = null;
    if (m.compare && m.compare.values) {
      let base = -1;
      for (let i = s; i <= e; i++) if (isNum(m.compare.values[i]) && isNum(cs[i].c)) { base = i; break; }
      if (base >= 0) {
        const k = cs[base].c / m.compare.values[base];
        cmp = m.compare.values.map((v) => (isNum(v) ? v * k : NaN));
      }
    }
    // y-range
    let lo = Infinity; let hi = -Infinity;
    for (let i = s; i <= e; i++) { if (cs[i].l < lo) lo = cs[i].l; if (cs[i].h > hi) hi = cs[i].h; }
    for (const ln of m.lines || []) for (let i = s; i <= e; i++) { const v = ln.values[i]; if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (cmp) for (let i = s; i <= e; i++) { const v = cmp[i]; if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    const span0 = hi - lo || hi * 0.01 || 1;
    for (const hl of m.hlines || []) if (isNum(hl.v) && hl.v > lo - span0 * 0.35 && hl.v < hi + span0 * 0.35) { lo = Math.min(lo, hl.v); hi = Math.max(hi, hl.v); }
    if (log && lo <= 0) lo = hi * 0.01;
    const tlo = tf(lo); const thi = tf(hi);
    const pad = (thi - tlo) * 0.07 || 1;
    const ymin = tlo - pad; const ymax = thi + pad;
    const yOf = (v) => 6 + (1 - (tf(v) - ymin) / (ymax - ymin)) * (priceH - 12);
    const vOfY = (y) => { const t = ymin + (1 - (y - 6) / (priceH - 12)) * (ymax - ymin); return log ? Math.exp(t) : t; };

    // grid + price axis
    ctx.font = T.font;
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.grid;
    ctx.fillStyle = T.axis;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const ticks = [];
    if (log) {
      for (let k = 0; k <= 6; k++) ticks.push(Math.exp(ymin + ((ymax - ymin) * k) / 6));
    } else {
      const step = niceStep(ymax - ymin, 6);
      for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) ticks.push(v);
    }
    for (const v of ticks) {
      const y = Math.round(yOf(v)) + 0.5;
      if (y < 2 || y > priceH - 2) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
      ctx.fillText(fmtPrice(v), plotW + 6, y);
    }
    // time axis (labels at period boundaries)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.ceil(70 / bw));
    for (let i = s; i <= e; i++) {
      if ((i % labelEvery) !== 0) continue;
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = T.grid;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - xAxisH); ctx.stroke();
      ctx.fillStyle = T.axis;
      ctx.fillText(fmtDate(cs[i].t, m.intraday, m.tzOffsetSec).slice(m.intraday ? 5 : 0), x, H - xAxisH + 5);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, priceH); ctx.clip();

    // volume (bottom 18% of the price pane)
    if (m.volume) {
      let vmax = 0;
      for (let i = s; i <= e; i++) vmax = Math.max(vmax, cs[i].v || 0);
      if (vmax > 0) {
        ctx.globalAlpha = 0.28;
        for (let i = s; i <= e; i++) {
          const vh = ((cs[i].v || 0) / vmax) * priceH * 0.18;
          ctx.fillStyle = cs[i].c >= cs[i].o ? T.up : T.down;
          ctx.fillRect(xOf(i) - Math.max(1, bw * 0.35), priceH - vh, Math.max(1, bw * 0.7), vh);
        }
        ctx.globalAlpha = 1;
      }
    }
    // band (fill between two lines, colour by sign)
    if (m.band) {
      const { a, b } = m.band;
      ctx.globalAlpha = 0.12;
      for (let i = Math.max(s - 1, 0); i < e; i++) {
        if (!isNum(a[i]) || !isNum(b[i]) || !isNum(a[i + 1]) || !isNum(b[i + 1])) continue;
        ctx.fillStyle = a[i] >= b[i] ? m.band.up : m.band.down;
        ctx.beginPath();
        ctx.moveTo(xOf(i), yOf(a[i])); ctx.lineTo(xOf(i + 1), yOf(a[i + 1]));
        ctx.lineTo(xOf(i + 1), yOf(b[i + 1])); ctx.lineTo(xOf(i), yOf(b[i]));
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // overlay lines
    const drawLine = (values, color, width = 1.5, dash = null, yfn = yOf) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      ctx.beginPath();
      let pen = false;
      for (let i = Math.max(0, s - 1); i <= Math.min(n - 1, e + 1); i++) {
        const v = values[i];
        if (!isNum(v)) { pen = false; continue; }
        const x = xOf(i); const y = yfn(v);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    for (const ln of m.lines || []) drawLine(ln.values, ln.color, ln.width || 1.5, ln.dash, yOf);
    if (cmp) drawLine(cmp, m.compare.color, 1.5, null, yOf);

    // candles
    const bodyW = Math.max(1, Math.min(14, bw * 0.68));
    for (let i = s; i <= e; i++) {
      const b = cs[i];
      const col = (m.barColors && m.barColors[i]) || (b.c >= b.o ? T.up : T.down);
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yOf(b.h)); ctx.lineTo(x, yOf(b.l)); ctx.stroke();
      const y1 = yOf(Math.max(b.o, b.c)); const y2 = yOf(Math.min(b.o, b.c));
      ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
    }
    // segments on price pane
    for (const sg of (m.segments || []).filter((q) => q.pane !== 'rsi')) {
      ctx.strokeStyle = sg.color; ctx.lineWidth = sg.width || 2; ctx.setLineDash(sg.dash || []);
      ctx.beginPath(); ctx.moveTo(xOf(sg.i1), yOf(sg.v1)); ctx.lineTo(xOf(sg.i2), yOf(sg.v2)); ctx.stroke();
      ctx.setLineDash([]);
    }
    // horizontal levels
    ctx.font = T.font;
    for (const hl of m.hlines || []) {
      if (!isNum(hl.v)) continue;
      const y = Math.round(yOf(hl.v)) + 0.5;
      if (y < 0 || y > priceH) continue;
      ctx.strokeStyle = hl.color; ctx.lineWidth = 1; ctx.setLineDash(hl.dash || [5, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
      if (hl.text) {
        const tw = ctx.measureText(hl.text).width + 8;
        ctx.fillStyle = T.bg; ctx.globalAlpha = 0.85; ctx.fillRect(plotW - tw - 4, y - 15, tw, 13); ctx.globalAlpha = 1;
        ctx.fillStyle = T.text; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(hl.text, plotW - 8, y - 3);
      }
    }
    // markers (triangles)
    for (const mk of m.markers || []) {
      if (mk.i < s || mk.i > e) continue;
      const b = cs[mk.i]; const x = xOf(mk.i);
      const sz = Math.max(4, Math.min(7, bw * 0.6));
      ctx.fillStyle = mk.color;
      ctx.beginPath();
      if (mk.side === 'below') { const y = yOf(b.l) + 6; ctx.moveTo(x, y); ctx.lineTo(x - sz, y + sz * 1.6); ctx.lineTo(x + sz, y + sz * 1.6); } else { const y = yOf(b.h) - 6; ctx.moveTo(x, y); ctx.lineTo(x - sz, y - sz * 1.6); ctx.lineTo(x + sz, y - sz * 1.6); }
      ctx.closePath(); ctx.fill();
      if (mk.text && bw > 5) {
        ctx.font = T.fontBold; ctx.textAlign = 'center';
        ctx.textBaseline = mk.side === 'below' ? 'top' : 'bottom';
        ctx.fillStyle = mk.color;
        ctx.fillText(mk.text, x, mk.side === 'below' ? yOf(b.l) + 8 + sz * 1.6 : yOf(b.h) - 8 - sz * 1.6);
      }
    }
    // text labels (Elliott waves)
    ctx.font = T.fontBold;
    for (const lb of m.labels || []) {
      if (lb.i < s - 2 || lb.i > e + 2) continue;
      const x = xOf(lb.i);
      const y = yOf(lb.v) + (lb.side === 'below' ? 14 : -14);
      const tw = ctx.measureText(lb.text).width + 10;
      ctx.fillStyle = T.bg; ctx.strokeStyle = lb.color; ctx.lineWidth = 1.5;
      roundRect(ctx, x - tw / 2, y - 9, tw, 18, 9); ctx.fill(); ctx.stroke();
      ctx.fillStyle = lb.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(lb.text, x, y + 0.5);
    }
    ctx.restore();

    // last price tag
    const lastC = cs[n - 1].c;
    const ly = yOf(lastC);
    if (ly > 0 && ly < priceH) {
      ctx.fillStyle = cs[n - 1].c >= cs[n - 1].o ? T.up : T.down;
      ctx.fillRect(plotW + 1, ly - 9, axisW - 2, 18);
      ctx.fillStyle = '#ffffff'; ctx.font = T.fontBold; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtPrice(lastC), plotW + 6, ly);
    }

    // RSI pane
    let yR = null;
    if (hasRsi) {
      yR = (v) => rsiTop + 4 + (1 - v / 100) * (rsiH - 8);
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, rsiTop - 3 + 0.5); ctx.lineTo(W, rsiTop - 3 + 0.5); ctx.stroke();
      ctx.fillStyle = T.grid; ctx.globalAlpha = 0.5;
      ctx.fillRect(0, yR(70), plotW, yR(30) - yR(70));
      ctx.globalAlpha = 1;
      ctx.font = T.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = T.axis;
      for (const lv of [30, 50, 70]) {
        ctx.strokeStyle = T.muted; ctx.setLineDash(lv === 50 ? [2, 3] : [4, 3]);
        ctx.beginPath(); ctx.moveTo(0, Math.round(yR(lv)) + 0.5); ctx.lineTo(plotW, Math.round(yR(lv)) + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(String(lv), plotW + 6, yR(lv));
      }
      ctx.fillText('RSI 14', 6, rsiTop + 8);
      ctx.save(); ctx.beginPath(); ctx.rect(0, rsiTop, plotW, rsiH); ctx.clip();
      drawLine(m.rsi.values, m.rsi.color || cssVar('--series-7', '#6250d6'), 1.5, null, yR);
      for (const sg of (m.segments || []).filter((q) => q.pane === 'rsi')) {
        ctx.strokeStyle = sg.color; ctx.lineWidth = sg.width || 2; ctx.setLineDash(sg.dash || []);
        ctx.beginPath(); ctx.moveTo(xOf(sg.i1), yR(sg.v1)); ctx.lineTo(xOf(sg.i2), yR(sg.v2)); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // crosshair + tooltip
    if (this.cursor && this.cursor.x < plotW) {
      const i = Math.max(0, Math.min(n - 1, Math.floor(this.view.start + this.cursor.x / bw)));
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = T.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - xAxisH); ctx.stroke();
      if (this.cursor.y < priceH) {
        const y = Math.round(this.cursor.y) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = T.text; ctx.fillRect(plotW + 1, y - 9, axisW - 2, 18);
        ctx.fillStyle = T.bg; ctx.font = T.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtPrice(vOfY(y)), plotW + 6, y);
      }
      ctx.setLineDash([]);
      this.showTip(i, x, plotW);
    } else this.tip.hidden = true;
  }

  showTip(i, x, plotW) {
    const m = this.m; const b = m.candles[i];
    const prev = i > 0 ? m.candles[i - 1].c : b.o;
    const lines = [
      fmtDate(b.t, m.intraday, m.tzOffsetSec),
      `O ${fmtPrice(b.o)}  H ${fmtPrice(b.h)}`,
      `L ${fmtPrice(b.l)}  C ${fmtPrice(b.c)}`,
      `เปลี่ยนแปลง ${(((b.c / prev) - 1) * 100).toFixed(2)}%  Vol ${fmtBig(b.v)}`,
    ];
    if (m.rsi && isNum(m.rsi.values[i])) lines.push(`RSI ${m.rsi.values[i].toFixed(1)}`);
    if (m.info) for (const t of m.info(i)) lines.push(t);
    const tip = this.tip;
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    lines.forEach((t, k) => { const d = document.createElement('div'); d.textContent = t; if (k === 0) d.className = 'tip-head'; tip.append(d); });
    tip.hidden = false;
    const left = x > plotW / 2 ? 8 : plotW - 8 - Math.min(230, tip.offsetWidth || 200);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = '8px';
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Line chart for equity curves etc.
 * model = { t: number[], series: [{values, color, label, width?, dash?}], log?: bool, yFormat?: fn, area?: bool, range?: [min,max], refLines?: [{v,color,text}] }
 */
export class LineChart extends BaseChart {
  constructor(host, opts = {}) {
    super(host, { height: opts.height || 280, ariaLabel: opts.ariaLabel || 'กราฟเส้น' });
    this.m = null;
    this.canvas.addEventListener('pointermove', (e) => { const r = this.canvas.getBoundingClientRect(); this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.cursor = null; this.draw(); });
  }

  setModel(m) { this.m = m; this.draw(); }

  draw() {
    const ctx = this.ctx; const T = theme(); const W = this.w; const H = this.hgt;
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    const m = this.m;
    if (!m || !m.t || m.t.length < 2) { ctx.fillStyle = T.muted; ctx.font = T.font; ctx.textAlign = 'center'; ctx.fillText('ยังไม่มีข้อมูล', W / 2, H / 2); return; }
    const axisW = 64; const xAxisH = 22; const plotW = W - axisW; const plotH = H - xAxisH;
    const n = m.t.length;
    let lo = Infinity; let hi = -Infinity;
    for (const s of m.series) for (const v of s.values) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const r of m.refLines || []) { lo = Math.min(lo, r.v); hi = Math.max(hi, r.v); }
    if (m.range) { lo = m.range[0]; hi = m.range[1]; }
    if (!Number.isFinite(lo)) return;
    const log = !!m.log && lo > 0;
    const tf = (v) => (log ? Math.log(v) : v);
    const pad = (tf(hi) - tf(lo)) * 0.06 || 1;
    const ymin = tf(lo) - (m.range ? 0 : pad); const ymax = tf(hi) + (m.range ? 0 : pad);
    const xOf = (k) => (k / (n - 1)) * (plotW - 8) + 4;
    const yOf = (v) => 6 + (1 - (tf(v) - ymin) / (ymax - ymin)) * (plotH - 12);
    const yfmt = m.yFormat || ((v) => fmtPrice(v));
    ctx.font = T.font; ctx.lineWidth = 1; ctx.strokeStyle = T.grid; ctx.fillStyle = T.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const ticks = [];
    if (log) for (let k = 0; k <= 5; k++) ticks.push(Math.exp(ymin + ((ymax - ymin) * k) / 5));
    else { const step = niceStep(ymax - ymin, 5); for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) ticks.push(v); }
    for (const v of ticks) { const y = Math.round(yOf(v)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.fillText(yfmt(v), plotW + 6, y); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
    for (let k = 0; k < n; k += every) ctx.fillText(fmtDate(m.t[k]), xOf(k), plotH + 5);
    for (const vl of m.vlines || []) {
      if (!(vl.k >= 0 && vl.k < n)) continue;
      const x = Math.round(xOf(vl.k)) + 0.5;
      ctx.strokeStyle = vl.color || T.muted; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke(); ctx.setLineDash([]);
      if (vl.text) { ctx.fillStyle = T.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(vl.text, x + 4, 4); }
    }
    for (const r of m.refLines || []) {
      const y = Math.round(yOf(r.v)) + 0.5;
      ctx.strokeStyle = r.color || T.muted; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const s of m.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []);
      ctx.beginPath(); let pen = false;
      for (let k = 0; k < n; k++) { const v = s.values[k]; if (!isNum(v)) { pen = false; continue; } const x = xOf(k); const y = yOf(v); if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      if (m.area && s === m.series[0]) {
        ctx.lineTo(xOf(n - 1), yOf(Math.max(lo, Math.min(hi, 0)))); ctx.lineTo(xOf(0), yOf(Math.max(lo, Math.min(hi, 0)))); ctx.closePath();
        ctx.globalAlpha = 0.12; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    if (this.cursor && this.cursor.x < plotW) {
      const k = Math.max(0, Math.min(n - 1, Math.round(((this.cursor.x - 4) / (plotW - 8)) * (n - 1))));
      const x = Math.round(xOf(k)) + 0.5;
      ctx.strokeStyle = T.cross; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke(); ctx.setLineDash([]);
      for (const s of m.series) if (isNum(s.values[k])) { ctx.fillStyle = s.color; ctx.strokeStyle = T.bg; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, yOf(s.values[k]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      const tip = this.tip;
      while (tip.firstChild) tip.removeChild(tip.firstChild);
      const head = document.createElement('div'); head.className = 'tip-head'; head.textContent = fmtDate(m.t[k]); tip.append(head);
      for (const s of m.series) { const d = document.createElement('div'); const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = s.color; d.append(sw, document.createTextNode(` ${s.label}: ${yfmt(s.values[k])}`)); tip.append(d); }
      tip.hidden = false;
      tip.style.left = `${x > plotW / 2 ? 8 : Math.max(8, plotW - 8 - (tip.offsetWidth || 180))}px`;
      tip.style.top = '8px';
    } else this.tip.hidden = true;
  }
}
