// Signal Lab — UI controller. All analysis runs locally from ../core (same code as the tests).
import { h, clear, fmtPrice, fmtPct, fmtNum, fmtDate, timeAgo, scoreBar, gauge, pill, download, isNum } from './dom.js';
import { CandleChart, LineChart } from './chart.js';
import { analyzeAll, TF_LABEL } from '../core/analyze.js';
import { analyzeNews, sentimentLabel, HORIZONS as NEWS_H } from '../core/sentiment.js';
import { validateStrategy } from '../core/validation.js';
import { STRATEGIES } from '../core/strategies.js';
import { edgeStudy } from '../core/edge.js';
import { PRINCIPLES } from '../core/principles.js';
import { ZONES } from '../core/cdc.js';
import { CLIMAX_TEXT } from '../core/psychology.js';
import { adjustCandles, mapHigherTFStepped, toWeekly } from '../core/resample.js';
import { parseCsv } from '../core/csv.js';

const SYMBOL_RE = /^[A-Za-z0-9^=.\-]{1,24}$/;
const QUERY_RE = /^[\p{L}\p{M}\p{N} .&'\-^=]{1,80}$/u;
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const DEFAULT_SETTINGS = { capital: 100000, riskPct: 1, sensitivity: 'standard', adjust: false };
const DEFAULT_CHART = { cdcBars: true, cdcEma: true, ema50200: false, signals: true, divs: true, elliott: true, zigzag: false, volume: true, rsi: true, log: false, htf: false };
const DEFAULT_WATCH = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'PTT.BK', 'ADVANC.BK', 'BTC-USD', 'GC=F', '^SET.BK'];

const S = {
  reqId: 0, symbol: null, meta: null, rawDaily: null, hourly: null, analysis: null,
  newsRaw: null, news: null, newsStatus: 'idle', newsError: '',
  settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...store.get('sl.settings', {}) }),
  chartOpts: { ...DEFAULT_CHART, ...store.get('sl.chart', {}) },
  chartTF: '1D', compare: null, bt: null, edge: null, tab: 'summary', charts: {},
};

// Charts own a ResizeObserver; disconnect them before their panel is rebuilt (no leaks).
const miniCharts = { elliott: [], psych: [], backtest: [] };
const track = (group, chart) => { miniCharts[group].push(chart); return chart; };
function dropCharts(group) { for (const c of miniCharts[group]) c.destroy(); miniCharts[group] = []; }

function sanitizeSettings(s) {
  return {
    capital: isNum(+s.capital) && +s.capital > 0 ? +s.capital : DEFAULT_SETTINGS.capital,
    riskPct: isNum(+s.riskPct) && +s.riskPct > 0 && +s.riskPct <= 10 ? +s.riskPct : DEFAULT_SETTINGS.riskPct,
    sensitivity: ['fine', 'standard', 'coarse'].includes(s.sensitivity) ? s.sensitivity : 'standard',
    adjust: !!s.adjust,
  };
}

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    s1: v('--series-1'), s2: v('--series-2'), s3: v('--series-3'), s4: v('--series-4'), s5: v('--series-5'), s7: v('--series-7'),
    zGreen: v('--zone-green'), zRed: v('--zone-red'), zYellow: v('--zone-yellow'), zBlue: v('--zone-blue'),
    good: v('--good'), bad: v('--critical'), muted: v('--muted'), ew: v('--ew'), target: v('--series-3'),
  };
}

