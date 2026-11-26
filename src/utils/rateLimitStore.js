'use strict';

/**
 * Shared PostgreSQL rate-limit store for express-rate-limit v7.
 * Holds counters across Vercel serverless instances in the `rate_limits` table.
 * Falls back safely to an internal Map if Postgres is temporarily unreachable.
 */
class PgRateLimitStore {
  constructor(pool, prefix = 'rl') {
    this.pool = pool;
    this.prefix = prefix;
    this.windowMs = 60 * 1000;
    this.localKeys = false;
    this.fallback = new Map();
    this._tablePromise = null;
  }

  init(options) {
    if (options && options.windowMs) {
      this.windowMs = options.windowMs;
    }
  }

  _ensureTable() {
    if (!this._tablePromise) {
      this._tablePromise = this.pool.query(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT PRIMARY KEY,
          hits INTEGER NOT NULL,
          reset_at TIMESTAMPTZ NOT NULL
        );
      `).catch(err => {
        this._tablePromise = null;
        throw err;
      });
    }
    return this._tablePromise;
  }

  _fullKey(key) {
    return `${this.prefix}:${key}`;
  }

  async increment(key) {
    const fullKey = this._fullKey(key);
    const resetMs = Date.now() + this.windowMs;
    try {
      await this._ensureTable();
      const res = await this.pool.query(`
        INSERT INTO rate_limits (key, hits, reset_at)
        VALUES ($1, 1, TO_TIMESTAMP($2 / 1000.0))
        ON CONFLICT (key) DO UPDATE SET
          hits = CASE
            WHEN rate_limits.reset_at <= NOW() THEN 1
            ELSE rate_limits.hits + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at <= NOW() THEN TO_TIMESTAMP($2 / 1000.0)
            ELSE rate_limits.reset_at
          END
        RETURNING hits, (EXTRACT(EPOCH FROM reset_at) * 1000)::bigint AS reset_ms;
      `, [fullKey, resetMs]);

      const row = res.rows[0];
      return {
        totalHits: Number(row.hits),
        resetTime: new Date(Number(row.reset_ms))
      };
    } catch (err) {
      console.warn('PgRateLimitStore increment fallback:', err && err.message);
      const now = Date.now();
      const prev = this.fallback.get(fullKey);
      const entry = (!prev || prev.resetMs <= now)
        ? { hits: 1, resetMs }
        : { hits: prev.hits + 1, resetMs: prev.resetMs };
      this.fallback.set(fullKey, entry);
      return { totalHits: entry.hits, resetTime: new Date(entry.resetMs) };
    }
  }

  async decrement(key) {
    const fullKey = this._fullKey(key);
    try {
      await this._ensureTable();
      await this.pool.query(
        'UPDATE rate_limits SET hits = GREATEST(0, hits - 1) WHERE key = $1',
        [fullKey]
      );
    } catch (_) {
      const entry = this.fallback.get(fullKey);
      if (entry && entry.hits > 0) entry.hits--;
    }
  }

  async resetKey(key) {
    const fullKey = this._fullKey(key);
    this.fallback.delete(fullKey);
    try {
      await this._ensureTable();
      await this.pool.query('DELETE FROM rate_limits WHERE key = $1', [fullKey]);
    } catch (_) {}
  }
}

module.exports = { PgRateLimitStore };
