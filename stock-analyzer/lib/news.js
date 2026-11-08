// News aggregation from public RSS feeds (Google News search + Yahoo Finance headlines).
// The RSS parser is deliberately minimal and defensive:
//   * linear-time regexes with fixed terminators (no catastrophic backtracking),
//   * all markup stripped, entities decoded, lengths capped,
//   * links accepted only if they parse as http(s) URLs.
// The browser renders every field with textContent, never as HTML.

import { fetchLimited, UpstreamError } from './util.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
export const QUERY_RE = /^[\p{L}\p{M}\p{N} .&'\-^=]{1,80}$/u;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, g) ? ENTITIES[g] : m;
  });
}

function stripTags(s) {
  return s.replace(/<[^>]{0,2000}>/g, ' ');
}

function clean(raw, max) {
  if (!raw) return '';
  let s = raw.length > 20000 ? raw.slice(0, 20000) : raw;
  s = s.split('<![CDATA[').join('').split(']]>').join('');
  s = decodeEntities(stripTags(s));
  s = stripTags(s); // entity-decoded markup (e.g. &lt;a&gt;) is stripped too
  s = s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Content of the first <name ...>...</name> in `block` (indexOf-based: linear time). */
function tag(block, name) {
  const lower = block.toLowerCase();
  let from = 0;
  for (;;) {
    const open = lower.indexOf(`<${name}`, from);
    if (open < 0) return '';
    const after = lower.charCodeAt(open + name.length + 1);
    // must be followed by '>', whitespace or '/', not e.g. <titles>
    if (after === 62 || after === 32 || after === 9 || after === 10 || after === 13 || after === 47) {
      const gt = lower.indexOf('>', open);
      if (gt < 0 || gt - open > 600) return '';
      if (lower.charCodeAt(gt - 1) === 47) return ''; // self-closing <tag/>
      const close = lower.indexOf(`</${name}>`, gt);
      return close < 0 ? '' : block.slice(gt + 1, close);
    }
    from = open + 1;
  }
}

export function safeLink(raw) {
  const s = clean(raw, 2000);
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Parse RSS 2.0 <item>s. */
export function parseRss(xml, feedName) {
  const items = [];
  const lower = xml.toLowerCase();
  let pos = 0;
  while (items.length < 60) {
    const open = lower.indexOf('<item', pos);
    if (open < 0) break;
    const gt = lower.indexOf('>', open);
    const close = gt < 0 ? -1 : lower.indexOf('</item>', gt);
    if (close < 0) break;
    pos = close + 7;
    if (close - gt > 20000) continue; // absurdly large item: skip
    const block = xml.slice(gt + 1, close);
    const title = clean(tag(block, 'title'), 300);
    const link = safeLink(tag(block, 'link'));
    if (!title || !link) continue;
    const srcTag = tag(block, 'source');
    let source = clean(srcTag, 80);
    let t = title;
    // Google News appends " - Publisher" to titles.
    if (source && t.endsWith(` - ${source}`)) t = t.slice(0, -(source.length + 3));
    if (!source) source = feedName;
    const pub = Date.parse(clean(tag(block, 'pubDate'), 80));
    items.push({ title: t, link, source, publishedAt: Number.isFinite(pub) ? pub : null, summary: clean(tag(block, 'description'), 400), feed: feedName });
  }
  return items;
}

function normTitle(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 120);
}

export async function fetchNews(fetchImpl, { symbol, query, thai }) {
  const q = query && QUERY_RE.test(query) ? query : symbol;
  const feeds = [];
  const gq = new URLSearchParams({ q: `${q} stock`, hl: 'en-US', gl: 'US', ceid: 'US:en' });
  feeds.push({ name: 'Google News', url: `https://news.google.com/rss/search?${gq.toString()}` });
  if (thai) {
    const tq = new URLSearchParams({ q: `${q} หุ้น`, hl: 'th', gl: 'TH', ceid: 'TH:th' });
    feeds.push({ name: 'Google News (TH)', url: `https://news.google.com/rss/search?${tq.toString()}` });
  }
  const yq = new URLSearchParams({ s: symbol, region: 'US', lang: 'en-US' });
  feeds.push({ name: 'Yahoo Finance', url: `https://feeds.finance.yahoo.com/rss/2.0/headline?${yq.toString()}` });

  const results = await Promise.allSettled(feeds.map(async (f) => parseRss(await fetchLimited(fetchImpl, f.url, { maxBytes: 3 * 1024 * 1024, headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' } }), f.name)));
  const seen = new Set();
  const items = [];
  const status = [];
  results.forEach((r, k) => {
    status.push({ feed: feeds[k].name, ok: r.status === 'fulfilled', count: r.status === 'fulfilled' ? r.value.length : 0 });
    if (r.status !== 'fulfilled') return;
    for (const it of r.value) {
      const key = normTitle(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  });
  if (!status.some((s) => s.ok)) throw new UpstreamError('ดึงข่าวไม่สำเร็จจากทุกแหล่ง', 502);
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return { items: items.slice(0, 80), feeds: status, query: q, fetchedAt: Date.now() };
}
