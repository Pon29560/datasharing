// Security & robustness tests for the HTTP server (upstream calls are mocked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, resolveStatic, PUBLIC_DIR } from '../server.js';
import { parseRss, safeLink, decodeEntities } from '../lib/news.js';
import { parseYahooChart, isValidSymbol } from '../lib/providers.js';
import { fetchLimited, TTLCache } from '../lib/util.js';

const yahooOk = JSON.stringify({ chart: { result: [{
  meta: { symbol: 'AAPL', longName: 'Apple <script>alert(1)</script> Inc.', currency: 'USD', gmtoffset: -18000, fullExchangeName: 'NasdaqGS' },
  timestamp: [1700000000, 1700086400, 1700172800],
  indicators: { quote: [{ open: [1, null, 3], high: [2, 3, 4], low: [0.5, 1, 2], close: [1.5, 2, 3.5], volume: [10, 20, 30] }], adjclose: [{ adjclose: [1.4, 1.9, 3.4] }] },
}], error: null } });

const rss = `<?xml version="1.0"?><rss><channel>
<item><title>Apple beats &amp; raises &lt;b&gt;guidance&lt;/b&gt; - Reuters</title><link>https://example.com/a?x=1&amp;y=2</link><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source><description><![CDATA[<a href="https://x">click</a> <img src=x onerror=alert(1)> details]]></description></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
<item><title>Apple beats &amp; raises &lt;b&gt;guidance&lt;/b&gt;</title><link>https://dup.example.com/</link></item>
</channel></rss>`;

let calls = [];
function mockFetch(url) {
  calls.push(String(url));
  const u = new URL(url);
  const body = u.hostname.includes('finance.yahoo.com') && u.pathname.startsWith('/v8') ? yahooOk : rss;
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
}

