// News sentiment + factor classification with time-horizon mapping.
// Method: finance-specific lexicon (in the spirit of Loughran & McDonald, 2011 —
// general-purpose sentiment lists misclassify finance words like "liability" or "tax"),
// negation handling, recency weighting with a different half-life per horizon.
// This is a transparent heuristic, not a language model: every article shows the
// words that drove its score so the user can verify it.

const POS_EN = ['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'rise', 'rises', 'climb', 'climbs',
  'upgrade', 'upgraded', 'upgrades', 'outperform', 'overweight', 'buy-rated', 'record', 'growth', 'profit', 'profits', 'profitable', 'strong', 'stronger', 'bullish',
  'raise', 'raised', 'raises', 'boost', 'boosts', 'buyback', 'repurchase', 'approval', 'approve', 'approved', 'approves', 'win', 'wins', 'won', 'partnership', 'expands', 'expansion',
  'exceed', 'exceeds', 'exceeded', 'tops', 'topped', 'rebound', 'rebounds', 'recovery', 'breakthrough', 'optimistic', 'upbeat', 'robust', 'accelerate', 'accelerates', 'higher', 'all-time'];
const NEG_EN = ['miss', 'misses', 'missed', 'plunge', 'plunges', 'plummet', 'plummets', 'slump', 'slumps', 'tumble', 'tumbles', 'sink', 'sinks', 'fall', 'falls', 'fell', 'drop', 'drops',
  'slide', 'slides', 'downgrade', 'downgraded', 'downgrades', 'underperform', 'underweight', 'loss', 'losses', 'weak', 'weaker', 'bearish', 'cut', 'cuts', 'lawsuit', 'sued', 'sues',
  'probe', 'investigation', 'fraud', 'recall', 'layoffs', 'layoff', 'bankruptcy', 'default', 'decline', 'declines', 'warning', 'warns', 'warned', 'delay', 'delays', 'fine', 'fined',
  'ban', 'banned', 'tariff', 'tariffs', 'sanction', 'sanctions', 'halt', 'halted', 'selloff', 'sell-off', 'crash', 'crashes', 'concern', 'concerns', 'fears', 'fear', 'lower', 'slowdown',
  'recession', 'disappoint', 'disappoints', 'disappointing', 'volatile', 'antitrust', 'shortfall', 'resigns', 'resignation', 'dilution', 'downturn'];
const NEGATORS = new Set(['not', 'no', 'never', "isn't", "wasn't", "doesn't", "didn't", 'without', 'fails', 'failed', 'despite']);
const POS_TH = ['พุ่ง', 'ทะยาน', 'กำไรเพิ่ม', 'กำไรโต', 'เติบโต', 'ปรับเพิ่ม', 'แนะนำซื้อ', 'ฟื้นตัว', 'สูงสุดเป็นประวัติการณ์', 'นิวไฮ', 'บวก', 'ซื้อหุ้นคืน', 'ปันผลเพิ่ม', 'ดีกว่าคาด', 'แข็งแกร่ง', 'อนุมัติ', 'ขยายกิจการ', 'คว้า', 'เป้าหมายสูงขึ้น'];
const NEG_TH = ['ร่วง', 'ดิ่ง', 'ทรุด', 'ขาดทุน', 'กำไรลด', 'ลดลง', 'ปรับลด', 'แนะนำขาย', 'ติดลบ', 'ฟ้อง', 'สอบสวน', 'ทุจริต', 'ล้มละลาย', 'ผิดนัดชำระ', 'กังวล', 'แย่กว่าคาด', 'ปลดพนักงาน', 'ชะลอตัว', 'ถดถอย', 'ขายทิ้ง', 'เทขาย', 'ภาษีนำเข้า', 'คว่ำบาตร', 'ปรับฐาน'];

