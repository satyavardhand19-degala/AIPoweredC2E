import Redis from 'ioredis';

class InProcessRateLimiter {
  constructor() {
    this.store = new Map();
  }

  async check({ key, limit, windowMs }) {
    const now = Date.now();
    const current = this.store.get(key);

    if (this.store.size > 5000) {
      for (const [k, v] of this.store.entries()) {
        if (now >= v.resetAt) this.store.delete(k);
      }
    }

    if (!current || now >= current.resetAt) {
      this.store.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: current.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: limit - current.count,
      resetAt: current.resetAt
    };
  }
}

class RedisRateLimiter {
  constructor(config) {
    this.redis = new Redis(config.url || {
      host: config.host || 'localhost',
      port: config.port || 6379,
      password: config.password || undefined
    });
    this.prefix = config.prefix || 'rl:';
  }

  async check({ key, limit, windowMs }) {
    const fullKey = `${this.prefix}${key}`;
    const now = Date.now();

    // Use Lua script for atomic increment and expire
    const script = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("PEXPIRE", KEYS[1], ARGV[1])
      end
      local pttl = redis.call("PTTL", KEYS[1])
      return {current, pttl}
    `;

    try {
      const [count, pttlMs] = await this.redis.eval(script, 1, fullKey, windowMs);
      const resetAt = now + (pttlMs > 0 ? pttlMs : windowMs);

      if (count > limit) {
        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfterSeconds: Math.max(1, Math.ceil(pttlMs / 1000))
        };
      }

      return {
        allowed: true,
        remaining: Math.max(0, limit - count),
        resetAt
      };
    } catch (err) {
      // Fallback: if Redis fails, allow request but log error
      console.error('Rate limiter redis error:', err);
      return { allowed: true, remaining: 1, resetAt: now + windowMs };
    }
  }
}

export function createRateLimiter({ backend, config }) {
  if (backend === 'redis') {
    return new RedisRateLimiter(config);
  }
  return new InProcessRateLimiter();
}
