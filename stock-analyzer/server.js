// Signal Lab server — zero dependencies (Node >= 18).
//   * Serves the PWA from ./public (static, path-traversal safe, extension allow-list)
//   * /api/candles  -> Yahoo Finance OHLCV (validated symbol, cached, rate-limited)
//   * /api/news     -> Google News + Yahoo Finance RSS (sanitised)
//   * /api/health
// All analysis runs in the browser from the same code in public/core (privacy + scale).

import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TTLCache, RateLimiter, UpstreamError, safeLog } from './lib/util.js';
import { fetchCandles, isValidSymbol, INTERVALS } from './lib/providers.js';
import { fetchNews, QUERY_RE } from './lib/news.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, 'public');
const REAL_PUBLIC = realpathSync(PUBLIC_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res, { hsts = false } = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, obj, extra = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

/** Resolve a URL path to a file inside PUBLIC_DIR, or null. */
export function resolveStatic(urlPath, root = PUBLIC_DIR) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const segments = p.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) return null; // no dotfiles, no '..'
  const full = path.resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (!MIME[path.extname(full).toLowerCase()]) return null;
  return full;
}

async function serveStatic(req, res, urlPath) {
  const file = resolveStatic(urlPath);
  if (!file) return sendJson(res, 404, { error: 'not found' });
  let st;
  try {
    // Symlinks must not escape the public directory.
    const real = await realpath(file);
    if (real !== REAL_PUBLIC && !real.startsWith(REAL_PUBLIC + path.sep)) return sendJson(res, 404, { error: 'not found' });
    st = await stat(real);
  } catch { return sendJson(res, 404, { error: 'not found' }); }
  if (!st.isFile() || st.size > 5 * 1024 * 1024) return sendJson(res, 404, { error: 'not found' });
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext],
    ETag: etag,
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const body = await readFile(file);
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Client address for rate limiting. Behind N trusted reverse proxies (TRUST_PROXY=N) we take
 * the N-th address from the RIGHT of X-Forwarded-For — the left-most entries are supplied by
 * the client and can be forged to dodge the rate limit.
 */
function clientIp(req, trustProxy) {
  if (trustProxy > 0) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length < 1024) {
      const parts = xff.split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length >= trustProxy) return parts[parts.length - trustProxy];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createApp({ fetchImpl = globalThis.fetch, trustProxy = 0, hsts = false, rateLimit = { capacity: 60, refillPerSec: 1 }, cacheMB = 64 } = {}) {
  const cache = new TTLCache(300, cacheMB * 1024 * 1024);
  const limiter = new RateLimiter(rateLimit);

  return async function handler(req, res) {
    securityHeaders(res, { hsts });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      if (!req.url || req.url.length > 2048) return sendJson(res, 414, { error: 'uri too long' });
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (p.startsWith('/api/')) {
        const rl = limiter.take(clientIp(req, trustProxy));
        if (!rl.ok) return sendJson(res, 429, { error: 'คำขอถี่เกินไป กรุณารอสักครู่' }, { 'Retry-After': String(rl.retryAfter) });

        if (p === '/api/health') return sendJson(res, 200, { ok: true, time: Date.now() });

        if (p === '/api/candles') {
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const interval = url.searchParams.get('interval') || '1d';
          if (!isValidSymbol(symbol)) return sendJson(res, 400, { error: 'สัญลักษณ์ไม่ถูกต้อง (อนุญาต A-Z 0-9 . - ^ = ไม่เกิน 24 ตัว)' });
          if (!INTERVALS.has(interval)) return sendJson(res, 400, { error: 'interval ต้องเป็น 1d หรือ 1h' });
          const key = `c:${symbol.toUpperCase()}:${interval}`;
          const data = await cache.wrap(key, interval === '1d' ? 10 * 60000 : 3 * 60000, async () => JSON.stringify(await fetchCandles(fetchImpl, symbol, interval)));
          return sendJson(res, 200, data);
        }

        if (p === '/api/news') {
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const q = (url.searchParams.get('q') || '').trim();
          if (!isValidSymbol(symbol)) return sendJson(res, 400, { error: 'สัญลักษณ์ไม่ถูกต้อง' });
          if (q && !QUERY_RE.test(q)) return sendJson(res, 400, { error: 'คำค้นไม่ถูกต้อง' });
          if (symbol.toUpperCase() === 'DEMO') return sendJson(res, 200, { items: [], feeds: [], query: 'DEMO', note: 'โหมดสาธิตไม่มีข่าวจริง', fetchedAt: Date.now() });
          const thai = /\.BK$/i.test(symbol) || /[฀-๿]/.test(q);
          const key = `n:${symbol.toUpperCase()}:${q.toLowerCase()}`;
          const data = await cache.wrap(key, 10 * 60000, async () => JSON.stringify(await fetchNews(fetchImpl, { symbol, query: q, thai })));
          return sendJson(res, 200, data);
        }
        return sendJson(res, 404, { error: 'not found' });
      }
      return await serveStatic(req, res, p);
    } catch (e) {
      if (e instanceof UpstreamError) {
        safeLog('upstream', e.status, e.message);
        return sendJson(res, e.status, { error: e.message });
      }
      safeLog('internal error', e && e.stack ? e.stack : e);
      if (!res.headersSent) return sendJson(res, 500, { error: 'เกิดข้อผิดพลาดภายในระบบ' });
      return res.end();
    }
  };
}

export function startServer({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || '127.0.0.1' } = {}) {
  const trust = Math.max(0, Math.min(5, parseInt(process.env.TRUST_PROXY || '0', 10) || 0));
  const cacheMB = Math.max(8, Math.min(1024, parseInt(process.env.CACHE_MB || '64', 10) || 64));
  const handler = createApp({ trustProxy: trust, hsts: process.env.HSTS === '1', cacheMB });
  const server = http.createServer(handler);
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.listen(port, host, () => {
    console.log(`Signal Lab พร้อมใช้งานที่ http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (host === '0.0.0.0') console.log('เปิดจาก iPhone/iPad ในวง Wi-Fi เดียวกันด้วย http://<IP ของเครื่องนี้>:' + port);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
