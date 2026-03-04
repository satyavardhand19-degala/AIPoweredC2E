import { readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const DEFAULT_STATE = {
  users: [],
  sessions: [],
  projects: [],
  assets: [],
  briefInputs: [],
  voiceNotes: [],
  briefs: [],
  comments: [],
  checklistItems: [],
  aiRuns: [],
  auditLogs: []
};

function normalizeState(state) {
  const base = { ...DEFAULT_STATE };
  return {
    ...base,
    ...state,
    users: Array.isArray(state?.users) ? state.users : [],
    sessions: Array.isArray(state?.sessions) ? state.sessions : [],
    projects: Array.isArray(state?.projects) ? state.projects : [],
    assets: Array.isArray(state?.assets) ? state.assets : [],
    briefInputs: Array.isArray(state?.briefInputs) ? state.briefInputs : [],
    voiceNotes: Array.isArray(state?.voiceNotes) ? state.voiceNotes : [],
    briefs: Array.isArray(state?.briefs) ? state.briefs : [],
    comments: Array.isArray(state?.comments) ? state.comments : [],
    checklistItems: Array.isArray(state?.checklistItems) ? state.checklistItems : [],
    aiRuns: Array.isArray(state?.aiRuns) ? state.aiRuns : [],
    auditLogs: Array.isArray(state?.auditLogs) ? state.auditLogs : []
  };
}

async function readJsonFileSafe(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

class JsonStateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async init() {
    try {
      await stat(this.filePath);
    } catch {
      await writeFile(this.filePath, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    }
  }

  async read() {
    const raw = await readFile(this.filePath, 'utf8');
    return normalizeState(JSON.parse(raw));
  }

  async write(state) {
    await writeFile(this.filePath, JSON.stringify(normalizeState(state), null, 2), 'utf8');
  }
}

class SqliteStateStore {
  constructor(dbFilePath, fallbackJsonFilePath) {
    this.dbFilePath = dbFilePath;
    this.fallbackJsonFilePath = fallbackJsonFilePath;
    this.db = null;
  }

  async init() {
    this.db = new DatabaseSync(this.dbFilePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const row = this.db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
    if (row?.state_json) {
      return;
    }

    const imported = await readJsonFileSafe(this.fallbackJsonFilePath);
    const initial = normalizeState(imported || DEFAULT_STATE);

    this.db
      .prepare('INSERT INTO app_state (id, state_json, updated_at) VALUES (1, ?, ?)')
      .run(JSON.stringify(initial), new Date().toISOString());
  }

  async read() {
    const row = this.db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
    const parsed = row?.state_json ? JSON.parse(row.state_json) : DEFAULT_STATE;
    return normalizeState(parsed);
  }

  async write(state) {
    const payload = JSON.stringify(normalizeState(state));
    this.db
      .prepare('UPDATE app_state SET state_json = ?, updated_at = ? WHERE id = 1')
      .run(payload, new Date().toISOString());
  }
}

class PostgresStateStore {
  constructor(config, fallbackJsonFilePath) {
    this.config = config;
    this.fallbackJsonFilePath = fallbackJsonFilePath;
    this.pool = null;
  }

  async init() {
    const { Pool } = pg;
    const config = {
      host: this.config.host || 'localhost',
      port: this.config.port || 5432,
      database: this.config.database || 'appdb',
      user: this.config.user || 'postgres',
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
      max: this.config.maxConnections || 10,
      connectionString: this.config.connectionString || undefined
    };
    if (this.config.password) {
      config.password = this.config.password;
    }
    this.pool = new Pool(config);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const result = await this.pool.query('SELECT state_json FROM app_state WHERE id = 1');
    if (result.rows.length === 0 || !result.rows[0]?.state_json) {
      const imported = await readJsonFileSafe(this.fallbackJsonFilePath);
      const initial = normalizeState(imported || DEFAULT_STATE);
      await this.pool.query(
        'INSERT INTO app_state (id, state_json, updated_at) VALUES (1, $1, $2)',
        [JSON.stringify(initial), new Date().toISOString()]
      );
    }
  }

  async read() {
    const result = await this.pool.query('SELECT state_json FROM app_state WHERE id = 1');
    const parsed = result.rows[0]?.state_json ? JSON.parse(result.rows[0].state_json) : DEFAULT_STATE;
    return normalizeState(parsed);
  }

  async write(state) {
    const payload = JSON.stringify(normalizeState(state));
    await this.pool.query(
      'UPDATE app_state SET state_json = $1, updated_at = $2 WHERE id = 1',
      [payload, new Date().toISOString()]
    );
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

export function createStateStore({ backend, jsonFilePath, sqliteFilePath, postgresConfig }) {
  if (backend === 'json') {
    return new JsonStateStore(jsonFilePath);
  }
  if (backend === 'postgres') {
    return new PostgresStateStore(postgresConfig, jsonFilePath);
  }
  return new SqliteStateStore(sqliteFilePath, jsonFilePath);
}