// ------------------------------------------------------------------ data
async function api(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`api/${path}?${qs}`, { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((body && typeof body.error === 'string' && body.error.slice(0, 200)) || `เกิดข้อผิดพลาด (HTTP ${res.status})`);
  return body;
}

function toCandles(arr) {
  const out = [];
  for (const r of Array.isArray(arr) ? arr : []) {
    if (!Array.isArray(r)) continue;
    const [t, o, hi, lo, c, v, adj] = r;
    if (![t, o, hi, lo, c].every(isNum)) continue;
    out.push({ t, o, h: hi, l: lo, c, v: isNum(v) ? v : 0, adj: isNum(adj) ? adj : undefined });
  }
  return out;
}

const daily = () => (S.settings.adjust ? adjustCandles(S.rawDaily) : S.rawDaily);
const hourly = () => S.hourly; // intraday feeds carry no dividend adjustment

function recompute() {
  if (!S.rawDaily) return;
  S.analysis = analyzeAll({ daily: daily(), hourly: hourly(), meta: S.meta, news: S.news, settings: S.settings });
}

function setStatus(kind, text) {
  const el = $('status');
  clear(el);
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.append(h('span', { class: kind === 'loading' ? 'spinner' : '' }), h('span', { text }));
}

function shortName(name) {
  if (!name) return '';
  const s = name.replace(/\b(Inc|Incorporated|Corp|Corporation|Company|Co|Ltd|Limited|PLC|Public Company Limited|Holdings?|Group|N\.V|S\.A|AG|SE)\b\.?,?/gi, '').replace(/[,.]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return QUERY_RE.test(s) ? s.slice(0, 80) : '';
}

async function load(symbolInput) {
  const symbol = String(symbolInput || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) { setStatus('error', 'สัญลักษณ์ไม่ถูกต้อง — ใช้ A-Z 0-9 . - ^ = เช่น AAPL, PTT.BK, BTC-USD, ^SET.BK, GC=F'); return; }
  const my = ++S.reqId;
  setStatus('loading', `กำลังดึงข้อมูลราคา ${symbol} …`);
  try {
    const d = await api('candles', { symbol, interval: '1d' });
    if (my !== S.reqId) return;
    const candles = toCandles(d.candles);
    if (candles.length < 40) throw new Error('ข้อมูลราคาน้อยเกินไปสำหรับการวิเคราะห์');
    Object.assign(S, { symbol, meta: d, rawDaily: candles, hourly: null, newsRaw: null, news: null, newsStatus: 'idle', compare: null, bt: null, edge: null });
    if (!['1D', '1W', '1M'].includes(S.chartTF)) S.chartTF = '1D';
    recompute();
    setStatus('', '');
    try { history.replaceState(null, '', `#${encodeURIComponent(symbol)}`); } catch { /* file:// */ }
    remember(symbol);
    renderAll();
    loadNews(my);
  } catch (e) {
    if (my === S.reqId) setStatus('error', e.message || 'ดึงข้อมูลไม่สำเร็จ');
  }
}

function loadFromCsv(name, candles) {
  const my = ++S.reqId;
  const sym = (name.replace(/\.[^.]+$/, '').toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '').slice(0, 24)) || 'CSV';
  Object.assign(S, { symbol: sym, meta: { symbol: sym, name: `นำเข้าจากไฟล์ ${name.slice(0, 60)}`, currency: '', exchange: 'CSV', tzOffsetSec: 0, source: 'ไฟล์ CSV ของผู้ใช้' }, rawDaily: candles, hourly: null, newsRaw: null, news: null, newsStatus: 'csv', compare: null, bt: null, edge: null });
  S.chartTF = '1D';
  recompute();
  setStatus('', '');
  renderAll();
  void my;
}

async function loadNews(my) {
  S.newsStatus = 'loading';
  renderNews();
  try {
    const d = await api('news', { symbol: S.symbol, q: shortName(S.meta && S.meta.name) });
    if (my !== S.reqId) return;
    S.newsRaw = d;
    const items = (Array.isArray(d.items) ? d.items : []).filter((x) => x && typeof x.title === 'string');
    S.news = items.length ? analyzeNews(items) : null;
    S.newsStatus = 'ok';
    recompute();
    renderAll({ keepChart: true });
  } catch (e) {
    if (my !== S.reqId) return;
    S.newsStatus = 'error';
    S.newsError = e.message;
    renderNews();
  }
}

async function ensureHourly() {
  if (S.hourly || !S.symbol || S.meta.exchange === 'CSV') return;
  const my = S.reqId;
  setStatus('loading', 'กำลังดึงข้อมูลรายชั่วโมง (ย้อนหลัง ~2 ปี) …');
  try {
    const d = await api('candles', { symbol: S.symbol, interval: '1h' });
    if (my !== S.reqId) return;
    S.hourly = toCandles(d.candles);
    recompute();
    setStatus('', '');
  } catch (e) {
    setStatus('error', `ข้อมูลรายชั่วโมง: ${e.message}`);
  }
}

function remember(sym) {
  const rec = store.get('sl.recent', []).filter((x) => typeof x === 'string' && SYMBOL_RE.test(x) && x !== sym);
  rec.unshift(sym);
  store.set('sl.recent', rec.slice(0, 8));
  renderQuick();
}

// ------------------------------------------------------------------ shell
function renderQuick() {
  const box = clear($('quick'));
  const rec = store.get('sl.recent', []).filter((x) => typeof x === 'string' && SYMBOL_RE.test(x));
  const list = [...new Set([...rec, 'DEMO', 'AAPL', 'NVDA', 'PTT.BK', 'BTC-USD', 'GC=F', '^SET.BK'])].slice(0, 10);
  for (const s of list) box.append(h('button', { type: 'button', class: 'chip', onclick: () => { $('symbol').value = s; load(s); } }, s));
}

function switchTab(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll('[role="tab"]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${tab}`;
  if (tab === 'chart') renderChart(true);
  if (tab === 'backtest' && S.rawDaily && !S.bt) renderBacktest();
}

function renderAll({ keepChart = false } = {}) {
  renderHeader();
  renderSummary();
  renderChart(keepChart);
  renderElliott();
  renderNews();
  renderPsych();
  renderBacktest();
}

function needData(panel) {
  clear(panel).append(h('div', { class: 'empty' },
    h('p', { text: 'พิมพ์สัญลักษณ์แล้วกด “วิเคราะห์” — เช่น AAPL (หุ้นสหรัฐ), PTT.BK (หุ้นไทย), BTC-USD (คริปโต), GC=F (ทองคำ), ^SET.BK (ดัชนี SET)' }),
    h('p', { text: 'หรือกด DEMO เพื่อลองระบบด้วยข้อมูลจำลอง / นำเข้าไฟล์ CSV ของคุณเอง' })));
}

function renderHeader() {
  const el = clear($('asset'));
  if (!S.analysis) { el.hidden = true; return; }
  el.hidden = false;
  const d = daily();
  const last = d[d.length - 1]; const prev = d[d.length - 2];
  const ch = last.c / prev.c - 1;
  el.append(
    h('div', { class: 'asset-main' },
      h('div', {}, h('h1', { text: S.meta.name || S.symbol }), h('div', { class: 'sub', text: [S.symbol, S.meta.exchange, S.meta.currency].filter(Boolean).join(' · ') })),
      h('div', { class: 'asset-price' }, h('div', { class: 'big', text: fmtPrice(last.c) }), h('div', { class: `chg ${ch >= 0 ? 'up' : 'down'}`, text: `${fmtPct(ch, 2, true)} (วันล่าสุด)` }))),
    h('div', { class: 'asset-meta' },
      h('span', { text: `ข้อมูลถึง ${fmtDate(last.t, false, S.meta.tzOffsetSec || 0)}` }),
      h('span', { text: `แหล่งข้อมูล: ${S.meta.source || '—'}` }),
      h('span', { text: `${d.length.toLocaleString()} แท่งรายวัน (${((last.t - d[0].t) / 31557600000).toFixed(1)} ปี)` }),
      S.settings.adjust ? pill('ราคาปรับปันผล', 'neutral') : null,
      S.meta.instrumentType === 'DEMO' ? pill('ข้อมูลจำลอง — ไม่ใช่ราคาจริง', 'warn') : null));
}

// ------------------------------------------------------------------ summary
function componentList(comps) {
  return h('ul', { class: 'comps' }, comps.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).map((c) => h('li', {},
    h('span', { class: `cv ${c.value > 0 ? 'pos' : c.value < 0 ? 'neg' : ''}`, text: `${c.value > 0 ? '+' : ''}${c.value.toFixed(1)}` }),
    h('div', {}, h('div', { class: 'cl', text: c.label }), h('div', { class: 'cw', text: c.why })))));
}

function planBlock(plan, currency) {
  if (!plan) return null;
  const rows = [];
  if (plan.stance === 'long' && plan.entry) rows.push(['จุดเข้า', `${fmtPrice(plan.entry.zoneLow)} – ${fmtPrice(plan.entry.zoneHigh)}`]);
  if (plan.stance === 'pullback' && plan.entry) rows.push(['จุดเข้าที่คุ้มความเสี่ยง', `≤ ${fmtPrice(plan.entry.price)} (R:R 1:2)`]);
  rows.push([plan.stance === 'long' ? 'Stop loss' : 'Stop (สำหรับผู้ถืออยู่)', `${fmtPrice(plan.stop.price)}  (${plan.stop.why})`]);
  plan.targets.forEach((t, k) => rows.push([`เป้าหมาย ${k + 1}`, `${fmtPrice(t.price)}  (${t.r.toFixed(1)}R · ${t.why})`]));
  if (plan.stance === 'long' || plan.stance === 'pullback') {
    rows.push(['Risk : Reward (ที่ราคาปัจจุบัน)', isNum(plan.rr) ? `1 : ${plan.rr.toFixed(2)}` : '—']);
    rows.push(['ขนาดสถานะ', `${plan.size.toLocaleString()} หน่วย (เสี่ยง ${plan.riskPct}% ของทุน ${plan.capital.toLocaleString()} ${currency || ''})`]);
  }
  return h('div', { class: 'plan' },
    h('div', { class: `plan-stance ${plan.stance}`, text: { long: 'แผน: ซื้อ/ถือ ตามเงื่อนไข', pullback: 'แผน: แนวโน้มบวก — รอย่อเพื่อจุดเข้าที่คุ้ม', avoid: 'แผน: ยังไม่ซื้อ / ผู้ถือป้องกันความเสี่ยง', wait: 'แผน: รอสัญญาณยืนยัน' }[plan.stance] }),
    h('table', { class: 'kv' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', { text: v }))))),
    h('p', { class: 'note', text: plan.note }),
    h('div', { class: 'triggers' },
      h('div', {}, h('h4', { text: 'จะซื้อเมื่อ…' }), h('ul', {}, plan.buyTriggers.map((t) => h('li', { text: t })))),
      h('div', {}, h('h4', { text: 'จะขาย/ออกเมื่อ…' }), h('ul', {}, plan.sellTriggers.map((t) => h('li', { text: t }))))));
}

function narrative(a) {
  const parts = [];
  for (const k of ['long', 'medium', 'short']) {
    const hz = a.horizons[k];
    if (!hz || hz.insufficient) continue;
    const top = hz.components.slice().sort((x, y) => Math.abs(y.value) - Math.abs(x.value)).slice(0, 2).map((c) => c.label);
    parts.push(`${hz.th} (${hz.tf}): ${hz.verdict.th} — เหตุผลหลัก: ${top.join(' และ ')}`);
  }
  return parts;
}

function renderSummary() {
  const p = $('tab-summary');
  if (!S.analysis) return needData(p);
  const a = S.analysis;
  clear(p);
  p.append(h('div', { class: `banner ${a.alignment.tone}` }, h('strong', { text: 'ภาพรวมหลายกรอบเวลา: ' }), a.alignment.th));
  p.append(h('div', { class: 'card' }, h('h3', { text: 'สรุปภาษาคน' }), h('ul', { class: 'narr' }, narrative(a).map((t) => h('li', { text: t })))));
  const grid = h('div', { class: 'grid3' });
  for (const k of ['short', 'medium', 'long']) {
    const hz = a.horizons[k];
    if (!hz || hz.insufficient) { grid.append(h('div', { class: 'card' }, h('h3', { text: hz ? `${hz.th} — ${hz.tf}` : k }), h('p', { class: 'muted', text: hz ? hz.note : '—' }))); continue; }
    grid.append(h('div', { class: 'card horizon' },
      h('div', { class: 'hz-head' }, h('div', {}, h('h3', { text: hz.th }), h('div', { class: 'sub', text: `${hz.tf} · ${hz.hold}` })), pill(hz.verdict.th, hz.verdict.tone)),
      h('div', { class: 'score-row' }, h('span', { class: 'score-num', text: `${hz.score > 0 ? '+' : ''}${Math.round(hz.score)}` }), scoreBar(hz.score)),
      hz.forming ? h('p', { class: 'note warn', text: 'แท่งล่าสุดของกรอบนี้ยังไม่ปิด — สัญญาณอาจเปลี่ยนได้จนกว่าจะปิดแท่ง' }) : null,
      h('details', { open: k === 'short' }, h('summary', { text: 'ส่วนประกอบของคะแนน (ตรวจสอบได้ทุกข้อ)' }), componentList(hz.components)),
      planBlock(hz.plan, S.meta.currency)));
  }
  p.append(grid);
  // quick facts per TF
  const facts = h('div', { class: 'card' }, h('h3', { text: 'ค่าตัวชี้วัดล่าสุดแยกตาม Timeframe' }));
  const tbl = h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Timeframe', 'CDC Zone', 'RSI(14)', 'Divergence ล่าสุด', 'Elliott (count หลัก)', 'Invalidation'].map((x) => h('th', { text: x })))));
  const tb = h('tbody');
  for (const tf of ['4H', '1D', '1W', '1M']) {
    const t = a.ta[tf];
    if (!t) continue;
    if (t.insufficient) { tb.append(h('tr', {}, h('td', { text: TF_LABEL[tf] }), h('td', { colspan: '5', class: 'muted', text: t.note }))); continue; }
    const d = t.recentDivergences[0];
    const ew = t.elliott.best;
    tb.append(h('tr', {},
      h('td', { text: TF_LABEL[tf] }),
      h('td', {}, t.cdc ? zoneChip(t.cdc.zone) : '—'),
      h('td', { text: `${fmtNum(t.rsi.value, 1)} · ${t.rsi.state.label}` }),
      h('td', { text: d ? `${d.th} (${t.n - 1 - d.confirmedAt} แท่งก่อน)` : 'ไม่มีในช่วงล่าสุด' }),
      h('td', { text: ew ? ew.current.th : (t.elliott.note || '—') }),
      h('td', { text: ew ? fmtPrice(ew.invalidation) : '—' })));
  }
  tbl.append(tb);
  facts.append(h('div', { class: 'scroll-x' }, tbl));
  p.append(facts);
  p.append(settingsCard());
}

function zoneChip(z) {
  if (!z) return h('span', { text: '—' });
  return h('span', { class: `zone z-${z}`, text: ZONES[z].th });
}

function settingsCard() {
  const st = S.settings;
  const save = () => {
    S.settings = sanitizeSettings({ capital: $('setCapital').value, riskPct: $('setRisk').value, sensitivity: $('setSens').value, adjust: $('setAdjust').checked });
    store.set('sl.settings', S.settings);
    S.bt = null; S.edge = null;
    recompute(); renderAll({ keepChart: true });
  };
  return h('details', { class: 'card settings' }, h('summary', { text: 'ตั้งค่าการวิเคราะห์และขนาดเงินลงทุน' }),
    h('div', { class: 'form-grid' },
      h('label', {}, 'เงินทุน', h('input', { id: 'setCapital', type: 'number', min: '1', step: '1000', value: String(st.capital), onchange: save })),
      h('label', {}, 'ความเสี่ยงต่อไม้ (%)', h('input', { id: 'setRisk', type: 'number', min: '0.1', max: '10', step: '0.1', value: String(st.riskPct), onchange: save })),
      h('label', {}, 'ขนาดคลื่น/Swing (Elliott)', h('select', { id: 'setSens', onchange: save },
        [['fine', 'ละเอียด (คลื่นย่อย)'], ['standard', 'มาตรฐาน'], ['coarse', 'หยาบ (คลื่นใหญ่)']].map(([v, t]) => h('option', { value: v, selected: st.sensitivity === v }, t)))),
      h('label', { class: 'check' }, h('input', { id: 'setAdjust', type: 'checkbox', checked: st.adjust, onchange: save }), 'ใช้ราคาปรับปันผล/Split (Total return)')));
}

// ------------------------------------------------------------------ chart
function alignCompare(main, cmp) {
  const out = new Array(main.length).fill(NaN);
  let j = 0; let lastVal = NaN;
  for (let i = 0; i < main.length; i++) {
    const end = i + 1 < main.length ? main[i + 1].t : Infinity;
    while (j < cmp.length && cmp[j].t < end) { lastVal = cmp[j].c; j++; }
    out[i] = lastVal;
  }
  return out;
}

export function chartModel(t, opts, extra = {}) {
  const C = colors();
  const cs = t.candles;
  const cdc = t.series.cdc;
  const zc = { green: C.zGreen, red: C.zRed, yellow: C.zYellow, blue: C.zBlue };
  const m = {
    candles: cs, intraday: t.tf === '1H' || t.tf === '4H', tzOffsetSec: (S.meta && S.meta.tzOffsetSec) || 0,
    volume: opts.volume, log: opts.log, lines: [], markers: [], segments: [], labels: [], hlines: [],
    rsi: opts.rsi ? { values: t.series.rsi, color: C.s7 } : null,
    info: (i) => [cdc.zone[i] ? `CDC: ${ZONES[cdc.zone[i]].th}` : ''].filter(Boolean),
    initialBars: extra.initialBars,
  };
  if (opts.cdcBars) m.barColors = cdc.zone.map((z) => (z ? zc[z] : null));
  if (opts.cdcEma) {
    m.lines.push({ values: cdc.fast, color: C.s2, width: 1.5 }, { values: cdc.slow, color: C.s1, width: 1.5 });
    m.band = { a: cdc.fast, b: cdc.slow, up: C.zGreen, down: C.zRed };
  }
  if (opts.ema50200) m.lines.push({ values: t.series.ema50, color: C.s3, width: 1.5 }, { values: t.series.ema200, color: C.s5, width: 2 });
  if (opts.htf && t.tf === '1D' && S.analysis.ta['1W'] && !S.analysis.ta['1W'].insufficient) {
    const w = S.analysis.ta['1W'];
    m.lines.push({ values: mapHigherTFStepped(cs.length, S.analysis.tfs['1W'], w.series.cdc.fast), color: C.s2, width: 2.5, dash: [6, 4] });
    m.lines.push({ values: mapHigherTFStepped(cs.length, S.analysis.tfs['1W'], w.series.cdc.slow), color: C.s1, width: 2.5, dash: [6, 4] });
  }
  if (opts.signals) cs.forEach((_, i) => {
    if (cdc.buy[i]) m.markers.push({ i, side: 'below', color: C.zGreen, text: 'BUY' });
    if (cdc.sell[i]) m.markers.push({ i, side: 'above', color: C.zRed, text: 'SELL' });
  });
  if (opts.divs) for (const d of t.divergences) {
    const bull = d.type.endsWith('Bull');
    const col = bull ? C.good : C.bad;
    const dash = d.type.startsWith('hidden') ? [5, 4] : null;
    m.segments.push({ pane: 'price', i1: d.i1, v1: d.price1, i2: d.i2, v2: d.price2, color: col, dash, width: 2 });
    m.segments.push({ pane: 'rsi', i1: d.i1, v1: d.rsi1, i2: d.i2, v2: d.rsi2, color: col, dash, width: 2 });
  }
  const zz = extra.zigzag || t.zigzag;
  if (opts.zigzag) {
    const pts = zz.pivots;
    for (let k = 1; k < pts.length; k++) m.segments.push({ pane: 'price', i1: pts[k - 1].i, v1: pts[k - 1].price, i2: pts[k].i, v2: pts[k].price, color: C.muted, width: 1 });
  }
  const ew = extra.count || (t.elliott && t.elliott.best);
  if (opts.elliott && ew) {
    const L = ew.labels;
    for (let k = 1; k < L.length; k++) m.segments.push({ pane: 'price', i1: L[k - 1].i, v1: L[k - 1].price, i2: L[k].i, v2: L[k].price, color: C.ew, width: 2 });
    for (const lb of L) m.labels.push({ i: lb.i, v: lb.price, text: lb.label, side: lb.type === 'H' ? 'above' : 'below', color: C.ew });
    const live = ew.current.liveExtreme;
    const lastL = L[L.length - 1];
    if (live && live.i > lastL.i) {
      m.segments.push({ pane: 'price', i1: lastL.i, v1: lastL.price, i2: live.i, v2: live.price, color: C.ew, width: 2, dash: [5, 4] });
      m.labels.push({ i: live.i, v: live.price, text: `(${ew.current.wave})?`, side: live.type === 'H' ? 'above' : 'below', color: C.ew });
    }
    for (const tg of ew.targets) m.hlines.push({ v: tg.price, color: C.target, text: `เป้า: ${tg.label} ${fmtPrice(tg.price)}`, dash: [2, 3] });
    if (isNum(ew.invalidation)) m.hlines.push({ v: ew.invalidation, color: C.bad, text: `Invalidation ${fmtPrice(ew.invalidation)}`, dash: [6, 3] });
  }
  if (S.compare && S.compare.candles && !m.intraday) m.compare = { values: alignCompare(cs, S.compare.candles), color: C.s4, label: S.compare.symbol };
  return m;
}

function legendItem(color, text, dashed = false) {
  return h('span', { class: 'lg' }, h('span', { class: `sw${dashed ? ' dashed' : ''}`, style: { borderColor: color, background: dashed ? 'transparent' : color } }), text);
}

async function renderChart(keep = false) {
  const p = $('tab-chart');
  if (!S.analysis) return needData(p);
  if (S.tab !== 'chart' && S.charts.main) { S.charts.dirty = true; return; }
  if ((S.chartTF === '1H' || S.chartTF === '4H') && !S.hourly) { await ensureHourly(); if (!S.hourly) S.chartTF = '1D'; }
  const t = S.analysis.ta[S.chartTF];
  const o = S.chartOpts;
  if (!S.charts.mainHost || !p.contains(S.charts.mainHost)) {
    clear(p);
    const tfBar = h('div', { class: 'seg', role: 'group', 'aria-label': 'Timeframe' });
    const toggles = h('div', { class: 'toggles' });
    const cmp = h('form', { class: 'compare', onsubmit: (e) => { e.preventDefault(); loadCompare($('cmpSym').value); } },
      h('input', { id: 'cmpSym', placeholder: 'ซ้อนกราฟ เช่น ^GSPC, SPY, ^SET.BK', maxlength: '24', spellcheck: 'false', autocapitalize: 'characters' }),
      h('button', { type: 'submit', text: 'ซ้อน' }),
      h('button', { type: 'button', class: 'ghost', text: 'ล้าง', onclick: () => { S.compare = null; renderChart(true); } }));
    const zoom = h('div', { class: 'seg' },
      h('button', { type: 'button', 'aria-label': 'ซูมเข้า', text: '+', onclick: () => S.charts.main.zoom(1 / 1.25) }),
      h('button', { type: 'button', 'aria-label': 'ซูมออก', text: '−', onclick: () => S.charts.main.zoom(1.25) }),
      h('button', { type: 'button', text: 'รีเซ็ต', onclick: () => S.charts.main.reset() }));
    const host = h('div', { class: 'chart-main' });
    p.append(h('div', { class: 'card' }, h('div', { class: 'chart-toolbar' }, tfBar, zoom, cmp),
      h('details', { class: 'toggles-wrap', open: window.innerWidth >= 700 }, h('summary', { text: 'เลือกสิ่งที่แสดงบนกราฟ' }), toggles),
      h('div', { class: 'legend', id: 'chartLegend' }), host, h('p', { class: 'hint', text: 'ลากซ้าย-ขวาเพื่อเลื่อน · ล้อเมาส์/Pinch เพื่อซูม · ดับเบิลคลิกเพื่อรีเซ็ต · แตะ/ชี้เพื่อดูค่า' })),
      h('div', { class: 'card', id: 'chartNotes' }));
    S.charts.mainHost = host;
    if (S.charts.main) S.charts.main.destroy();
    S.charts.main = new CandleChart(host, { height: window.innerWidth < 600 ? 440 : 560 });
    S.charts.tfBar = tfBar; S.charts.toggles = toggles;
  }
  // timeframe buttons
  clear(S.charts.tfBar);
  for (const tf of ['1H', '4H', '1D', '1W', '1M']) {
    const disabled = (tf === '1H' || tf === '4H') && S.meta.exchange === 'CSV';
    S.charts.tfBar.append(h('button', { type: 'button', class: S.chartTF === tf ? 'on' : '', 'aria-pressed': S.chartTF === tf ? 'true' : 'false', disabled, text: tf, onclick: () => { S.chartTF = tf; renderChart(false); } }));
  }
  clear(S.charts.toggles);
  const T = [['cdcBars', 'แท่งสี CDC'], ['cdcEma', 'EMA 12/26 (CDC)'], ['signals', 'สัญญาณ Buy/Sell'], ['divs', 'RSI Divergence'], ['elliott', 'Elliott Wave'], ['zigzag', 'ZigZag'], ['ema50200', 'EMA 50/200'], ['htf', 'EMA Weekly บน Daily'], ['volume', 'Volume'], ['rsi', 'RSI'], ['log', 'Log scale']];
  for (const [k, label] of T) {
    S.charts.toggles.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!o[k], onchange: (e) => { o[k] = e.target.checked; store.set('sl.chart', o); renderChart(true); } }), label));
  }
  if (!t || t.insufficient) { S.charts.main.setModel({ candles: [] }); renderChartNotes(t); return; }
  S.charts.main.setModel(chartModel(t, o), { keepView: keep });
  // legend
  const C = colors();
  const lg = clear($('chartLegend'));
  if (o.cdcEma) lg.append(legendItem(C.s2, 'Fast EMA12 (ของ AP)'), legendItem(C.s1, 'Slow EMA26 (ของ AP)'));
  if (o.ema50200) lg.append(legendItem(C.s3, 'EMA50'), legendItem(C.s5, 'EMA200'));
  if (o.htf && S.chartTF === '1D') lg.append(legendItem(C.s2, 'Weekly Fast', true), legendItem(C.s1, 'Weekly Slow', true));
  if (o.divs) lg.append(legendItem(C.good, 'Bullish Div (ประ = Hidden)'), legendItem(C.bad, 'Bearish Div (ประ = Hidden)'));
  if (o.elliott) lg.append(legendItem(C.ew, 'Elliott count หลัก'), legendItem(C.target, 'เป้า Fibonacci', true), legendItem(C.bad, 'Invalidation', true));
  if (S.compare) lg.append(legendItem(C.s4, `${S.compare.symbol} (ปรับฐานให้เริ่มที่ราคาเดียวกัน ณ แท่งแรกที่มองเห็น)`));
  if (o.cdcBars) lg.append(h('span', { class: 'lg' }, zoneChip('green'), zoneChip('yellow'), zoneChip('red'), zoneChip('blue')));
  renderChartNotes(t);
  S.charts.dirty = false;
}

