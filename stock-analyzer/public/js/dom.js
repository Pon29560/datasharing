// Safe DOM builder: text is ALWAYS inserted as text nodes (never parsed as HTML),
// attribute names come only from code, and links are restricted to http(s)/#/blob.

const SAFE_HREF = /^(https?:\/\/|#|blob:)/i;

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') { // CSSOM (allowed by CSP style-src 'self'; no inline style attribute is parsed)
        for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv; }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'href') { if (SAFE_HREF.test(String(v))) el.setAttribute('href', String(v)); } // security-check: allow (scheme validated by SAFE_HREF)
      else if (/^on/i.test(k) || /^(src|srcdoc|style|formaction|action|xlink:href)$/i.test(k)) continue; // never written as raw strings — security-check: allow (this is the deny-list itself)
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function fmtPrice(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPct(v, digits = 1, sign = false) {
  if (!isNum(v)) return '—';
  const s = (v * 100).toFixed(digits);
  return `${sign && v > 0 ? '+' : ''}${s}%`;
}

export function fmtNum(v, digits = 2) {
  if (v === Infinity) return '∞';
  if (!isNum(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBig(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function fmtDate(t, intraday = false, tzOffsetSec = 0) {
  if (!isNum(t)) return '—';
  const d = new Date(t + tzOffsetSec * 1000);
  const s = d.toISOString();
  return intraday ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s.slice(0, 10);
}

export function timeAgo(ms, now = Date.now()) {
  if (!isNum(ms)) return '';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `${hrs} ชม.ที่แล้ว`;
  return `${Math.round(hrs / 24)} วันที่แล้ว`;
}

/** Score bar from -100..100 with a centre line. */
export function scoreBar(score) {
  const pct = Math.max(0, Math.min(100, (score + 100) / 2));
  const tone = score >= 15 ? 'good' : score <= -15 ? 'bad' : 'neutral';
  return h('div', { class: 'scorebar', role: 'meter', 'aria-valuemin': '-100', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(score)), 'aria-label': `คะแนน ${Math.round(score)}` },
    h('div', { class: 'scorebar-mid' }),
    h('div', { class: `scorebar-dot ${tone}`, style: { left: `${pct}%` } }));
}

/** 0..100 gauge (fear & greed etc.). */
export function gauge(value, labels = ['กลัวสุดขีด', 'กลัว', 'กลาง', 'โลภ', 'โลภสุดขีด']) {
  const pct = isNum(value) ? Math.max(0, Math.min(100, value)) : 50;
  return h('div', { class: 'gauge', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': isNum(value) ? String(Math.round(value)) : '' },
    h('div', { class: 'gauge-track' }, h('div', { class: 'gauge-needle', style: { left: `${pct}%` } })),
    h('div', { class: 'gauge-labels' }, labels.map((l) => h('span', { text: l }))));
}

export function pill(text, tone = 'neutral', title) {
  return h('span', { class: `pill ${tone}`, title }, text);
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
