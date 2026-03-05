import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

class InProcessSessionStore {
  constructor(stateStore, mutateDb) {
    this.stateStore = stateStore;
    this.mutateDb = mutateDb;
  }

  async create({ userId, ttlSeconds }) {
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const csrfToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const session = {
      id,
      token,
      csrfToken,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt
    };

    await this.mutateDb((db) => {
      db.sessions = (db.sessions || []).filter(s => Date.parse(s.expiresAt) > Date.now());
      db.sessions.push(session);
    });

    return session;
  }

  async get(token) {
    const db = await this.stateStore.read();
    const session = db.sessions.find(s => s.token === token && Date.parse(s.expiresAt) > Date.now());
    return session || null;
  }

  async delete(token) {
    await this.mutateDb((db) => {
      db.sessions = (db.sessions || []).filter(s => s.token !== token);
    });
  }
}

class RedisSessionStore {
  constructor(config) {
    this.redis = new Redis(config.url || {
      host: config.host || 'localhost',
      port: config.port || 6379,
      password: config.password || undefined
    });
    this.prefix = config.prefix || 'sess:';
  }

  async create({ userId, ttlSeconds }) {
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const csrfToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const session = {
      id,
      token,
      csrfToken,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt
    };

    // Store in Redis as a JSON string with EXPIRE
    await this.redis.set(
      `${this.prefix}${token}`,
      JSON.stringify(session),
      'EX',
      ttlSeconds
    );

    return session;
  }

  async get(token) {
    const raw = await this.redis.get(`${this.prefix}${token}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async delete(token) {
    await this.redis.del(`${this.prefix}${token}`);
  }
}

export function createSessionStore({ backend, config, stateStore, mutateDb }) {
  if (backend === 'redis') {
    return new RedisSessionStore(config);
  }
  return new InProcessSessionStore(stateStore, mutateDb);
}