function renderChartNotes(t) {
  const box = $('chartNotes');
  if (!box) return;
  clear(box);
  if (!t || t.insufficient) { box.append(h('p', { class: 'muted', text: t ? t.note : 'ไม่มีข้อมูล' })); return; }
  box.append(h('h3', { text: `อ่านกราฟ ${t.label}` }));
  const ul = h('ul', { class: 'readout' });
  if (t.cdc) ul.append(h('li', {}, h('strong', { text: 'CDC ActionZone: ' }), `${ZONES[t.cdc.zone].th} มา ${t.cdc.zoneBars} แท่ง — ${ZONES[t.cdc.zone].meaning}. ` + (t.cdc.lastSignal ? `สัญญาณล่าสุด: ${t.cdc.lastSignal.type === 'buy' ? 'BUY' : 'SELL'} เมื่อ ${fmtDate(t.cdc.lastSignal.t)} ที่ ${fmtPrice(t.cdc.lastSignal.price)} (${t.cdc.lastSignal.barsAgo} แท่งก่อน)` : 'ยังไม่มีสัญญาณ Buy/Sell ตามนิยาม')));
  ul.append(h('li', {}, h('strong', { text: 'RSI(14): ' }), `${fmtNum(t.rsi.value, 1)} — ${t.rsi.state.label}`));
  const recent = t.divergences.slice(-6).reverse();
  ul.append(h('li', {}, h('strong', { text: 'Divergence ล่าสุด: ' }), recent.length ? '' : 'ไม่พบ'));
  if (recent.length) ul.append(h('li', { class: 'nested' }, h('ul', {}, recent.map((d) => h('li', { text: `${d.th}: pivot ${fmtDate(t.candles[d.i1].t)} → ${fmtDate(t.candles[d.i2].t)} (ยืนยัน ${fmtDate(t.candles[Math.min(d.confirmedAt, t.n - 1)].t)}) · RSI ${d.rsi1.toFixed(1)} → ${d.rsi2.toFixed(1)} · ความแรง ${(d.strength * 100).toFixed(0)}%` })))));
  const ew = t.elliott.best;
  ul.append(h('li', {}, h('strong', { text: 'Elliott Wave: ' }), ew ? `${ew.current.th} — ${ew.current.action}. Invalidation ${fmtPrice(ew.invalidation)}` : t.elliott.note || '—'));
  box.append(ul);
}