/** Factor taxonomy → which horizon it mostly affects. */
export const FACTORS = {
  earnings: { th: 'ผลประกอบการ/งบการเงิน', horizons: ['short', 'medium'], words: ['earnings', 'eps', 'revenue', 'quarter', 'quarterly', 'q1', 'q2', 'q3', 'q4', 'results', 'profit', 'sales', 'margin', 'งบ', 'กำไรสุทธิ', 'รายได้', 'ไตรมาส', 'ผลประกอบการ'] },
  guidance: { th: 'ประมาณการ/แนวโน้มธุรกิจ', horizons: ['medium'], words: ['guidance', 'outlook', 'forecast', 'expects', 'projection', 'target', 'ประมาณการ', 'คาดการณ์', 'เป้าหมาย'] },
  analyst: { th: 'นักวิเคราะห์/ราคาเป้าหมาย', horizons: ['short'], words: ['analyst', 'upgrade', 'downgrade', 'price target', 'rating', 'overweight', 'underweight', 'outperform', 'underperform', 'นักวิเคราะห์', 'ราคาเป้าหมาย', 'แนะนำซื้อ', 'แนะนำขาย'] },
  macro: { th: 'เศรษฐกิจมหภาค/ดอกเบี้ย', horizons: ['medium', 'long'], words: ['fed', 'interest rate', 'rates', 'inflation', 'cpi', 'gdp', 'recession', 'jobs', 'payrolls', 'yield', 'yields', 'central bank', 'ดอกเบี้ย', 'เงินเฟ้อ', 'กนง', 'เศรษฐกิจ', 'จีดีพี', 'ธนาคารกลาง'] },
  regulation: { th: 'กฎหมาย/หน่วยงานกำกับ', horizons: ['short', 'long'], words: ['sec', 'antitrust', 'lawsuit', 'regulator', 'regulatory', 'ban', 'fine', 'probe', 'investigation', 'court', 'ก.ล.ต', 'ฟ้อง', 'กฎหมาย', 'สอบสวน', 'ศาล'] },
  corporate: { th: 'Corporate Action/M&A', horizons: ['short', 'medium'], words: ['acquire', 'acquisition', 'merger', 'buyback', 'repurchase', 'dividend', 'split', 'ipo', 'spin-off', 'stake', 'ควบรวม', 'เข้าซื้อ', 'ซื้อหุ้นคืน', 'ปันผล', 'แตกพาร์', 'เพิ่มทุน'] },
  product: { th: 'สินค้า/นวัตกรรม/เทคโนโลยี', horizons: ['medium', 'long'], words: ['launch', 'product', 'ai', 'chip', 'chips', 'patent', 'fda', 'approval', 'model', 'platform', 'device', 'เปิดตัว', 'ผลิตภัณฑ์', 'นวัตกรรม', 'เทคโนโลยี'] },
  geopolitics: { th: 'ภูมิรัฐศาสตร์/การค้า', horizons: ['medium', 'long'], words: ['tariff', 'tariffs', 'war', 'sanction', 'sanctions', 'china', 'trade war', 'export', 'geopolitical', 'ภาษีนำเข้า', 'สงคราม', 'คว่ำบาตร', 'การค้า'] },
  management: { th: 'ผู้บริหาร/Insider', horizons: ['medium'], words: ['ceo', 'cfo', 'resign', 'resigns', 'appoint', 'appoints', 'insider', 'executive', 'board', 'ผู้บริหาร', 'ลาออก', 'แต่งตั้ง'] },
  flows: { th: 'Fund flow/ความเคลื่อนไหวราคา', horizons: ['short'], words: ['shares', 'stock', 'stocks', 'rally', 'selloff', 'sell-off', 'volatility', 'short seller', 'etf', 'fund', 'หุ้น', 'ต่างชาติ', 'กองทุน', 'แรงขาย', 'แรงซื้อ'] },
};

export const HORIZONS = {
  short: { th: 'ระยะสั้น (วัน–สัปดาห์)', halfLifeDays: 3, tf: '1D' },
  medium: { th: 'ระยะกลาง (สัปดาห์–เดือน)', halfLifeDays: 14, tf: '1W' },
  long: { th: 'ระยะยาว (เดือน–ปี)', halfLifeDays: 60, tf: '1M' },
};

// Phrases whose market meaning differs from their individual words (e.g. "raises rates" is
// negative for equities although "raises" alone is positive). Matched first, then removed
// from the text so their words are not counted twice.
const TARGETS = '(?:price\\s+target|target\\s+price|guidance|outlook|forecasts?|dividends?|estimates?)';
const PHRASES = [
  { re: new RegExp('\\b(?:raises?|raised|raising|hikes?|hiked|hiking|lifts?|lifted)\\s+(?:its\\s+|key\\s+|benchmark\\s+)?(?:interest\\s+)?rates?\\b', 'g'), pol: -1, tag: 'rate hike' },
  { re: /\brates?\s+hikes?\b/g, pol: -1, tag: 'rate hike' },
  { re: new RegExp('\\b(?:cuts?|cutting|lowers?|lowered|lowering|slashes|slashed)\\s+(?:its\\s+|key\\s+|benchmark\\s+)?(?:interest\\s+)?rates?\\b', 'g'), pol: 1, tag: 'rate cut' },
  { re: /\brates?\s+cuts?\b/g, pol: 1, tag: 'rate cut' },
  { re: new RegExp(`\\b(?:cuts?|lowers?|lowered|lowering|slashes|slashed|reduces?|reduced)\\s+(?:its\\s+|the\\s+|full-year\\s+|annual\\s+)?${TARGETS}`, 'g'), pol: -1, tag: 'cut target/guidance' },
  { re: new RegExp(`\\b${TARGETS}\\s+(?:cut|lowered|slashed|reduced)\\b`, 'g'), pol: -1, tag: 'cut target/guidance' },
  { re: new RegExp(`\\b(?:raises?|raised|raising|boosts?|boosted|lifts?|lifted|ups)\\s+(?:its\\s+|the\\s+|full-year\\s+|annual\\s+)?${TARGETS}`, 'g'), pol: 1, tag: 'raised target/guidance' },
  { re: new RegExp(`\\b${TARGETS}\\s+(?:raised|boosted|lifted)\\b`, 'g'), pol: 1, tag: 'raised target/guidance' },
  { re: /\bbetter[-\s]than[-\s]expected\b/g, pol: 1, tag: 'better than expected' },
  { re: /\bworse[-\s]than[-\s]expected\b/g, pol: -1, tag: 'worse than expected' },
];
const PHRASES_TH = [['ขึ้นดอกเบี้ย', -1], ['ลดดอกเบี้ย', 1], ['ปรับลดเป้า', -1], ['ปรับเพิ่มเป้า', 1]];

