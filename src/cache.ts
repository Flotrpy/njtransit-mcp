import type { KVLike } from "./types.ts";

/**
 * Two-level cache: an in-memory Map (fast, lost when the server restarts) in
 * front of an optional durable store (Cloudflare KV). Values are JSON.
 *
 * Caching matters here for three reasons: NJ Transit's terms want apps to
 * serve data from their own server rather than straight from NJT, the API
 * allows only 5 new tokens per day, and it keeps responses fast.
 */
export class Cache {
  private mem = new Map<string, { value: string; expires: number }>();
  private kv?: KVLike;
  private now: () => number;

  constructor(kv?: KVLike, now: () => number = Date.now) {
    this.kv = kv;
    this.now = now;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.mem.get(key);
    if (hit && hit.expires > this.now()) return JSON.parse(hit.value) as T;
    if (hit) this.mem.delete(key);
    if (this.kv) {
      try {
        const raw = await this.kv.get(key);
        if (raw != null) {
          const wrapped = JSON.parse(raw) as { v: string; e: number };
          if (wrapped.e > this.now()) {
            this.mem.set(key, { value: wrapped.v, expires: wrapped.e });
            return JSON.parse(wrapped.v) as T;
          }
        }
      } catch {
        // A cache miss is fine; never fail a request because of the cache.
      }
    }
    return undefined;
  }

  /** Store a value. `durable` also writes to KV (keep for rare writes: KV free tier allows 1,000/day). */
  async set(key: string, value: unknown, ttlSeconds: number, durable = false): Promise<void> {
    const v = JSON.stringify(value);
    const e = this.now() + ttlSeconds * 1000;
    this.mem.set(key, { value: v, expires: e });
    if (durable && this.kv) {
      try {
        // KV needs a TTL of at least 60 seconds.
        await this.kv.put(key, JSON.stringify({ v, e }), { expirationTtl: Math.max(60, ttlSeconds) });
      } catch {
        // Ignore: memory cache still works.
      }
    }
  }

  async delete(key: string): Promise<void> {
    this.mem.delete(key);
    if (this.kv) {
      try {
        await this.kv.put(key, JSON.stringify({ v: "null", e: 0 }), { expirationTtl: 60 });
      } catch {
        // ignore
      }
    }
  }

  /** Get from cache, or run `load` once and cache the result. Concurrent callers share one load. */
  private inflight = new Map<string, Promise<unknown>>();
  async getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>, durable = false): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = (async () => {
      try {
        const value = await load();
        await this.set(key, value, ttlSeconds, durable);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

/** A KVLike backed by a Map, for tests and the local Node server. */
export class MemoryKV implements KVLike {
  data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}