async function loadCompare(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) { setStatus('error', 'สัญลักษณ์สำหรับซ้อนกราฟไม่ถูกต้อง'); return; }
  setStatus('loading', `กำลังดึง ${s} เพื่อซ้อนกราฟ …`);
  try {
    const d = await api('candles', { symbol: s, interval: '1d' });
    let c = toCandles(d.candles);
    if (S.settings.adjust) c = adjustCandles(c);
    // Daily candles are aligned to any timeframe by time (last close inside each bar).
    S.compare = { symbol: s, candles: c };
    setStatus('', '');
    renderChart(true);
  } catch (e) { setStatus('error', e.message); }
}

// ------------------------------------------------------------------ elliott
function renderElliott() {
  const p = $('tab-elliott');
  dropCharts('elliott');
  if (!S.analysis) return needData(p);
  clear(p);
  p.append(h('div', { class: 'card' }, h('p', { text: 'ระบบนับคลื่นอัตโนมัติจาก Swing (ZigZag ตาม ATR 3 ขนาด) ทดลองทุก count ที่จบที่ Swing ล่าสุด ตัดแบบที่ผิดกฎเหล็กทิ้ง แล้วจัดอันดับด้วย Fibonacci/Guideline — นี่คือ “ความสอดคล้องกับกฎ” ไม่ใช่ความน่าจะเป็นที่ถูก ใช้ระดับ Invalidation เป็นจุดตัดสินใจเสมอ' })));
  for (const tf of ['1M', '1W', '1D', '4H']) {
    const t = S.analysis.ta[tf];
    if (!t) continue;
    const card = h('div', { class: 'card' }, h('h3', { text: `${TF_LABEL[tf]} — Degree: ${t.degree || '—'} (${tf === '1M' ? 'ระยะยาว' : tf === '1W' ? 'ระยะกลาง' : 'ระยะสั้น'})` }));
    p.append(card);
    if (t.insufficient) { card.append(h('p', { class: 'muted', text: t.note })); continue; }
    const ew = t.elliott.best;
    if (!ew) { card.append(h('p', { class: 'muted', text: t.elliott.note })); continue; }
    card.append(
      h('div', { class: 'ew-head' },
        pill(ew.direction === 'up' ? 'รอบขาขึ้น (Impulse up)' : 'รอบขาลง (Impulse down)', ew.direction === 'up' ? 'good' : 'bad'),
        pill(`ตอนนี้: ${ew.current.th}`, 'neutral'),
        pill(`ความสอดคล้องกฎ/Fibo ${(ew.conformance * 100).toFixed(0)}%`, 'neutral'),
        pill(`น้ำหนักเทียบทางเลือก ${(ew.relative * 100).toFixed(0)}%`, 'neutral')),
      h('p', { class: 'action', text: `แนวทาง: ${ew.current.action}` }));
    const host = h('div', { class: 'chart-mini' });
    card.append(host);
    const ch = track('elliott', new CandleChart(host, { height: 300, ariaLabel: `Elliott Wave ${tf}` }));
    const first = ew.labels[0].i;
    ch.setModel(chartModel(t, { cdcBars: false, cdcEma: false, signals: false, divs: false, elliott: true, zigzag: true, volume: false, rsi: false, log: tf === '1M' }, { initialBars: Math.min(t.n, Math.max(60, t.n - first + 15)) }));
    const cols = h('div', { class: 'grid2' });
    cols.append(h('div', {}, h('h4', { text: 'จุดคลื่น' }), h('table', { class: 'data' }, h('tbody', {}, ew.labels.map((l) => h('tr', {}, h('td', { text: `คลื่น ${l.label}` }), h('td', { text: fmtDate(t.candles[l.i].t, tf === '4H') }), h('td', { text: fmtPrice(l.price) })))))));
    cols.append(h('div', {}, h('h4', { text: 'กฎเหล็ก (ต้องผ่านทุกข้อ)' }), h('ul', { class: 'checks' }, ew.rules.map((r) => h('li', { class: r.pass ? 'pass' : 'fail' }, h('span', { class: 'ck', text: r.pass ? '✓' : '✗' }), `${r.name} — ${r.detail}`))),
      h('h4', { text: 'เป้าหมาย & จุดยกเลิก' }), h('ul', {}, ew.targets.map((x) => h('li', { text: `${x.label}: ${fmtPrice(x.price)}` })), h('li', { class: 'inv', text: `Invalidation: ${fmtPrice(ew.invalidation)} — ${ew.invalidationNote}` }))));
    card.append(cols);
    card.append(h('h4', { text: 'Guideline / Fibonacci (คะแนน 0–100%)' }), h('div', { class: 'scroll-x' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['แนวทาง', 'ค่าจริง', 'ค่าในอุดมคติ', 'คะแนน'].map((x) => h('th', { text: x })))),
      h('tbody', {}, ew.guidelines.map((g) => h('tr', {}, h('td', { text: g.name }), h('td', { text: typeof g.value === 'number' ? fmtNum(g.value, 3) : (g.value || '—') }), h('td', { text: g.ideal }), h('td', {}, h('div', { class: 'minibar' }, h('span', { style: { width: `${Math.round(g.score * 100)}%` } })), `${Math.round(g.score * 100)}%`)))))));
    if (t.elliott.alternatives && t.elliott.alternatives.length) {
      card.append(h('h4', { text: 'Count ทางเลือก (Alternate)' }), h('ul', {}, t.elliott.alternatives.map((alt) => h('li', { text: `${alt.current.th} · ความสอดคล้อง ${(alt.conformance * 100).toFixed(0)}% · น้ำหนัก ${(alt.relative * 100).toFixed(0)}% · Invalidation ${fmtPrice(alt.invalidation)}` }))));
    }
  }
}