function tokenize(text) {
  return text.toLowerCase().replace(/[“”"'’(),:;!?|[\]{}]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Score one headline/summary in [-1, 1] with the words that drove it. */
export function scoreText(text) {
  let t = String(text || '').slice(0, 5000).toLowerCase();
  let pos = 0; let neg = 0;
  const hits = [];
  for (const ph of PHRASES) {
    t = t.replace(ph.re, () => { if (ph.pol > 0) pos++; else neg++; hits.push(`${ph.pol > 0 ? '+' : '−'}[${ph.tag}]`); return ' '; });
  }
  for (const [w, pol] of PHRASES_TH) {
    while (t.includes(w)) { if (pol > 0) pos++; else neg++; hits.push(`${pol > 0 ? '+' : '−'}${w}`); t = t.replace(w, ' '); }
  }
  const tokens = tokenize(t);
  const posSet = new Set(POS_EN);
  const negSet = new Set(NEG_EN);
  for (let k = 0; k < tokens.length; k++) {
    const w = tokens[k];
    let pol = posSet.has(w) ? 1 : negSet.has(w) ? -1 : 0;
    if (!pol) continue;
    for (let j = Math.max(0, k - 3); j < k; j++) if (NEGATORS.has(tokens[j])) { pol = -pol; break; }
    if (pol > 0) pos++; else neg++;
    hits.push((pol > 0 ? '+' : '−') + w);
  }
  for (const w of POS_TH) if (t.includes(w)) { pos++; hits.push(`+${w}`); }
  for (const w of NEG_TH) if (t.includes(w)) { neg++; hits.push(`−${w}`); }
  const total = pos + neg;
  const score = total ? (pos - neg) / (total + 1) : 0; // +1 smoothing pulls weak evidence towards 0
  return { score, pos, neg, hits };
}

export function classifyFactors(text) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  const out = [];
  for (const [key, f] of Object.entries(FACTORS)) {
    if (f.words.some((w) => (/^[a-z0-9 .-]+$/.test(w) ? new RegExp(`[^a-z0-9]${w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}[^a-z0-9]`).test(lower) : lower.includes(w)))) out.push(key);
  }
  return out;
}

/**
 * Aggregate news into horizon scores.
 * @param items [{title, summary, publishedAt (ms), link, source}]
 */
export function analyzeNews(items, nowMs = Date.now()) {
  const scored = items.map((it) => {
    const text = `${it.title || ''}. ${it.summary || ''}`;
    const s = scoreText(text);
    const factors = classifyFactors(text);
    const ageDays = Number.isFinite(it.publishedAt) ? Math.max(0, (nowMs - it.publishedAt) / 86400000) : 30;
    return { ...it, ...s, factors, ageDays };
  });
  const horizons = {};
  for (const [hk, hz] of Object.entries(HORIZONS)) {
    let wsum = 0; let ssum = 0; let count = 0;
    for (const a of scored) {
      const relevant = hk === 'short' || a.factors.some((f) => FACTORS[f].horizons.includes(hk));
      if (!relevant) continue;
      const w = Math.pow(0.5, a.ageDays / hz.halfLifeDays);
      wsum += w; ssum += w * a.score; count++;
    }
    horizons[hk] = { ...hz, score: wsum > 0 ? ssum / wsum : NaN, count, weight: wsum };
  }
  const factorAgg = {};
  for (const a of scored) for (const f of a.factors) {
    factorAgg[f] = factorAgg[f] || { key: f, th: FACTORS[f].th, horizons: FACTORS[f].horizons, n: 0, sum: 0 };
    factorAgg[f].n++; factorAgg[f].sum += a.score;
  }
  const factors = Object.values(factorAgg).map((f) => ({ ...f, avg: f.sum / f.n })).sort((a, b) => b.n - a.n);
  const overall = horizons.short.score;
  return { items: scored.sort((a, b) => a.ageDays - b.ageDays), horizons, factors, overall };
}

export function sentimentLabel(s) {
  if (!Number.isFinite(s)) return 'ไม่มีข้อมูล';
  if (s > 0.35) return 'บวกมาก';
  if (s > 0.1) return 'บวก';
  if (s >= -0.1) return 'กลาง';
  if (s >= -0.35) return 'ลบ';
  return 'ลบมาก';
}
