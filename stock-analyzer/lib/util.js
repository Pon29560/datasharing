// Small, dependency-free server utilities: bounded TTL cache, per-IP rate limiter,
// size/time-limited upstream fetch, and safe logging.

/**
 * LRU + TTL cache with an entry cap AND a byte budget. Values are stored as
 * pre-serialised strings so their size is exact (prevents memory-exhaustion DoS
 * by requesting many distinct large symbols).
 */
export class TTLCache {
  constructor(maxEntries = 300, maxBytes = 64 * 1024 * 1024) {
    this.max = maxEntries; this.maxBytes = maxBytes; this.bytes = 0; this.map = new Map(); this.inflight = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e); // LRU touch
    return e.value;
  }

  delete(key) {
    const e = this.map.get(key);
    if (e) { this.bytes -= e.size; this.map.delete(key); }
  }

  set(key, value, ttlMs) {
    const size = typeof value === 'string' ? value.length * 2 : 1024;
    if (size > this.maxBytes) return;
    this.delete(key);
    this.map.set(key, { value, exp: Date.now() + ttlMs, size });
    this.bytes += size;
    while (this.map.size > this.max || this.bytes > this.maxBytes) this.delete(this.map.keys().next().value);
  }

  /** Return cached value or run `fn` once even under concurrent requests. */
  async wrap(key, ttlMs, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try { const v = await fn(); this.set(key, v, ttlMs); return v; } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

/** Token bucket per key. */
export class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 1, maxKeys = 10000 } = {}) {
    this.capacity = capacity; this.refill = refillPerSec; this.maxKeys = maxKeys; this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { tokens: this.capacity, ts: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.ts) / 1000) * this.refill);
    b.ts = now;
    if (b.tokens < 1) return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / this.refill) };
    b.tokens -= 1;
    return { ok: true };
  }

  prune(now) {
    for (const [k, b] of this.buckets) if (now - b.ts > 600000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}

export class UpstreamError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

/** Hosts the server is ever allowed to contact (initial request AND every redirect hop). */
export const ALLOWED_HOSTS = new Set(['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'news.google.com', 'feeds.finance.yahoo.com', 'finance.yahoo.com']);

function assertAllowed(u) {
  let url;
  try { url = new URL(u); } catch { throw new UpstreamError('URL ปลายทางไม่ถูกต้อง', 502); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new UpstreamError('ปลายทางไม่อยู่ในรายการที่อนุญาต', 502);
  }
  return url.toString();
}

/**
 * fetch() with timeout, a hard cap on response bytes, and a host allow-list that is
 * re-checked on every redirect hop (redirects are followed manually, max 3) — no SSRF.
 */
export async function fetchLimited(fetchImpl, url, { timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let target = assertAllowed(url);
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(target, { headers, signal: ctrl.signal, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400 || res.status === 304) break;
      const loc = res.headers.get('location');
      if (!loc || hop >= 3) throw new UpstreamError('แหล่งข้อมูล redirect ผิดปกติ', 502);
      target = assertAllowed(new URL(loc, target).toString());
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    if (res.status === 404) throw new UpstreamError('ไม่พบสัญลักษณ์นี้ที่แหล่งข้อมูล', 404);
    if (res.status === 429) throw new UpstreamError('แหล่งข้อมูลจำกัดจำนวนคำขอ กรุณาลองใหม่ภายหลัง', 503);
    if (!res.ok) throw new UpstreamError(`แหล่งข้อมูลตอบกลับผิดพลาด (${res.status})`, 502);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new UpstreamError('ข้อมูลจากแหล่งข้อมูลใหญ่เกินกำหนด', 502);
    if (!res.body || typeof res.body.getReader !== 'function') {
      const text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) throw new UpstreamError('ข้อมูลจากแหล่งข้อมูลใหญ่เกินกำหนด', 502);
      return text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { ctrl.abort(); throw new UpstreamError('ข้อมูลจากแหล่งข้อมูลใหญ่เกินกำหนด', 502); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (e && e.name === 'AbortError') throw new UpstreamError('แหล่งข้อมูลตอบช้าเกินไป (timeout)', 504);
    throw new UpstreamError('เชื่อมต่อแหล่งข้อมูลไม่สำเร็จ', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Strip control characters / newlines so attacker-controlled text cannot forge log lines. */
export function safeLog(...parts) {
  const line = parts.map((p) => String(p instanceof Error ? p.message : p).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)).join(' ');
  console.error(`[${new Date().toISOString()}] ${line}`);
}