// ------------------------------------------------------------------ news
function renderNews() {
  const p = $('tab-news');
  if (!S.analysis) return needData(p);
  clear(p);
  if (S.newsStatus === 'csv') { p.append(h('div', { class: 'card' }, h('p', { class: 'muted', text: 'ข้อมูลจากไฟล์ CSV ไม่มีข่าวประกอบ' }))); return; }
  if (S.newsStatus === 'loading') { p.append(h('div', { class: 'card' }, h('p', { class: 'muted', text: 'กำลังดึงข่าวล่าสุด…' }))); return; }
  if (S.newsStatus === 'error') { p.append(h('div', { class: 'card' }, h('p', { class: 'error-text', text: `ดึงข่าวไม่สำเร็จ: ${S.newsError}` }), h('button', { type: 'button', text: 'ลองใหม่', onclick: () => loadNews(S.reqId) }))); return; }
  if (!S.news) { p.append(h('div', { class: 'card' }, h('p', { class: 'muted', text: (S.newsRaw && S.newsRaw.note) || 'ไม่พบข่าวสำหรับสัญลักษณ์นี้' }))); return; }
  const n = S.news;
  const grid = h('div', { class: 'grid3' });
  for (const [k, hz] of Object.entries(n.horizons)) {
    grid.append(h('div', { class: 'card' }, h('h3', { text: NEWS_H[k].th }), h('div', { class: 'score-row' }, h('span', { class: 'score-num', text: isNum(hz.score) ? hz.score.toFixed(2) : '—' }), scoreBar(isNum(hz.score) ? hz.score * 100 : 0)),
      h('p', { class: 'sub', text: `${sentimentLabel(hz.score)} · ${hz.count} ข่าวที่เกี่ยวข้อง · น้ำหนักลดครึ่งทุก ${hz.halfLifeDays} วัน` })));
  }
  p.append(grid);
  if (n.factors.length) {
    p.append(h('div', { class: 'card' }, h('h3', { text: 'ปัจจัย (Factor) ที่ข่าวพูดถึง และระยะเวลาที่มีผล' }), h('div', { class: 'scroll-x' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['ปัจจัย', 'มีผลต่อ', 'จำนวนข่าว', 'Sentiment เฉลี่ย'].map((x) => h('th', { text: x })))),
      h('tbody', {}, n.factors.map((f) => h('tr', {}, h('td', { text: f.th }), h('td', { text: f.horizons.map((x) => NEWS_H[x].th.split(' ')[0]).join(', ') }), h('td', { text: String(f.n) }), h('td', {}, pill(`${f.avg >= 0 ? '+' : ''}${f.avg.toFixed(2)} ${sentimentLabel(f.avg)}`, f.avg > 0.1 ? 'good' : f.avg < -0.1 ? 'bad' : 'neutral')))))))));
  }
  const list = h('ul', { class: 'news' });
  for (const it of n.items.slice(0, 60)) {
    list.append(h('li', {},
      h('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer nofollow', text: it.title }),
      h('div', { class: 'news-meta' },
        h('span', { text: it.source || '' }), h('span', { text: timeAgo(it.publishedAt) }),
        pill(`${it.score >= 0 ? '+' : ''}${it.score.toFixed(2)}`, it.score > 0.1 ? 'good' : it.score < -0.1 ? 'bad' : 'neutral', 'คะแนน sentiment'),
        it.factors.map((f) => h('span', { class: 'tag', text: f })),
        it.hits.length ? h('span', { class: 'hits', text: `คำที่ใช้ให้คะแนน: ${it.hits.slice(0, 6).join(' ')}` }) : null)));
  }
  const feeds = (S.newsRaw.feeds || []).map((f) => `${f.feed}: ${f.ok ? `${f.count} ข่าว` : 'ไม่สำเร็จ'}`).join(' · ');
  p.append(h('div', { class: 'card' }, h('h3', { text: `ข่าวล่าสุด (อ้างอิงต้นฉบับ) — คำค้น “${S.newsRaw.query}”` }), h('p', { class: 'sub', text: feeds }), list,
    h('p', { class: 'note', text: 'Sentiment คำนวณด้วยพจนานุกรมคำทางการเงิน + การจัดการคำปฏิเสธ (โปร่งใส ตรวจสอบได้) แต่ไม่เข้าใจบริบทซับซ้อน — ควรเปิดอ่านต้นฉบับประกอบ' })));
}