let server; let base;
before(async () => {
  server = http.createServer(createApp({ fetchImpl: mockFetch, rateLimit: { capacity: 20, refillPerSec: 0.001 } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function raw(path, method = 'GET') {
  // http.request does not normalise "../" — lets us send hostile paths verbatim.
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { method, path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('security headers are present on every response', async () => {
  for (const p of ['/', '/api/health', '/does-not-exist']) {
    const r = await raw(p);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  }
});

test('path traversal, encoded traversal, dotfiles and disallowed types are refused', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/%2e%2e/etc/passwd', '/core/../../package.json', '/.git/config', '/%00index.html', '/..\\server.js', '/js/app.js%00.png', '/%E0%A4%A']) {
    const r = await raw(p);
    assert.equal(r.status, 404, `${p} -> ${r.status}`);
    assert.ok(!r.body.includes('createApp'), `leaked source via ${p}`);
  }
  assert.equal(resolveStatic('/../../etc/passwd'), null);
  assert.equal(resolveStatic('/index.html'), `${PUBLIC_DIR}/index.html`);
});

test('static files are served with correct types', async () => {
  const r = await raw('/js/app.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/javascript/);
  const idx = await raw('/');
  assert.match(idx.headers['content-type'], /text\/html/);
});

test('only GET/HEAD are allowed', async () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const r = await raw('/api/health', m);
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD');
  }
});

test('symbol / interval / query validation blocks injection attempts', async () => {
  calls = [];
  for (const s of ['AAPL/../../x', 'a b', '<script>', 'AAPL?x=1', 'A'.repeat(30), '', 'evil.com/x', 'AAPL#', '..']) {
    const r = await raw(`/api/candles?symbol=${encodeURIComponent(s)}&interval=1d`);
    assert.equal(r.status, 400, `symbol ${JSON.stringify(s)}`);
  }
  assert.equal((await raw('/api/candles?symbol=AAPL&interval=1m')).status, 400);
  assert.equal((await raw('/api/news?symbol=AAPL&q=%3Cscript%3E')).status, 400);
  assert.equal(calls.length, 0, 'no upstream request may be made for invalid input');
  assert.ok(!isValidSymbol('..') && isValidSymbol('^SET.BK') && isValidSymbol('GC=F') && isValidSymbol('BTC-USD'));
});

test('upstream URLs are always built on the fixed hosts (no SSRF)', async () => {
  calls = [];
  const r = await raw('/api/candles?symbol=AAPL&interval=1d');
  assert.equal(r.status, 200);
  const n = await raw('/api/news?symbol=PTT.BK&q=PTT');
  assert.equal(n.status, 200);
  for (const c of calls) assert.ok(['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'news.google.com', 'feeds.finance.yahoo.com'].includes(new URL(c).hostname), c);
});

test('Yahoo parser drops null bars and strips markup from metadata', () => {
  const p = parseYahooChart(yahooOk);
  assert.equal(p.candles.length, 2);
  assert.ok(!p.name.includes('<'));
  assert.equal(p.tzOffsetSec, -18000);
  assert.throws(() => parseYahooChart('not json'));
  assert.throws(() => parseYahooChart(JSON.stringify({ chart: { error: { code: 'Not Found' } } })));
});

test('RSS parser: decodes entities, strips HTML, drops non-http links, never returns markup', () => {
  const items = parseRss(rss, 'test');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Apple beats & raises guidance');
  assert.equal(items[0].source, 'Reuters');
  assert.equal(items[0].link, 'https://example.com/a?x=1&y=2');
  for (const it of items) for (const v of Object.values(it)) if (typeof v === 'string') assert.ok(!/[<>]/.test(v), `markup in ${v}`);
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('data:text/html,hi'), null);
  assert.equal(safeLink('https://user:pw@x.com/'), null);
  assert.equal(decodeEntities('&#x3c;&#60;&#0;&#xD800;'), '<<  ');
});

test('news endpoint de-duplicates headlines across feeds', async () => {
  const r = await raw('/api/news?symbol=AAPL&q=Apple');
  const body = JSON.parse(r.body);
  const titles = body.items.map((x) => x.title);
  assert.equal(new Set(titles).size, titles.length);
});

test('upstream response size is capped', async () => {
  const huge = () => Promise.resolve(new Response('x'.repeat(2 * 1024 * 1024)));
  await assert.rejects(fetchLimited(huge, 'https://query1.finance.yahoo.com/', { maxBytes: 1024 * 1024 }), /ใหญ่เกิน/);
});

test('rate limiting returns 429 with Retry-After', async () => {
  let got429 = null;
  for (let i = 0; i < 40 && !got429; i++) {
    const r = await raw('/api/health');
    if (r.status === 429) got429 = r;
  }
  assert.ok(got429, 'expected a 429');
  assert.ok(Number(got429.headers['retry-after']) >= 1);
});

test('overlong URLs are rejected', async () => {
  const r = await raw(`/api/health?x=${'a'.repeat(3000)}`);
  assert.equal(r.status, 414);
});

test('redirects to hosts outside the allow-list are refused (SSRF via redirect)', async () => {
  const redirector = (target) => () => Promise.resolve(new Response(null, { status: 302, headers: { location: target } }));
  for (const t of ['http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/', 'https://evil.example.com/', 'http://query1.finance.yahoo.com/', 'https://query1.finance.yahoo.com:8443/']) {
    await assert.rejects(fetchLimited(redirector(t), 'https://query1.finance.yahoo.com/v8/x'), /ไม่อยู่ในรายการ/, t);
  }
  await assert.rejects(fetchLimited(() => Promise.resolve(new Response('x')), 'https://evil.example.com/'), /ไม่อยู่ในรายการ/);
  // a redirect between allowed hosts is followed
  let n = 0;
  const hop = () => Promise.resolve(n++ === 0 ? new Response(null, { status: 301, headers: { location: 'https://query2.finance.yahoo.com/v8/y' } }) : new Response('ok'));
  assert.equal(await fetchLimited(hop, 'https://query1.finance.yahoo.com/v8/x'), 'ok');
  // redirect loops are cut off
  const loop = () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://query1.finance.yahoo.com/again' } }));
  await assert.rejects(fetchLimited(loop, 'https://query1.finance.yahoo.com/v8/x'), /redirect/);
});

test('RSS parser stays fast on hostile input (no catastrophic backtracking)', () => {
  const evil = [
    '<item>'.repeat(200000),
    `<item><title>${'<![CDATA['.repeat(50000)}</title></item>`,
    `<item><title>${'<'.repeat(300000)}`,
    `${'<item><link>'.repeat(50000)}</item>`,
  ];
  for (const x of evil) {
    const t0 = Date.now();
    parseRss(x, 'x');
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  }
});

test('cache enforces its byte budget (memory-exhaustion DoS)', () => {
  const c = new TTLCache(1000, 1024 * 1024);
  for (let i = 0; i < 100; i++) c.set(`k${i}`, 'x'.repeat(100000), 60000);
  assert.ok(c.bytes <= 1024 * 1024, `bytes=${c.bytes}`);
  assert.ok(c.map.size <= 6);
  assert.equal(c.get('k99').length, 100000, 'most recent entry kept');
  assert.equal(c.get('k0'), undefined, 'oldest entry evicted');
});

test('X-Forwarded-For cannot be spoofed to dodge the rate limit', async () => {
  const s2 = http.createServer(createApp({ fetchImpl: mockFetch, trustProxy: 1, rateLimit: { capacity: 5, refillPerSec: 0.001 } }));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const port = s2.address().port;
  const get = (xff) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { 'x-forwarded-for': xff } }, (res) => { res.resume(); resolve(res.statusCode); }));
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push(await get(`10.0.0.${i}, 203.0.113.7`)); // forged left part, real proxy-added right part
  s2.close();
  assert.ok(codes.includes(429), `forged XFF bypassed the limiter: ${codes}`);
});
