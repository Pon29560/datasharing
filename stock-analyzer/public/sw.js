// Service worker: app shell is cached for offline start; market data (/api) is never cached.
const VERSION = 'signal-lab-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'js/app.js', 'js/dom.js', 'js/chart.js',
  'core/analyze.js', 'core/backtest.js', 'core/cdc.js', 'core/csv.js', 'core/demo.js', 'core/divergence.js', 'core/edge.js', 'core/elliott.js',
  'core/indicators.js', 'core/principles.js', 'core/psychology.js', 'core/resample.js', 'core/sentiment.js', 'core/stats.js',
  'core/strategies.js', 'core/validation.js', 'core/zigzag.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return; // always live
  // Network first (fresh code after updates), fall back to cache when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