// ------------------------------------------------------------------ psychology
function renderPsych() {
  const p = $('tab-psych');
  dropCharts('psych');
  if (!S.analysis) return needData(p);
  clear(p);
  const ps = S.analysis.psych;
  const parts = ps.parts || {};
  const partRows = [['RSI', parts.rsi], ['ระยะห่างจาก EMA50 (ATR)', parts.stretch], ['ตำแหน่งในกรอบ 52 สัปดาห์', parts.range], ['ความผันผวนต่ำ (กลับด้าน)', parts.volatility], ['วอลุ่มวันขึ้น vs วันลง', parts.volume]];
  p.append(h('div', { class: 'grid2' },
    h('div', { class: 'card' }, h('h3', { text: 'Fear & Greed ของสินทรัพย์นี้' }), h('div', { class: 'big-num', text: isNum(ps.fearGreed) ? Math.round(ps.fearGreed) : '—' }), h('p', { class: 'center', text: ps.label.th }), gauge(ps.fearGreed),
      h('table', { class: 'kv' }, h('tbody', {}, partRows.map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', {}, h('div', { class: 'minibar' }, h('span', { style: { width: `${isNum(v) ? Math.round(v) : 0}%` } })), isNum(v) ? Math.round(v) : '—')))))),
    h('div', { class: 'card' }, h('h3', { text: 'ช่วงอารมณ์ของตลาด (Market cycle)' }), h('p', { class: 'phase', text: ps.phase.th }), h('p', { text: ps.phase.desc }),
      ps.newsVsPrice ? h('div', { class: 'sub-card' }, h('h4', { text: `ข่าว vs ราคา: ${ps.newsVsPrice.th}` }), h('p', { text: ps.newsVsPrice.desc })) : h('p', { class: 'muted', text: 'ยังไม่มีข่าวสำหรับเทียบกับพฤติกรรมราคา' }))));
  const tr = ps.traps;
  p.append(h('div', { class: 'card' }, h('h3', { text: 'ความถี่ของ “กับดัก” ในอดีตของสินทรัพย์นี้ (ทำไมกราฟชอบหลอก)' }),
    h('div', { class: 'grid2' },
      h('div', {}, h('div', { class: 'big-num', text: fmtPct(tr.bullTrapRate, 0) }), h('p', { class: 'center', text: `Bull trap: ทะลุ High ${tr.params.look} แท่งแล้วปิดกลับใต้ภายใน ${tr.params.confirm} แท่ง (${tr.bullTraps}/${tr.breakouts} ครั้ง)` })),
      h('div', {}, h('div', { class: 'big-num', text: fmtPct(tr.bearTrapRate, 0) }), h('p', { class: 'center', text: `Bear trap: หลุด Low ${tr.params.look} แท่งแล้วปิดกลับเหนือภายใน ${tr.params.confirm} แท่ง (${tr.bearTraps}/${tr.breakdowns} ครั้ง)` }))),
    h('p', { class: 'note', text: tr.bullTrapRate > 0.4 ? 'สินทรัพย์นี้ Breakout หลอกบ่อย — ควรรอปิดยืนยัน 2–3 แท่ง หรือเข้าเมื่อย่อทดสอบแนวที่ทะลุ แทนการไล่ราคา' : 'Breakout ของสินทรัพย์นี้มักมีแรงต่อเนื่อง — การเข้าตาม Breakout มีความน่าเชื่อถือพอสมควร' }),
    tr.recent.length ? h('ul', {}, tr.recent.map((e) => h('li', { text: `${e.type === 'bullTrap' ? 'Bull trap' : 'Bear trap'} ${fmtDate(S.analysis.ta['1D'].candles[e.i].t)} ที่ระดับ ${fmtPrice(e.level)}` }))) : null));
  const cl = ps.climaxes;
  p.append(h('div', { class: 'card' }, h('h3', { text: 'Volume Climax ล่าสุด (120 แท่ง)' }), cl.length ? h('ul', {}, cl.map((c) => h('li', { text: `${fmtDate(S.analysis.ta['1D'].candles[c.i].t)} · Volume z=${c.z.toFixed(1)} · ${CLIMAX_TEXT[c.type]}` }))) : h('p', { class: 'muted', text: 'ไม่มีแท่งวอลุ่มผิดปกติในช่วงล่าสุด' })));
  const host = h('div', { class: 'chart-mini' });
  p.append(h('div', { class: 'card' }, h('h3', { text: 'Fear & Greed ย้อนหลัง (รายวัน)' }), host));
  const d = S.analysis.ta['1D'].candles;
  const from = Math.max(0, d.length - 500);
  const lc = track('psych', new LineChart(host, { height: 220, ariaLabel: 'Fear and Greed history' }));
  const C = colors();
  lc.setModel({ t: d.slice(from).map((b) => b.t), series: [{ values: ps.series.slice(from), color: C.s1, label: 'Fear & Greed' }], range: [0, 100], refLines: [{ v: 20, color: C.bad }, { v: 80, color: C.good }], yFormat: (v) => String(Math.round(v)) });
}

// ------------------------------------------------------------------ backtest
function btCandles(tf) {
  const d = daily();
  const tz = (S.meta && S.meta.tzOffsetSec) || 0;
  return tf === '1W' ? toWeekly(d, tz) : d;
}

function renderBacktest() {
  const p = $('tab-backtest');
  if (!S.analysis) return needData(p);
  if (S.tab !== 'backtest') return;
  dropCharts('backtest');
  clear(p);
  const saved = store.get('sl.bt', {});
  const f = {
    strategy: STRATEGIES[saved.strategy] ? saved.strategy : 'cdc', tf: saved.tf === '1W' ? '1W' : '1D',
    fee: isNum(saved.fee) ? saved.fee : 0.1, slip: isNum(saved.slip) ? saved.slip : 0.05, stop: isNum(saved.stop) ? saved.stop : 0, oos: [0.2, 0.3, 0.4].includes(saved.oos) ? saved.oos : 0.3,
  };
  const form = h('form', { class: 'card bt-form', onsubmit: (e) => { e.preventDefault(); runBt(); } },
    h('div', { class: 'form-grid' },
      h('label', {}, 'กลยุทธ์', h('select', { id: 'btS' }, Object.entries(STRATEGIES).map(([k, s]) => h('option', { value: k, selected: f.strategy === k }, s.name)))),
      h('label', {}, 'Timeframe', h('select', { id: 'btTF' }, [['1D', 'รายวัน'], ['1W', 'รายสัปดาห์']].map(([v, t]) => h('option', { value: v, selected: f.tf === v }, t)))),
      h('label', {}, 'ค่าคอมฯ ต่อครั้ง (%)', h('input', { id: 'btFee', type: 'number', min: '0', max: '2', step: '0.01', value: String(f.fee) })),
      h('label', {}, 'Slippage ต่อครั้ง (%)', h('input', { id: 'btSlip', type: 'number', min: '0', max: '2', step: '0.01', value: String(f.slip) })),
      h('label', {}, 'ATR Trailing stop (0 = ปิด)', h('input', { id: 'btStop', type: 'number', min: '0', max: '10', step: '0.5', value: String(f.stop) })),
      h('label', {}, 'สัดส่วน Out-of-sample', h('select', { id: 'btOos' }, [0.2, 0.3, 0.4].map((v) => h('option', { value: String(v), selected: f.oos === v }, `${v * 100}% ท้ายสุด`))))),
    h('p', { class: 'sub', id: 'btDesc', text: STRATEGIES[f.strategy].description }),
    h('button', { type: 'submit', class: 'primary', text: 'รัน Backtest + พิสูจน์ทางสถิติ' }));
  p.append(form);
  $('btS').addEventListener('change', () => { $('btDesc').textContent = STRATEGIES[$('btS').value].description; });
  const out = h('div', { id: 'btOut' });
  p.append(out);
  if (S.bt) renderBtResult(out, S.bt); else runBt();
}

function runBt() {
  const cfg = {
    strategy: $('btS').value, tf: $('btTF').value,
    fee: Math.max(0, Math.min(2, +$('btFee').value || 0)), slip: Math.max(0, Math.min(2, +$('btSlip').value || 0)),
    stop: Math.max(0, Math.min(10, +$('btStop').value || 0)), oos: +$('btOos').value || 0.3,
  };
  if (!STRATEGIES[cfg.strategy]) return;
  store.set('sl.bt', cfg);
  dropCharts('backtest');
  const out = clear($('btOut'));
  const my = S.reqId;
  out.append(h('div', { class: 'card' }, h('p', { class: 'muted', text: 'กำลังคำนวณ: Backtest, Walk-forward, Permutation 1,000 รอบ, Bootstrap, Edge study …' })));
  setTimeout(() => {
    if (my !== S.reqId || !$('btOut')) return; // symbol changed meanwhile
    try {
      const candles = btCandles(cfg.tf);
      if (candles.length < 120) throw new Error('ข้อมูลน้อยเกินไปสำหรับ Backtest ที่เชื่อถือได้ (ต้องการ ≥ 120 แท่ง)');
      const res = validateStrategy(candles, { strategy: cfg.strategy, feePct: cfg.fee, slipPct: cfg.slip, atrStopMult: cfg.stop, oosFrac: cfg.oos, tf: cfg.tf, tzOffsetSec: (S.meta && S.meta.tzOffsetSec) || 0 });
      const edge = edgeStudy(candles);
      S.bt = { res, edge, candles, cfg };
      renderBtResult(clear($('btOut')), S.bt);
    } catch (e) {
      clear($('btOut')).append(h('div', { class: 'card' }, h('p', { class: 'error-text', text: e.message })));
    }
  }, 30);
}

const GRADE = {
  strong: { tone: 'good', th: 'หลักฐานแข็งแรง', desc: 'ผ่านเกณฑ์ส่วนใหญ่รวมถึง Out-of-sample, Permutation test และ Deflated Sharpe — มี Edge ทางสถิติในอดีตที่ไม่น่าเกิดจากความบังเอิญ (แต่ยังไม่ใช่การรับประกันอนาคต)' },
  moderate: { tone: 'neutral', th: 'หลักฐานปานกลาง', desc: 'มีกำไรนอกตัวอย่าง แต่ยังไม่ผ่านการทดสอบความบังเอิญบางข้อ — ใช้ร่วมกับปัจจัยอื่นและลดขนาดเงิน' },
  weak: { tone: 'bad', th: 'หลักฐานอ่อน / ไม่ควรเชื่อ', desc: 'ผลลัพธ์อาจเกิดจากความบังเอิญหรือ Overfitting — ไม่ควรใช้กลยุทธ์นี้กับสินทรัพย์นี้โดยลำพัง' },
};

function renderBtResult(out, bt) {
  const { res, edge, candles } = bt;
  const C = colors();
  const g = GRADE[res.grade];
  out.append(h('div', { class: `banner ${g.tone}` }, h('strong', { text: `${g.th} — ผ่าน ${res.passed}/${res.checks.length} เกณฑ์. ` }), g.desc));
  out.append(h('div', { class: 'card' }, h('h3', { text: 'Evidence scorecard (เกณฑ์พิสูจน์)' }), h('ul', { class: 'checks' }, res.checks.map((c) => h('li', { class: c.pass ? 'pass' : 'fail' }, h('span', { class: 'ck', text: c.pass ? '✓' : '✗' }), h('div', {}, h('div', { text: `${c.name}: ${c.value}` }), h('div', { class: 'cw', text: c.why })))))));
  // metrics
  const M = [['ผลตอบแทนรวม', (m) => fmtPct(m.totalReturn)], ['CAGR ต่อปี', (m) => fmtPct(m.cagr)], ['Max Drawdown', (m) => fmtPct(-m.maxDrawdown)], ['Sharpe', (m) => fmtNum(m.sharpe)], ['Sortino', (m) => fmtNum(m.sortino)], ['Calmar', (m) => fmtNum(m.calmar)], ['จำนวนเทรด', (m) => String(m.trades)], ['Win rate', (m) => fmtPct(m.winRate)], ['Profit factor', (m) => fmtNum(m.profitFactor)], ['กำไรเฉลี่ย/เทรด', (m) => fmtPct(m.expectancy, 2)], ['ชนะเฉลี่ย / แพ้เฉลี่ย', (m) => `${fmtPct(m.avgWin)} / ${fmtPct(m.avgLoss)}`], ['ถือเฉลี่ย (แท่ง)', (m) => fmtNum(m.avgBars, 1)], ['% เวลาที่ถือ', (m) => fmtPct(m.exposure, 0)], ['แพ้ติดกันสูงสุด', (m) => String(m.maxConsecLoss)], ['PSR (Sharpe>0)', (m) => fmtPct(m.psr)]];
  const cols = [['ทั้งช่วง: กลยุทธ์', res.full.metrics], ['ทั้งช่วง: Buy & Hold', res.bh.metrics], ['In-sample', res.isRes.metrics], ['Out-of-sample', res.oosRes.metrics], ['OOS: Buy & Hold', res.oosBH.metrics]];
  out.append(h('div', { class: 'card' }, h('h3', { text: `ผลลัพธ์ — ${res.strategyName} · ${bt.cfg.tf} · ${fmtDate(candles[res.full.from].t)} ถึง ${fmtDate(candles[res.full.to].t)} (OOS เริ่ม ${fmtDate(candles[res.split].t)})` }),
    h('div', { class: 'scroll-x' }, h('table', { class: 'data num' }, h('thead', {}, h('tr', {}, h('th', { text: 'ตัวชี้วัด' }), cols.map(([k]) => h('th', { text: k })))),
      h('tbody', {}, M.map(([k, fn]) => h('tr', {}, h('th', { text: k }), cols.map(([, m]) => h('td', { text: fn(m) })))))))));
  // equity chart
  const from = res.full.from;
  const t = candles.slice(from, res.full.to + 1).map((b) => b.t);
  const wf = new Array(t.length).fill(NaN);
  if (res.wf) for (const pt of res.wf.curve) { const k = pt.i - from; if (k >= 0 && k < wf.length) wf[k] = pt.eq; }
  if (res.wf) { const k0 = res.wf.curve.length ? res.wf.curve[0].i - from - 1 : -1; if (k0 >= 0) wf[k0] = 1; }
  const eqHost = h('div', { class: 'chart-mini' });
  const ddHost = h('div', { class: 'chart-mini' });
  out.append(h('div', { class: 'card' }, h('h3', { text: 'Equity curve (เริ่มที่ 1.0, log scale)' }),
    h('div', { class: 'legend' }, legendItem(C.s1, res.strategyName), legendItem(C.muted, 'Buy & Hold'), res.wf ? legendItem(C.s2, 'Walk-forward (เลือกพารามิเตอร์จากอดีตเท่านั้น)') : null), eqHost,
    h('h3', { text: 'Drawdown' }), ddHost));
  const eq = track('backtest', new LineChart(eqHost, { height: 300, ariaLabel: 'Equity curve' }));
  eq.setModel({ t, log: true, series: [{ values: res.full.equity, color: C.s1, label: 'กลยุทธ์' }, { values: res.bh.equity, color: C.muted, label: 'Buy & Hold' }, ...(res.wf ? [{ values: wf, color: C.s2, label: 'Walk-forward' }] : [])], yFormat: (v) => fmtNum(v, 2), vlines: [{ k: res.split - from, text: 'เริ่ม Out-of-sample' }] });
  const dd = track('backtest', new LineChart(ddHost, { height: 180, ariaLabel: 'Drawdown' }));
  dd.setModel({ t, area: true, series: [{ values: res.full.drawdown, color: C.bad, label: 'กลยุทธ์' }, { values: res.bh.drawdown, color: C.muted, label: 'Buy & Hold' }], yFormat: (v) => fmtPct(v, 0) });
  // statistical proof
  const st = [];
  if (res.perm) st.push(['Random-entry permutation test', `p = ${res.perm.p.toFixed(3)} (${res.perm.iters} รอบ) · log-return จังหวะจริง ${res.perm.actual.toFixed(3)} vs สุ่ม: มัธยฐาน ${res.perm.randomMedian.toFixed(3)}, เปอร์เซ็นไทล์ 95 = ${res.perm.random95.toFixed(3)}`, res.perm.p < 0.05 ? 'จังหวะเข้า-ออกดีกว่าการสุ่มอย่างมีนัยสำคัญ' : 'ยังแยกไม่ออกจากการสุ่ม']);
  st.push(['Probabilistic Sharpe Ratio', fmtPct(res.full.metrics.psr), 'โอกาสที่ Sharpe จริง > 0 (คิด skew/kurtosis)']);
  st.push(['Deflated Sharpe Ratio', `${fmtPct(res.dsr.dsr)} (เกณฑ์ SR₀ ต่อแท่ง = ${fmtNum(res.dsr.sr0, 4)}, ลอง ${res.dsr.nTrials} ชุด)`, 'หักผลการลองหลายพารามิเตอร์ (Multiple testing)']);
  if (isNum(res.tTest.t)) st.push(['t-test กำไรเฉลี่ยต่อเทรด > 0', `t = ${fmtNum(res.tTest.t)} · p = ${fmtNum(res.tTest.p, 3)} · n = ${res.tTest.n}`, res.tTest.p < 0.05 ? 'มีนัยสำคัญ' : 'ไม่มีนัยสำคัญ']);
  if (res.boot) st.push(['Bootstrap กำไรเฉลี่ยต่อเทรด (95% CI)', `${fmtPct(res.boot.lo, 2)} ถึง ${fmtPct(res.boot.hi, 2)} · P(>0) = ${fmtPct(res.boot.pPositive)}`, 'ช่วงความเชื่อมั่นของ Edge ต่อเทรด']);
  if (res.mc) st.push(['Monte Carlo ลำดับเทรด', `Max DD มัธยฐาน ${fmtPct(res.mc.ddMedian)} · แย่สุดที่ 95% = ${fmtPct(res.mc.dd95)} · เงินปลายทางกรณีแย่ 5% = ${fmtNum(res.mc.finalP5, 2)}x`, 'ใช้กำหนดขนาดเงินที่ทนได้']);
  if (res.wf) st.push(['Walk-forward', `กำไร OOS รวม ${fmtPct(res.wf.oosReturn)} · ${res.wf.windows.length} หน้าต่าง (Train ${res.wf.trainYears} ปี → Test ${res.wf.testYears} ปี) · WFE ${fmtNum(res.wf.efficiency)}`, 'WFE ≥ 0.5 ถือว่าพารามิเตอร์ไม่ overfit มาก']);
  out.append(h('div', { class: 'card' }, h('h3', { text: 'การพิสูจน์ทางสถิติ' }), h('div', { class: 'scroll-x' }, h('table', { class: 'data' }, h('tbody', {}, st.map(([a, b, c]) => h('tr', {}, h('th', { text: a }), h('td', { text: b }), h('td', { class: 'muted', text: c }))))))));
  // heatmap
  const gd = res.grid.def;
  const cells = new Map(res.grid.cells.map((c) => [`${c.params[gd.x.key]}|${c.params[gd.y.key]}`, c]));
  const maxAbs = Math.max(0.01, ...res.grid.cells.filter((c) => c.valid).map((c) => Math.abs(c.totalReturn)));
  const heat = h('table', { class: 'heat' }, h('thead', {}, h('tr', {}, h('th', { text: `${gd.y.label} \\ ${gd.x.label}` }), gd.x.values.map((x) => h('th', { text: String(x) })))),
    h('tbody', {}, gd.y.values.map((y) => h('tr', {}, h('th', { text: String(y) }), gd.x.values.map((x) => {
      const c = cells.get(`${x}|${y}`);
      if (!c || !c.valid) return h('td', { class: 'na', text: '—' });
      const k = Math.min(1, Math.abs(c.totalReturn) / maxAbs);
      const cur = res.params[gd.x.key] === x && res.params[gd.y.key] === y;
      return h('td', { class: `${c.totalReturn >= 0 ? 'hp' : 'hn'}${cur ? ' cur' : ''}`, style: { '--k': k.toFixed(2) }, title: `Sharpe ${fmtNum(c.sharpe)} · MaxDD ${fmtPct(c.maxDD)} · ${c.trades} เทรด`, text: fmtPct(c.totalReturn, 0) });
    })))));
  out.append(h('div', { class: 'card' }, h('h3', { text: 'Parameter robustness (ผลตอบแทนรวมของแต่ละชุดพารามิเตอร์)' }), h('p', { class: 'sub', text: `กำไร ${fmtPct(res.grid.profitableShare, 0)} ของตาราง · ชนะ Buy & Hold ${fmtPct(res.grid.beatBHShare, 0)} · กรอบหนา = พารามิเตอร์ที่ใช้ · สีน้ำเงิน = กำไร, สีแดง = ขาดทุน` }), h('div', { class: 'scroll-x' }, heat)));
  if (res.wf) {
    out.append(h('div', { class: 'card' }, h('h3', { text: 'Walk-forward: พารามิเตอร์ที่ระบบจะเลือกในแต่ละช่วง (โดยไม่รู้อนาคต)' }), h('div', { class: 'scroll-x' }, h('table', { class: 'data num' },
      h('thead', {}, h('tr', {}, ['Train', 'Test ถึง', 'พารามิเตอร์ที่เลือก', 'Train Sharpe', 'Test return', 'Test trades'].map((x) => h('th', { text: x })))),
      h('tbody', {}, res.wf.windows.map((w) => h('tr', {}, h('td', { text: `${fmtDate(w.trainFrom)} → ${fmtDate(w.trainTo)}` }), h('td', { text: fmtDate(w.testTo) }), h('td', { text: Object.entries(w.params).map(([k, v]) => `${k}=${v}`).join(', ') }), h('td', { text: fmtNum(w.trainSharpe) }), h('td', { text: fmtPct(w.testReturn) }), h('td', { text: String(w.testTrades) }))))))));
  }
  // trades
  const trades = res.full.trades;
  out.append(h('div', { class: 'card' }, h('div', { class: 'row-between' }, h('h3', { text: `รายการเทรด (${trades.length})` }), h('button', { type: 'button', class: 'ghost', text: 'ดาวน์โหลด CSV', onclick: () => exportTrades(trades) })),
    h('div', { class: 'scroll-x tall' }, h('table', { class: 'data num' }, h('thead', {}, h('tr', {}, ['#', 'เข้า', 'ราคาเข้า', 'ออก', 'ราคาออก', 'ผลตอบแทน', 'แท่ง', 'เหตุผลออก'].map((x) => h('th', { text: x })))),
      h('tbody', {}, trades.slice().reverse().slice(0, 200).map((tr, k) => h('tr', {}, h('td', { text: String(trades.length - k) }), h('td', { text: fmtDate(tr.entryT) }), h('td', { text: fmtPrice(tr.entryPrice) }), h('td', { text: fmtDate(tr.exitT) }), h('td', { text: fmtPrice(tr.exitPrice) }), h('td', { class: tr.ret >= 0 ? 'pos' : 'neg', text: fmtPct(tr.ret, 2) }), h('td', { text: String(tr.bars) }), h('td', { text: tr.reason === 'stop' ? 'Stop' : tr.reason === 'open' ? 'ยังถืออยู่' : 'สัญญาณ' }))))))));
  // edge study
  const hzs = edge.horizons;
  out.append(h('div', { class: 'card' }, h('h3', { text: 'Edge study: เมื่อเงื่อนไขนี้เกิดในอดีต ราคาไปทางไหนต่อ? (ผลตอบแทนเฉลี่ยจากราคาเปิดแท่งถัดไป)' }),
    h('p', { class: 'sub', text: `ค่าฐาน (ทุกวัน): ${hzs.map((x) => `${x} แท่ง ${fmtPct(edge.baseline[x].mean, 2)}`).join(' · ')} — แถวที่ไฮไลต์คือเงื่อนไขที่ “เกิดอยู่ตอนนี้”` }),
    h('div', { class: 'scroll-x' }, h('table', { class: 'data num' },
      h('thead', {}, h('tr', {}, h('th', { text: 'เงื่อนไข' }), hzs.map((x) => h('th', { text: `${x} แท่ง: เฉลี่ย / ชนะ / Edge / p` })))),
      h('tbody', {}, edge.rows.map((r) => h('tr', { class: r.nowActive ? 'active' : '' }, h('th', { text: `${r.nowActive ? '● ' : ''}${r.th}` }), hzs.map((x) => {
        const c = r.h[x];
        if (!c || c.insufficient) return h('td', { class: 'muted', text: `n=${c ? c.n : 0} (น้อยเกินไป)` });
        return h('td', { class: c.p < 0.05 ? (c.edge > 0 ? 'pos' : 'neg') : '', text: `${fmtPct(c.mean, 2)} / ${fmtPct(c.win, 0)} / ${fmtPct(c.edge, 2, true)} / ${fmtNum(c.p, 2)} (n=${c.n})` });
      })))))),
    h('p', { class: 'note', text: 'p-value ใช้เฉพาะเหตุการณ์ที่ไม่ซ้อนทับกัน (ห่างกัน ≥ จำนวนแท่ง) เพื่อไม่ให้สถิติดูดีเกินจริง · สีเขียว/แดง = มีนัยสำคัญที่ 5%' })));
}

function exportTrades(trades) {
  const rows = [['entry_date', 'entry_price', 'exit_date', 'exit_price', 'return_pct', 'bars', 'exit_reason']];
  for (const t of trades) rows.push([fmtDate(t.entryT), t.entryPrice.toFixed(6), fmtDate(t.exitT), t.exitPrice.toFixed(6), (t.ret * 100).toFixed(4), t.bars, t.reason]);
  download(`${S.symbol || 'trades'}-trades.csv`, rows.map((r) => r.join(',')).join('\n'), 'text/csv');
}

// ------------------------------------------------------------------ scan
function renderScan() {
  const p = $('tab-scan');
  clear(p);
  const list = store.get('sl.watch', DEFAULT_WATCH).filter((x) => typeof x === 'string' && SYMBOL_RE.test(x));
  const input = h('textarea', { id: 'watchInput', rows: '2', spellcheck: 'false', 'aria-label': 'รายการสัญลักษณ์', value: list.join(', ') });
  const out = h('div', { id: 'scanOut' });
  p.append(h('div', { class: 'card' }, h('h3', { text: 'สแกนหลายสินทรัพย์ (Watchlist)' }), h('p', { class: 'sub', text: 'คั่นด้วยจุลภาคหรือเว้นวรรค สูงสุด 25 ตัว — ระบบดึงราคาแล้ววิเคราะห์ทุกกรอบเวลา (ไม่รวมข่าวเพื่อความเร็ว)' }), input,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', text: 'สแกน', onclick: () => runScan() }))), out);
}

async function runScan() {
  const syms = [...new Set($('watchInput').value.toUpperCase().split(/[\s,;]+/).filter((x) => SYMBOL_RE.test(x)))].slice(0, 25);
  store.set('sl.watch', syms);
  const out = clear($('scanOut'));
  const tbl = h('table', { class: 'data num' }, h('thead', {}, h('tr', {}, ['สัญลักษณ์', 'ราคา', 'สั้น (D)', 'กลาง (W)', 'ยาว (M)', 'CDC D/W', 'Divergence (D)', 'Elliott (D)'].map((x) => h('th', { text: x })))));
  const tb = h('tbody');
  tbl.append(tb);
  out.append(h('div', { class: 'card' }, h('div', { class: 'scroll-x' }, tbl)));
  for (const s of syms) {
    const row = h('tr', {}, h('td', { text: s }), h('td', { colspan: '7', class: 'muted', text: 'กำลังวิเคราะห์…' }));
    tb.append(row);
    try {
      const d = await api('candles', { symbol: s, interval: '1d' });
      let c = toCandles(d.candles);
      if (S.settings.adjust) c = adjustCandles(c);
      const a = analyzeAll({ daily: c, meta: d, settings: S.settings });
      const cell = (k) => { const z = a.horizons[k]; return z && !z.insufficient ? h('td', {}, pill(`${Math.round(z.score)} ${z.verdict.th}`, z.verdict.tone)) : h('td', { class: 'muted', text: '—' }); };
      const D = a.ta['1D']; const W = a.ta['1W'];
      const dv = D.recentDivergences && D.recentDivergences[0];
      clear(row).append(
        h('td', {}, h('button', { type: 'button', class: 'link', text: s, onclick: () => { $('symbol').value = s; switchTab('summary'); load(s); } })),
        h('td', { text: fmtPrice(c[c.length - 1].c) }), cell('short'), cell('medium'), cell('long'),
        h('td', {}, D.cdc ? zoneChip(D.cdc.zone) : '—', ' ', W && W.cdc ? zoneChip(W.cdc.zone) : '—'),
        h('td', { text: dv ? dv.short : '—' }),
        h('td', { text: D.elliott.best ? D.elliott.best.current.th.replace('กำลังอยู่ใน', '') : '—' }));
    } catch (e) {
      clear(row).append(h('td', { text: s }), h('td', { colspan: '7', class: 'error-text', text: e.message }));
    }
  }
}

// ------------------------------------------------------------------ principles
function renderPrinciples() {
  const p = clear($('tab-principles'));
  for (const sec of PRINCIPLES) {
    const card = h('section', { class: 'card principle', id: `pr-${sec.id}` }, h('h3', { text: sec.title }));
    if (sec.formula) card.append(h('pre', { class: 'formula', text: sec.formula }));
    for (const para of sec.body || []) card.append(h('p', { text: para }));
    if (sec.bullets) card.append(h('ul', {}, sec.bullets.map((b) => h('li', { text: b }))));
    p.append(card);
  }
}

// ------------------------------------------------------------------ boot
function initTheme() {
  const saved = store.get('sl.theme', null);
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('sl.theme', next);
    renderAll({ keepChart: true });
  });
}

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((b, k) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(k + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); switchTab(next.dataset.tab);
    });
  });
}

function init() {
  initTheme();
  initTabs();
  renderQuick();
  renderPrinciples();
  renderScan();
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); load($('symbol').value); });
  $('csvBtn').addEventListener('click', () => $('csvFile').click());
  $('csvFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setStatus('error', 'ไฟล์ใหญ่เกิน 20 MB'); return; }
    try { loadFromCsv(file.name, parseCsv(await file.text())); } catch (err) { setStatus('error', `อ่านไฟล์ไม่สำเร็จ: ${err.message}`); }
  });
  for (const id of ['tab-summary', 'tab-chart', 'tab-elliott', 'tab-news', 'tab-psych', 'tab-backtest']) needData($(id));
  switchTab('summary');
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderAll({ keepChart: true }));
  let initial = '';
  try { initial = decodeURIComponent(location.hash.slice(1)); } catch { initial = ''; }
  if (SYMBOL_RE.test(initial)) { $('symbol').value = initial; load(initial); }
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
