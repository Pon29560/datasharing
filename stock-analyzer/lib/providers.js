// Market data provider: Yahoo Finance chart API (v8) + built-in DEMO data.
// Input is validated BEFORE it reaches here; URLs are built from constant hosts only.

import { fetchLimited, UpstreamError } from './util.js';
import { demoCandles } from '../public/core/demo.js';

export const SYMBOL_RE = /^[A-Za-z0-9^=.\-]{1,24}$/;
export const INTERVALS = new Set(['1d', '1h']);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAX_BARS = 20000;

export function isValidSymbol(s) {
  return typeof s === 'string' && SYMBOL_RE.test(s) && !s.includes('..');
}

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Parse Yahoo v8 chart JSON into compact candles; defensive against nulls and junk. */
export function parseYahooChart(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw new UpstreamError('รูปแบบข้อมูลจากแหล่งข้อมูลไม่ถูกต้อง', 502); }
  const chart = json && json.chart;
  if (chart && chart.error) throw new UpstreamError('ไม่พบสัญลักษณ์นี้ หรือแหล่งข้อมูลไม่มีข้อมูล', 404);
  const r = chart && Array.isArray(chart.result) ? chart.result[0] : null;
  if (!r || !Array.isArray(r.timestamp)) throw new UpstreamError('ไม่มีข้อมูลราคาสำหรับสัญลักษณ์นี้', 404);
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const adj = (r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || [];
  const out = [];
  for (let k = 0; k < r.timestamp.length && out.length < MAX_BARS; k++) {
    const t = r.timestamp[k];
    const o = q.open?.[k]; const h = q.high?.[k]; const l = q.low?.[k]; const c = q.close?.[k];
    if (!fin(t) || !fin(o) || !fin(h) || !fin(l) || !fin(c) || c <= 0 || o <= 0) continue;
    const hi = Math.max(h, o, c); const lo = Math.min(l, o, c);
    const v = fin(q.volume?.[k]) && q.volume[k] >= 0 ? q.volume[k] : 0;
    const a = fin(adj[k]) && adj[k] > 0 ? adj[k] : null;
    out.push([t * 1000, o, hi, lo, c, v, a]);
  }
  if (out.length < 2) throw new UpstreamError('ข้อมูลราคาน้อยเกินไป', 404);
  const m = r.meta || {};
  const str = (s, n = 120) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n) : null);
  return {
    symbol: str(m.symbol, 24),
    name: str(m.longName) || str(m.shortName),
    currency: str(m.currency, 8),
    exchange: str(m.fullExchangeName, 40) || str(m.exchangeName, 40),
    instrumentType: str(m.instrumentType, 24),
    tzOffsetSec: fin(m.gmtoffset) ? Math.max(-50400, Math.min(50400, m.gmtoffset)) : 0,
    timezone: str(m.exchangeTimezoneName, 48),
    regularMarketPrice: fin(m.regularMarketPrice) ? m.regularMarketPrice : null,
    candles: out,
  };
}

export async function fetchCandles(fetchImpl, symbol, interval) {
  if (!isValidSymbol(symbol)) throw new UpstreamError('สัญลักษณ์ไม่ถูกต้อง', 400);
  if (!INTERVALS.has(interval)) throw new UpstreamError('interval ไม่ถูกต้อง', 400);
  if (symbol.toUpperCase() === 'DEMO') return demoPayload(interval);
  const params = new URLSearchParams({ interval, includeAdjustedClose: 'true', events: 'div,splits' });
  if (interval === '1d') params.set('range', 'max');
  else {
    const now = Math.floor(Date.now() / 1000);
    params.set('period1', String(now - 729 * 86400));
    params.set('period2', String(now));
  }
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
  let lastErr;
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const text = await fetchLimited(fetchImpl, host + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const parsed = parseYahooChart(text);
      return { ...parsed, symbol: parsed.symbol || symbol.toUpperCase(), interval, source: 'Yahoo Finance' };
    } catch (e) {
      lastErr = e;
      if (e instanceof UpstreamError && (e.status === 404 || e.status === 400)) break;
    }
  }
  throw lastErr || new UpstreamError('ดึงข้อมูลไม่สำเร็จ', 502);
}

function demoPayload(interval) {
  const candles = demoCandles(interval === '1h' ? { days: 3200, interval: 'hour', seed: 42 } : { days: 2600, seed: 42 });
  return {
    symbol: 'DEMO', name: 'DEMO — ข้อมูลจำลอง (ไม่ใช่ราคาจริง)', currency: 'USD', exchange: 'Simulated', instrumentType: 'DEMO',
    tzOffsetSec: 0, timezone: 'UTC', regularMarketPrice: candles[candles.length - 1].c,
    candles: candles.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v, null]),
    interval, source: 'Simulated (deterministic random walk)',
  };
}
