// CSV import for offline / any-source data (e.g. exported from a broker or TradingView).
// Accepts headers like Date/Time, Open, High, Low, Close, Volume (any order, case-insensitive).

const MAX_ROWS = 50000;

function parseDate(s) {
  const v = s.trim().replace(/^"|"$/g, '');
  if (/^\d{9,13}$/.test(v)) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function splitLine(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === sep && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  const v = Number(String(s ?? '').trim().replace(/,/g, ''));
  return Number.isFinite(v) ? v : NaN;
};

export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 3) throw new Error('ไฟล์ CSV ต้องมีหัวตารางและข้อมูลอย่างน้อย 2 แถว');
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const head = splitLine(lines[0], sep).map((x) => x.trim().toLowerCase());
  const find = (...names) => head.findIndex((x) => names.includes(x));
  const iT = find('date', 'time', 'datetime', 'timestamp', 'วันที่');
  const iO = find('open', 'เปิด');
  const iH = find('high', 'สูงสุด');
  const iL = find('low', 'ต่ำสุด');
  const iC = find('close', 'ปิด', 'price', 'last');
  const iA = find('adj close', 'adj_close', 'adjclose');
  const iV = find('volume', 'vol', 'ปริมาณ');
  if (iT < 0 || iC < 0) throw new Error('ไม่พบคอลัมน์ Date และ Close ในหัวตาราง');
  const rows = [];
  for (let k = 1; k < lines.length && rows.length < MAX_ROWS; k++) {
    const f = splitLine(lines[k], sep);
    const t = parseDate(f[iT] || '');
    const c = num(f[iC]);
    if (!Number.isFinite(t) || !(c > 0)) continue;
    const o = iO >= 0 ? num(f[iO]) : c;
    const h = iH >= 0 ? num(f[iH]) : Math.max(o, c);
    const l = iL >= 0 ? num(f[iL]) : Math.min(o, c);
    if (![o, h, l].every((x) => x > 0)) continue;
    const a = iA >= 0 ? num(f[iA]) : NaN;
    rows.push({ t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: iV >= 0 && num(f[iV]) >= 0 ? num(f[iV]) : 0, adj: a > 0 ? a : undefined });
  }
  rows.sort((x, y) => x.t - y.t);
  const out = rows.filter((r, k) => k === 0 || r.t !== rows[k - 1].t);
  if (out.length < 30) throw new Error(`ข้อมูลที่อ่านได้มีเพียง ${out.length} แถว (ต้องการอย่างน้อย 30)`);
  return out;
}
