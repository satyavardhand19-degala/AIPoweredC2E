import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStore } from './lib/state_store.mjs';
import { createObjectStore } from './lib/object_store.mjs';

import { createRateLimiter } from './lib/rate_limiter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_JSON_FILE = path.join(DATA_DIR, 'db.json');
const DATA_SQLITE_FILE = path.join(DATA_DIR, 'app_state.db');
const DATA_BACKEND = process.env.DATA_BACKEND || 'sqlite';
const OBJECT_STORE_BACKEND = process.env.OBJECT_STORE_BACKEND || 'local';
const RATE_LIMIT_BACKEND = process.env.RATE_LIMIT_BACKEND || 'in-process';
const SESSION_BACKEND = process.env.SESSION_BACKEND || 'in-process';
const ENABLE_ASYNC_JOBS = process.env.ENABLE_ASYNC_JOBS === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';

const POSTGRES_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'appdb',
  user: process.env.POSTGRES_USER || 'postgres',
  ssl: process.env.POSTGRES_SSL === 'true',
  maxConnections: Number(process.env.POSTGRES_MAX_CONNECTIONS || 10),
  connectionString: process.env.DATABASE_URL || undefined
};
if (process.env.POSTGRES_PASSWORD) {
  POSTGRES_CONFIG.password = process.env.POSTGRES_PASSWORD;
}

const S3_CONFIG = {
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || '',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ''
};

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined
};

const SESSION_COOKIE_NAME = 'ce_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_SECURE_COOKIE = process.env.NODE_ENV === 'production';
const CSRF_HEADER_NAME = 'x-csrf-token';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 240);
const RATE_LIMIT_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX || 30);
const ENABLE_REQUEST_LOGS = process.env.ENABLE_REQUEST_LOGS === '1';

const rateLimiter = createRateLimiter({
  backend: RATE_LIMIT_BACKEND,
  config: REDIS_CONFIG
});

const telemetry = {
  startedAtMs: Date.now(),
  requestsTotal: 0,
  apiRequestsTotal: 0,
  responsesByStatus: {},
  apiRateLimitedTotal: 0,
  errors5xxTotal: 0,
  aiLatencyTotalMs: 0,
  aiRequestsTotal: 0,
  dbLatencyTotalMs: 0,
  dbRequestsTotal: 0
};

const stateStore = createStateStore({
  backend: DATA_BACKEND,
  jsonFilePath: DATA_JSON_FILE,
  sqliteFilePath: DATA_SQLITE_FILE,
  postgresConfig: POSTGRES_CONFIG
});

const objectStore = createObjectStore({
  backend: OBJECT_STORE_BACKEND,
  config: S3_CONFIG,
  baseDir: UPLOAD_DIR,
  baseUrl: '/uploads'
});

async function readDb() {
  const start = Date.now();
  const db = await stateStore.read();
  recordDbTelemetry({ durationMs: Date.now() - start });
  return db;
}

async function writeDb(db) {
  const start = Date.now();
  await stateStore.write(db);
  recordDbTelemetry({ durationMs: Date.now() - start });
}

let dbMutationQueue = Promise.resolve();

async function mutateDb(mutator) {
  let result;
  dbMutationQueue = dbMutationQueue
    .catch(() => {})
    .then(async () => {
      const db = await readDb();
      result = await mutator(db);
      await writeDb(db);
    });
  await dbMutationQueue;
  return result;
}

import { JobQueue } from './lib/queue.mjs';
const aiJobQueue = new JobQueue('ai-tasks', { redis: REDIS_CONFIG });

import { createSessionStore } from './lib/session_store.mjs';
const sessionStore = createSessionStore({
  backend: SESSION_BACKEND === 'redis' ? 'redis' : 'in-process',
  config: REDIS_CONFIG,
  stateStore,
  mutateDb
});

async function ensureStorage() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await stateStore.init();
  await objectStore.init();
}


function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // CSP: Basic policy allowing self and few essentials
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:;");
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  // In production, you would check origin against an allow-list
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, ${CSRF_HEADER_NAME}`);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, status, payload, headers = {}) {
  applySecurityHeaders(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendError(res, status, code, message, details = null) {
  sendJson(res, status, {
    error: {
      code,
      message,
      details
    }
  });
}

function notFound(res) {
  sendError(res, 404, 'NOT_FOUND', 'The requested resource was not found');
}

function badRequest(res, message, details = null) {
  sendError(res, 400, 'BAD_REQUEST', message, details);
}

function unauthorized(res, message = 'Authentication required') {
  sendError(res, 401, 'UNAUTHORIZED', message);
}

function forbidden(res, message = 'Forbidden') {
  sendError(res, 403, 'FORBIDDEN', message);
}

function safeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function buildCookie(name, value, options = {}) {
  const chunks = [`${name}=${encodeURIComponent(value)}`];
  chunks.push(`Path=${options.path || '/'}`);
  if (typeof options.maxAge === 'number') {
    chunks.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) {
    chunks.push('HttpOnly');
  }
  if (options.sameSite) {
    chunks.push(`SameSite=${options.sameSite}`);
  } else {
    chunks.push('SameSite=Lax');
  }
  if (options.secure) {
    chunks.push('Secure');
  }
  return chunks.join('; ');
}

function findUserByNameAndRole(db, name, role) {
  const nameKey = normalizeName(name);
  const roleKey = safeLower(role);
  return db.users.find((user) => normalizeName(user.name) === nameKey && safeLower(user.role) === roleKey);
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE_NAME] || '';
}

async function getSessionFromDb(req) {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }
  return sessionStore.get(token);
}

async function getCurrentUserFromDb(req, db) {
  const session = await getSessionFromDb(req);
  if (!session) {
    return null;
  }
  const user = db.users.find((entry) => entry.id === session.userId);
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    name: user.name,
    role: user.role
  };
}

async function getCurrentAuthContext(req, db) {
  const session = await getSessionFromDb(req);
  if (!session) {
    return null;
  }
  const user = db.users.find((entry) => entry.id === session.userId);
  if (!user) {
    return null;
  }
  return {
    user: {
      id: user.id,
      name: user.name,
      role: user.role
    },
    session
  };
}

function getClientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (typeof header === 'string' && header.trim()) {
    return header.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function pickRateLimitBucket(pathname) {
  if (pathname === '/api/auth/login') {
    return 'auth-login';
  }
  if (pathname.startsWith('/api/auth/')) {
    return 'auth';
  }
  return 'api';
}

async function applyRateLimit(req, pathname) {
  const ip = getClientIp(req);
  const bucket = pickRateLimitBucket(pathname);
  const key = `${ip}:${bucket}`;
  const limit = bucket === 'auth-login' ? RATE_LIMIT_AUTH_MAX : RATE_LIMIT_MAX;

  return rateLimiter.check({
    key,
    limit,
    windowMs: RATE_LIMIT_WINDOW_MS
  });
}

function shouldEnforceCsrf(method, pathname) {
  if (!pathname.startsWith('/api/')) {
    return false;
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return false;
  }
  if (pathname === '/api/auth/login') {
    return false;
  }
  return true;
}

function recordAiTelemetry({ durationMs, success }) {
  telemetry.aiLatencyTotalMs += durationMs;
  telemetry.aiRequestsTotal += 1;
}

function recordDbTelemetry({ durationMs }) {
  telemetry.dbLatencyTotalMs += durationMs;
  telemetry.dbRequestsTotal += 1;
}

function recordResponseTelemetry({ method, pathname, statusCode, durationMs }) {
  telemetry.requestsTotal += 1;
  if (pathname.startsWith('/api/')) {
    telemetry.apiRequestsTotal += 1;
  }
  const statusKey = String(statusCode || 0);
  telemetry.responsesByStatus[statusKey] = (telemetry.responsesByStatus[statusKey] || 0) + 1;
  if (pathname.startsWith('/api/') && Number(statusCode) === 429) {
    telemetry.apiRateLimitedTotal += 1;
  }
  if (Number(statusCode) >= 500) {
    telemetry.errors5xxTotal += 1;
    console.error(
      JSON.stringify({
        at: new Date().toISOString(),
        level: 'error',
        method,
        pathname,
        statusCode,
        durationMs,
        msg: 'Internal Server Error'
      })
    );
  }
  if (ENABLE_REQUEST_LOGS) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        level: 'info',
        method,
        pathname,
        statusCode,
        durationMs
      })
    );
  }
}

function canAccessProject(project, user) {
  if (!project || !user) {
    return false;
  }
  if (project.creatorUserId && project.creatorUserId === user.id) {
    return true;
  }
  if (project.editorUserId && project.editorUserId === user.id) {
    return true;
  }
  const userName = normalizeName(user.name);
  return userName === normalizeName(project.creatorName) || userName === normalizeName(project.editorName);
}

function extractProjectIdFromAssetFileName(fileName) {
  const match = String(fileName || '').match(/^([a-f0-9-]{36})_/i);
  return match ? match[1] : null;
}

function fallbackVoiceTranscript(fileName, contextType) {
  const base = String(fileName || 'voice note').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  if (contextType === 'feedback') {
    return `Voice feedback note: ${base || 'transcript unavailable'}.`;
  }
  return `Voice brief note: ${base || 'transcript unavailable'}.`;
}

function parseDurationHint(text) {
  const normalized = text.toLowerCase();
  const under = normalized.match(/under\s*(\d{1,3})\s*(s|sec|seconds)?/i);
  if (under) {
    return Number(under[1]);
  }
  const generic = normalized.match(/(\d{1,3})\s*(s|sec|seconds)/i);
  if (generic) {
    return Number(generic[1]);
  }
  return 30;
}

function inferBriefFromText(text) {
  const lower = text.toLowerCase();
  const hookStyle = lower.includes('hook')
    ? 'Pattern interrupt hook in first 2 seconds'
    : 'Start with bold claim + immediate context';

  const tone = lower.includes('funny')
    ? 'Playful and conversational'
    : lower.includes('serious')
      ? 'Serious, authoritative, concise'
      : 'Direct, energetic, practical';

  const captionStyle = lower.includes('yellow')
    ? 'Large yellow keywords with white support text'
    : lower.includes('minimal')
      ? 'Minimal captions with key highlights'
      : 'Readable high-contrast captions with emphasized keywords';

  const musicVibe = lower.includes('trending') ? 'Trending but subtle background beat' : 'Clean low-volume background beat';

  const ctaType = lower.includes('follow')
    ? 'Follow prompt'
    : lower.includes('comment')
      ? 'Comment prompt'
      : lower.includes('share')
        ? 'Share prompt'
        : 'Comment prompt';

  return {
    hook_style: hookStyle,
    tone,
    target_duration_sec: parseDurationHint(text),
    caption_style: captionStyle,
    music_vibe: musicVibe,
    cta_type: ctaType,
    dos: ['Hook fast', 'Keep cuts tight', 'Maintain one clear message'],
    donts: ['Long intro', 'Caption clutter', 'No CTA at ending']
  };
}

function inferChecklistItem(comment) {
  const text = String(comment.text || '').trim();
  const lower = text.toLowerCase();
  const ts = Number.isFinite(comment.timestampSec) ? comment.timestampSec : 0;

  let title = `Address feedback around ${Math.floor(ts)}s`;
  let details = text;
  let priority = 'P2';

  if (/(hook|opening|start|first)/.test(lower)) {
    title = `Improve hook pacing around ${Math.floor(ts)}s`;
    priority = 'P0';
  } else if (/(lag|slow|stuck|jerk)/.test(lower)) {
    title = `Fix pacing/lag issue around ${Math.floor(ts)}s`;
    priority = 'P0';
  } else if (/(caption|text|wording|subtitle)/.test(lower)) {
    title = `Update caption/text around ${Math.floor(ts)}s`;
    priority = 'P1';
  } else if (/(cta|call to action|ending|end)/.test(lower)) {
    title = 'Add or refine ending CTA';
    priority = 'P1';
  } else if (/(audio|music|voice|sound)/.test(lower)) {
    title = `Fix audio issue around ${Math.floor(ts)}s`;
    priority = 'P0';
  }

  return {
    title,
    details,
    priority,
    owner: 'editor',
    timestampSec: ts,
    sourceCommentId: comment.id
  };
}

function pickPriority(value) {
  const p = String(value || '').toUpperCase();
  if (['P0', 'P1', 'P2'].includes(p)) {
    return p;
  }
  return 'P2';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function normalizeBriefFromModel(candidate, sourceInput) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const hookStyle = String(candidate.hook_style || '').trim();
  const tone = String(candidate.tone || '').trim();
  const captionStyle = String(candidate.caption_style || '').trim();
  const musicVibe = String(candidate.music_vibe || '').trim();
  const ctaType = String(candidate.cta_type || '').trim();

  if (!hookStyle || !tone || !captionStyle || !musicVibe || !ctaType) {
    return null;
  }

  const dos = Array.isArray(candidate.dos)
    ? candidate.dos.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 7)
    : [];
  const donts = Array.isArray(candidate.donts)
    ? candidate.donts.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 7)
    : [];

  return {
    hook_style: hookStyle,
    tone,
    target_duration_sec: clampNumber(candidate.target_duration_sec, 5, 180, parseDurationHint(sourceInput)),
    caption_style: captionStyle,
    music_vibe: musicVibe,
    cta_type: ctaType,
    dos: dos.length ? dos : ['Hook fast', 'Keep cuts tight', 'Maintain one clear message'],
    donts: donts.length ? donts : ['Long intro', 'Caption clutter', 'No CTA at ending']
  };
}

function normalizeChecklistCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return [];
  }

  const dedup = new Set();
  const out = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const title = String(candidate.title || '').trim();
    const details = String(candidate.details || title).trim();
    if (!title) {
      continue;
    }
    const timestampSec = Math.max(0, Number(candidate.timestampSec ?? candidate.timestamp ?? 0) || 0);
    const key = `${title.toLowerCase()}|${Math.floor(timestampSec / 3)}`;
    if (dedup.has(key)) {
      continue;
    }
    dedup.add(key);

    out.push({
      priority: pickPriority(candidate.priority),
      title,
      details,
      owner: 'editor',
      timestampSec
    });
  }

  return out.slice(0, 30);
}

function closestCommentIdByTimestamp(comments, timestampSec) {
  if (!comments.length) {
    return null;
  }
  let best = comments[0];
  let bestDist = Math.abs((Number(best.timestampSec) || 0) - timestampSec);
  for (const comment of comments.slice(1)) {
    const dist = Math.abs((Number(comment.timestampSec) || 0) - timestampSec);
    if (dist < bestDist) {
      best = comment;
      bestDist = dist;
    }
  }
  return best?.id || null;
}

function heuristicChecklistCandidates(sourceComments) {
  const dedup = new Set();
  const generated = [];
  for (const comment of sourceComments) {
    const item = inferChecklistItem(comment);
    const key = `${item.title.toLowerCase()}|${Math.floor(item.timestampSec / 3)}`;
    if (dedup.has(key)) {
      continue;
    }
    dedup.add(key);
    generated.push({
      priority: item.priority,
      title: item.title,
      details: item.details,
      owner: item.owner,
      timestampSec: item.timestampSec,
      sourceCommentId: item.sourceCommentId
    });
  }
  return generated.slice(0, 30);
}

function normalizeSummaryFromModel(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const improvements = Array.isArray(candidate.improvements)
    ? candidate.improvements.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 7)
    : [];
  const remaining = Array.isArray(candidate.remaining_issues)
    ? candidate.remaining_issues.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 7)
    : [];

  return {
    improvements,
    remaining_issues: remaining,
    publish_readiness_score: clampNumber(candidate.publish_readiness_score, 0, 100, 50)
  };
}

const BRIEF_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hook_style: { type: 'string' },
    tone: { type: 'string' },
    target_duration_sec: { type: 'number' },
    caption_style: { type: 'string' },
    music_vibe: { type: 'string' },
    cta_type: { type: 'string' },
    dos: { type: 'array', items: { type: 'string' } },
    donts: { type: 'array', items: { type: 'string' } }
  },
  required: ['hook_style', 'tone', 'target_duration_sec', 'caption_style', 'music_vibe', 'cta_type', 'dos', 'donts']
};

const CHECKLIST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          title: { type: 'string' },
          details: { type: 'string' },
          owner: { type: 'string' },
          timestampSec: { type: 'number' }
        },
        required: ['priority', 'title', 'details', 'owner', 'timestampSec']
      }
    }
  },
  required: ['items']
};

const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    improvements: { type: 'array', items: { type: 'string' } },
    remaining_issues: { type: 'array', items: { type: 'string' } },
    publish_readiness_score: { type: 'number' }
  },
  required: ['improvements', 'remaining_issues', 'publish_readiness_score']
};

function extractResponsesOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload?.output)) {
    return '';
  }

  const chunks = [];
  for (const outputItem of payload.output) {
    if (!Array.isArray(outputItem?.content)) {
      continue;
    }
    for (const contentItem of outputItem.content) {
      if (contentItem?.type === 'output_text' && typeof contentItem?.text === 'string') {
        chunks.push(contentItem.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

async function callOpenAIJson({ schemaName, schema, systemPrompt, userPrompt }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'missing_api_key' };
  }

  const start = Date.now();
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: schemaName,
            schema,
            strict: true
          }
        }
      })
    });

    if (!response.ok) {
      recordAiTelemetry({ durationMs: Date.now() - start, success: false });
      return { ok: false, error: `openai_http_${response.status}` };
    }

    const payload = await response.json();
    const rawText = extractResponsesOutputText(payload);
    if (!rawText) {
      recordAiTelemetry({ durationMs: Date.now() - start, success: false });
      return { ok: false, error: 'empty_output' };
    }

    try {
      const data = JSON.parse(rawText);
      recordAiTelemetry({ durationMs: Date.now() - start, success: true });
      return { ok: true, data };
    } catch {
      recordAiTelemetry({ durationMs: Date.now() - start, success: false });
      return { ok: false, error: 'invalid_json_output' };
    }
  } catch (error) {
    recordAiTelemetry({ durationMs: Date.now() - start, success: false });
    return { ok: false, error: error instanceof Error ? error.message : 'openai_request_failed' };
  }
}

async function callOpenAITranscription({ buffer, fileName, mimeType }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'missing_api_key' };
  }

  const start = Date.now();
  try {
    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
    formData.append('file', blob, fileName || 'voice-note.wav');
    formData.append('model', OPENAI_STT_MODEL);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: formData
    });

    if (!response.ok) {
      recordAiTelemetry({ durationMs: Date.now() - start, success: false });
      return { ok: false, error: `openai_stt_http_${response.status}` };
    }

    const payload = await response.json();
    const text = String(payload?.text || '').trim();
    if (!text) {
      recordAiTelemetry({ durationMs: Date.now() - start, success: false });
      return { ok: false, error: 'openai_stt_empty_text' };
    }
    recordAiTelemetry({ durationMs: Date.now() - start, success: true });
    return { ok: true, text };
  } catch (error) {
    recordAiTelemetry({ durationMs: Date.now() - start, success: false });
    return { ok: false, error: error instanceof Error ? error.message : 'openai_stt_failed' };
  }
}

function latestAssetByVersion(assets, versionLabel) {
  return assets
    .filter((asset) => asset.versionLabel === versionLabel)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function projectSummary(project, db) {
  const assets = db.assets.filter((asset) => asset.projectId === project.id);
  const comments = db.comments.filter((item) => item.projectId === project.id);
  const checklistItems = db.checklistItems.filter((item) => item.projectId === project.id);
  const briefs = db.briefs.filter((item) => item.projectId === project.id);

  return {
    ...project,
    assets,
    metrics: {
      commentsCount: comments.length,
      checklistOpenCount: checklistItems.filter((item) => item.status !== 'done').length,
      checklistDoneCount: checklistItems.filter((item) => item.status === 'done').length,
      briefCount: briefs.length
    }
  };
}

function ensureProject(db, projectId) {
  return db.projects.find((project) => project.id === projectId);
}

function updateProjectStatusFromChecklist(projectId, db) {
  const project = ensureProject(db, projectId);
  if (!project) {
    return;
  }

  const items = db.checklistItems.filter((item) => item.projectId === projectId);
  if (!items.length) {
    return;
  }

  const open = items.filter((item) => item.status !== 'done').length;
  project.status = open > 0 ? 'changes_requested' : 'ready_for_publish';
}

const VALIDATION_SCHEMAS = {
  login: {
    name: { type: 'string', min: 1, max: 50, required: true },
    role: { type: 'string', enum: ['creator', 'editor'], required: true }
  },
  createProject: {
    title: { type: 'string', min: 3, max: 100, required: true },
    creatorName: { type: 'string', min: 1, max: 50, required: true },
    editorName: { type: 'string', min: 1, max: 50, required: true }
  },
  createBriefInput: {
    inputType: { type: 'string', enum: ['text', 'voice', 'url'], required: true },
    content: { type: 'string', min: 1, max: 5000, required: true }
  }
};

function validate(data, schema) {
  const errors = [];
  for (const [key, rules] of Object.entries(schema)) {
    const value = data[key];
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${key} is required`);
      continue;
    }
    if (value === undefined || value === null || value === '') continue;

    if (rules.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`${key} must be a string`);
      } else {
        if (rules.min && value.length < rules.min) errors.push(`${key} must be at least ${rules.min} characters`);
        if (rules.max && value.length > rules.max) errors.push(`${key} must be at most ${rules.max} characters`);
      }
    }
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push(`${key} must be one of: ${rules.enum.join(', ')}`);
    }
  }
  return errors.length > 0 ? errors : null;
}

async function parseJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Payload too large');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function parseMultipartBody(req, contentType, maxBytes = 120 * 1024 * 1024) {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }

  const boundary = boundaryMatch[1];
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Upload too large');
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('latin1');
  const parts = body.split(`--${boundary}`).slice(1, -1);

  const fields = {};
  let filePart = null;

  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sepIndex = part.indexOf('\r\n\r\n');
    if (sepIndex === -1) {
      continue;
    }

    const headerBlock = part.slice(0, sepIndex);
    let content = part.slice(sepIndex + 4);
    if (content.endsWith('\r\n')) {
      content = content.slice(0, -2);
    }

    const dispositionLine = headerBlock
      .split('\r\n')
      .find((line) => line.toLowerCase().startsWith('content-disposition'));

    if (!dispositionLine) {
      continue;
    }

    const nameMatch = dispositionLine.match(/name="([^"]+)"/i);
    if (!nameMatch) {
      continue;
    }

    const fieldName = nameMatch[1];
    const filenameMatch = dispositionLine.match(/filename="([^"]*)"/i);

    if (filenameMatch && filenameMatch[1]) {
      const typeLine = headerBlock
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('content-type'));
      const mimeType = typeLine ? typeLine.split(':')[1].trim() : 'application/octet-stream';
      filePart = {
        fieldName,
        originalName: filenameMatch[1],
        mimeType,
        buffer: Buffer.from(content, 'latin1')
      };
    } else {
      fields[fieldName] = content;
    }
  }

  return { fields, file: filePart };
}

function getMimeTypeFromExt(ext) {
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function serveBuffer(res, data, fileName, contentType = null) {
  const ext = path.extname(fileName).toLowerCase();
  const finalContentType = contentType || getMimeTypeFromExt(ext);
  res.writeHead(200, {
    'Content-Type': finalContentType,
    'Content-Length': data.length
  });
  res.end(data);
}

async function serveStaticFile(res, fsPath) {
  try {
    const data = await readFile(fsPath);
    serveBuffer(res, data, fsPath);
  } catch {
    notFound(res);
  }
}

function logAiRun(db, projectId, taskType, inputRef, outputRef, status = 'success', meta = {}) {
  db.aiRuns.push({
    id: randomUUID(),
    projectId,
    taskType,
    inputRef,
    outputRef,
    status,
    ...meta,
    createdAt: new Date().toISOString()
  });
}

function normalizeAuditMeta(meta = {}) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.slice(0, 280);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.stringify(value).slice(0, 280);
    } catch {
      out[key] = String(value).slice(0, 280);
    }
  }
  return out;
}

function logAudit(db, { projectId = null, user = null, action, targetType, targetId = null, result = 'success', req, meta = {} }) {
  if (!Array.isArray(db.auditLogs)) {
    db.auditLogs = [];
  }
  db.auditLogs.push({
    id: randomUUID(),
    projectId: projectId || null,
    userId: user?.id || null,
    userRole: user?.role || null,
    action,
    targetType,
    targetId: targetId || null,
    result,
    ip: req ? getClientIp(req) : 'unknown',
    userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 200) : '',
    meta: normalizeAuditMeta(meta),
    createdAt: new Date().toISOString()
  });
  if (db.auditLogs.length > 5000) {
    db.auditLogs = db.auditLogs.slice(-5000);
  }
}

const server = createServer(async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const requestStartedAt = Date.now();
    let responseStatusCode = 200;
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (statusCode, ...args) => {
      responseStatusCode = Number(statusCode) || 200;
      return originalWriteHead(statusCode, ...args);
    };
    res.setHeader('X-Request-Id', randomUUID());
    res.on('finish', () => {
      recordResponseTelemetry({
        method,
        pathname,
        statusCode: responseStatusCode,
        durationMs: Date.now() - requestStartedAt
      });
    });

    if (pathname.startsWith('/api/')) {
      const limit = await applyRateLimit(req, pathname);
      if (!limit.allowed) {
        return sendError(
          res,
          429,
          'RATE_LIMIT_EXCEEDED',
          'Too many requests, please try again later.',
          {
            retryAfterSeconds: limit.retryAfterSeconds
          }
        );
      }
    }

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        time: new Date().toISOString(),
        uptimeSec: Math.floor((Date.now() - telemetry.startedAtMs) / 1000),
        storage: {
          stateBackend: DATA_BACKEND,
          objectStoreBackend: OBJECT_STORE_BACKEND
        },
        telemetry: {
          requestsTotal: telemetry.requestsTotal,
          apiRequestsTotal: telemetry.apiRequestsTotal,
          apiRateLimitedTotal: telemetry.apiRateLimitedTotal,
          errors5xxTotal: telemetry.errors5xxTotal
        }
      });
    }

    if (method === 'GET' && pathname === '/api/metrics') {
      const uptimeSec = Math.max(1, (Date.now() - telemetry.startedAtMs) / 1000);
      return sendJson(res, 200, {
        uptime_seconds: uptimeSec,
        requests_total: telemetry.requestsTotal,
        requests_per_second: (telemetry.requestsTotal / uptimeSec).toFixed(4),
        api_requests_total: telemetry.apiRequestsTotal,
        api_rate_limited_total: telemetry.apiRateLimitedTotal,
        errors_5xx_total: telemetry.errors5xxTotal,
        ai: {
          requests_total: telemetry.aiRequestsTotal,
          avg_latency_ms: (telemetry.aiLatencyTotalMs / Math.max(1, telemetry.aiRequestsTotal)).toFixed(2)
        },
        db: {
          requests_total: telemetry.dbRequestsTotal,
          avg_latency_ms: (telemetry.dbLatencyTotalMs / Math.max(1, telemetry.dbRequestsTotal)).toFixed(2)
        },
        responses_by_status: telemetry.responsesByStatus
      });
    }

    if (shouldEnforceCsrf(method, pathname)) {
      const db = await readDb();
      const auth = await getCurrentAuthContext(req, db);
      if (!auth) {
        return unauthorized(res);
      }
      const provided = String(req.headers[CSRF_HEADER_NAME] || '').trim();
      if (!provided || provided !== auth.session.csrfToken) {
        return forbidden(res, 'Invalid CSRF token');
      }
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const db = await readDb();
      const auth = await getCurrentAuthContext(req, db);
      return sendJson(res, 200, {
        user: auth?.user || null,
        csrfToken: auth?.session?.csrfToken || null
      });
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await parseJsonBody(req);
      const valErrors = validate(body, VALIDATION_SCHEMAS.login);
      if (valErrors) {
        return badRequest(res, 'Validation failed', valErrors);
      }

      const name = String(body.name).trim();
      const role = safeLower(body.role);

      const { user, createdUser } = await mutateDb((db) => {
        let user = findUserByNameAndRole(db, name, role);
        let createdUser = false;
        if (!user) {
          createdUser = true;
          user = {
            id: randomUUID(),
            name,
            role,
            createdAt: new Date().toISOString()
          };
          db.users.push(user);
        }
        return { user, createdUser };
      });

      const session = await sessionStore.create({
        userId: user.id,
        ttlSeconds: SESSION_TTL_SECONDS
      });

      await mutateDb((db) => {
        logAudit(db, {
          action: 'auth.login',
          targetType: 'session',
          targetId: session.id,
          user,
          req,
          meta: {
            createdUser,
            role: user.role
          }
        });
      });

      const cookie = buildCookie(SESSION_COOKIE_NAME, session.token, {
        maxAge: SESSION_TTL_SECONDS,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: SESSION_SECURE_COOKIE
      });

      return sendJson(
        res,
        200,
        {
          user: { id: user.id, name: user.name, role: user.role },
          csrfToken: session.csrfToken
        },
        {
          'Set-Cookie': cookie
        }
      );
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const authDb = await readDb();
      const auth = await getCurrentAuthContext(req, authDb);
      const token = auth?.session?.token || getSessionToken(req);
      if (token) {
        if (auth?.user) {
          await mutateDb((db) => {
            logAudit(db, {
              action: 'auth.logout',
              targetType: 'session',
              targetId: auth.session.id,
              user: auth.user,
              req
            });
          });
        }
        await sessionStore.delete(token);
      }

      const clearCookie = buildCookie(SESSION_COOKIE_NAME, '', {
        maxAge: 0,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: SESSION_SECURE_COOKIE
      });
      return sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': clearCookie
        }
      );
    }

    if (method === 'GET' && pathname === '/api/projects') {
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const projects = db.projects.filter((project) => canAccessProject(project, currentUser)).map((project) => projectSummary(project, db));
      return sendJson(res, 200, { projects });
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const authDb = await readDb();
      const currentUser = await getCurrentUserFromDb(req, authDb);
      if (!currentUser) {
        return unauthorized(res);
      }
      if (safeLower(currentUser.role) !== 'creator') {
        return forbidden(res, 'Only creator users can create projects');
      }

      const body = await parseJsonBody(req);
      const valErrors = validate(body, VALIDATION_SCHEMAS.createProject);
      if (valErrors) {
        return badRequest(res, 'Validation failed', valErrors);
      }

      const title = String(body.title).trim();
      const creatorName = String(body.creatorName).trim();
      const editorName = String(body.editorName).trim();

      if (normalizeName(creatorName) !== normalizeName(currentUser.name)) {
        return badRequest(res, 'creatorName must match logged-in creator');
      }

      const created = await mutateDb((db) => {
        const editorUser = findUserByNameAndRole(db, editorName, 'editor');
        const project = {
          id: randomUUID(),
          title,
          creatorName: currentUser.name,
          editorName,
          creatorUserId: currentUser.id,
          editorUserId: editorUser ? editorUser.id : null,
          status: 'draft',
          createdAt: new Date().toISOString()
        };
        db.projects.push(project);
        logAudit(db, {
          action: 'project.create',
          projectId: project.id,
          targetType: 'project',
          targetId: project.id,
          user: currentUser,
          req,
          meta: {
            title: project.title,
            editorName: project.editorName
          }
        });
        return { project: projectSummary(project, db) };
      });
      return sendJson(res, 201, created);
    }

    const projectContextMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/context$/i);
    if (method === 'GET' && projectContextMatch) {
      const projectId = projectContextMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      const assets = db.assets
        .filter((asset) => asset.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const briefInputs = db.briefInputs
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const briefs = db.briefs
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const voiceNotes = db.voiceNotes
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const comments = db.comments
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const checklistItems = db.checklistItems
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => {
          if (a.status === b.status) {
            return a.createdAt.localeCompare(b.createdAt);
          }
          return a.status === 'done' ? 1 : -1;
        });

      return sendJson(res, 200, {
        project: projectSummary(project, db),
        assets,
        briefInputs,
        briefs,
        voiceNotes,
        comments,
        checklistItems
      });
    }

    const jobStatusMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
    if (method === 'GET' && jobStatusMatch) {
      const jobId = jobStatusMatch[1];
      const job = await aiJobQueue.getJob(jobId);
      if (!job) {
        return notFound(res);
      }
      const state = await job.getState();
      const progress = job.progress;
      const result = job.returnvalue;
      const failedReason = job.failedReason;

      return sendJson(res, 200, {
        id: jobId,
        state,
        progress,
        result,
        failedReason
      });
    }

    const auditLogsMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/audit-logs$/i);
    if (method === 'GET' && auditLogsMatch) {
      const projectId = auditLogsMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }
      const limitRaw = Number(url.searchParams.get('limit') || 100);
      const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));
      const auditLogs = (Array.isArray(db.auditLogs) ? db.auditLogs : [])
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      return sendJson(res, 200, { auditLogs });
    }

    const projectUploadMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/upload$/i);
    if (method === 'POST' && projectUploadMatch) {
      const projectId = projectUploadMatch[1];
      const authDb = await readDb();
      const currentUser = await getCurrentUserFromDb(req, authDb);
      if (!currentUser) {
        return unauthorized(res);
      }
      const authProject = ensureProject(authDb, projectId);
      if (!authProject) {
        return notFound(res);
      }
      if (!canAccessProject(authProject, currentUser)) {
        return forbidden(res);
      }

      const contentType = req.headers['content-type'] || '';
      if (!contentType.startsWith('multipart/form-data')) {
        return badRequest(res, 'Expected multipart/form-data');
      }

      const { fields, file } = await parseMultipartBody(req, contentType);
      const versionLabel = safeLower(fields.versionLabel);

      if (!file) {
        return badRequest(res, 'No file found in upload');
      }
      if (!['raw', 'v1', 'v2'].includes(versionLabel)) {
        return badRequest(res, 'versionLabel must be one of raw, v1, v2');
      }
      if (versionLabel === 'raw' && safeLower(currentUser.role) !== 'creator') {
        return forbidden(res, 'Only creator can upload raw version');
      }
      if ((versionLabel === 'v1' || versionLabel === 'v2') && safeLower(currentUser.role) !== 'editor') {
        return forbidden(res, 'Only editor can upload v1/v2 versions');
      }

      const db = await readDb();
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }

      const stored = await objectStore.put({
        keyPrefix: `${projectId}_${versionLabel}`,
        originalName: file.originalName || 'upload.bin',
        buffer: file.buffer,
        mimeType: file.mimeType
      });

      const asset = {
        id: randomUUID(),
        projectId,
        versionLabel,
        originalName: file.originalName,
        mimeType: file.mimeType,
        sizeBytes: stored.sizeBytes,
        fileName: stored.fileName,
        url: stored.url,
        createdAt: new Date().toISOString()
      };

      await mutateDb((latestDb) => {
        const latestProject = ensureProject(latestDb, projectId);
        if (!latestProject) {
          return;
        }
        latestDb.assets.push(asset);
        if (versionLabel === 'v1') {
          latestProject.status = 'in_review';
        }
        if (versionLabel === 'v2') {
          latestProject.status = 'review_updated';
        }
        logAudit(latestDb, {
          action: 'asset.upload',
          projectId,
          targetType: 'asset',
          targetId: asset.id,
          user: currentUser,
          req,
          meta: {
            versionLabel,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes
          }
        });
      });
      return sendJson(res, 201, { asset });
    }

    const voiceNotesMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/voice-notes$/i);
    if (voiceNotesMatch) {
      const projectId = voiceNotesMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      if (method === 'GET') {
        const voiceNotes = db.voiceNotes
          .filter((item) => item.projectId === projectId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJson(res, 200, { voiceNotes });
      }

      if (method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.startsWith('multipart/form-data')) {
          return badRequest(res, 'Expected multipart/form-data');
        }

        const { fields, file } = await parseMultipartBody(req, contentType);
        const contextType = safeLower(fields.contextType || 'brief');
        const versionLabel = safeLower(fields.versionLabel || 'v1');
        const timestampSec = Number(fields.timestampSec || 0);

        if (!['brief', 'feedback'].includes(contextType)) {
          return badRequest(res, 'contextType must be brief or feedback');
        }
        if (contextType === 'feedback' && !['raw', 'v1', 'v2'].includes(versionLabel)) {
          return badRequest(res, 'versionLabel must be raw, v1, or v2 for feedback context');
        }
        if (!Number.isFinite(timestampSec) || timestampSec < 0) {
          return badRequest(res, 'timestampSec must be a non-negative number');
        }
        if (!file) {
          return badRequest(res, 'No audio file found in request');
        }

        const stored = await objectStore.put({
          keyPrefix: `${projectId}_voice`,
          originalName: file.originalName || 'voice-note.wav',
          buffer: file.buffer,
          mimeType: file.mimeType
        });

        const sttResult = await callOpenAITranscription({
          buffer: file.buffer,
          fileName: file.originalName || 'voice-note.wav',
          mimeType: file.mimeType
        });

        const transcript = sttResult.ok ? sttResult.text : fallbackVoiceTranscript(file.originalName, contextType);
        const sttMode = sttResult.ok ? 'openai' : 'fallback';
        const sttError = sttResult.ok ? '' : sttResult.error;

        const created = await mutateDb((latestDb) => {
          const latestProject = ensureProject(latestDb, projectId);
          if (!latestProject) {
            return { missingProject: true };
          }

          const voiceNote = {
            id: randomUUID(),
            projectId,
            contextType,
            versionLabel: contextType === 'feedback' ? versionLabel : null,
            timestampSec: contextType === 'feedback' ? timestampSec : null,
            uploaderUserId: currentUser.id,
            uploaderRole: currentUser.role,
            originalName: file.originalName,
            mimeType: file.mimeType,
            sizeBytes: stored.sizeBytes,
            fileName: stored.fileName,
            url: stored.url,
            transcript,
            sttMode,
            sttModel: sttResult.ok ? OPENAI_STT_MODEL : 'fallback',
            sttError: sttError || null,
            createdAt: new Date().toISOString()
          };
          latestDb.voiceNotes.push(voiceNote);

          let attached = null;
          if (contextType === 'brief') {
            attached = {
              type: 'briefInput',
              value: {
                id: randomUUID(),
                projectId,
                inputType: 'voice',
                content: transcript,
                createdBy: safeLower(currentUser.role),
                voiceNoteId: voiceNote.id,
                createdAt: new Date().toISOString()
              }
            };
            latestDb.briefInputs.push(attached.value);
            latestProject.status = 'brief_pending_ai';
          } else {
            attached = {
              type: 'comment',
              value: {
                id: randomUUID(),
                projectId,
                versionLabel,
                timestampSec,
                text: transcript,
                source: 'voice',
                authorRole: safeLower(currentUser.role),
                voiceNoteId: voiceNote.id,
                createdAt: new Date().toISOString()
              }
            };
            latestDb.comments.push(attached.value);
            latestProject.status = 'feedback_added';
          }

          logAiRun(
            latestDb,
            projectId,
            'voice_transcription',
            { voiceNoteId: voiceNote.id, contextType },
            { sttMode, attachedType: attached.type },
            sttResult.ok ? 'success' : 'fallback',
            sttError ? { providerError: sttError } : {}
          );
          logAudit(latestDb, {
            action: 'voice_note.upload',
            projectId,
            targetType: 'voice_note',
            targetId: voiceNote.id,
            user: currentUser,
            req,
            result: sttResult.ok ? 'success' : 'fallback',
            meta: {
              contextType,
              attachedType: attached.type,
              sttMode
            }
          });

          return { voiceNote, attached };
        });

        if (created.missingProject) {
          return notFound(res);
        }

        return sendJson(res, 201, {
          ...created,
          note: sttResult.ok
            ? `Transcribed using OpenAI STT model ${OPENAI_STT_MODEL}.`
            : `STT unavailable (${sttError || 'unknown_reason'}); fallback transcript applied.`
        });
      }
    }

    const briefInputMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/brief-inputs$/i);
    if (briefInputMatch) {
      const projectId = briefInputMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      if (method === 'GET') {
        const briefInputs = db.briefInputs
          .filter((item) => item.projectId === projectId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return sendJson(res, 200, { briefInputs });
      }

      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const valErrors = validate(body, VALIDATION_SCHEMAS.createBriefInput);
        if (valErrors) {
          return badRequest(res, 'Validation failed', valErrors);
        }

        const inputType = safeLower(body.inputType);
        const content = String(body.content).trim();
        const createdBy = safeLower(currentUser.role);

        const created = await mutateDb((latestDb) => {
          const latestProject = ensureProject(latestDb, projectId);
          if (!latestProject) {
            return { missingProject: true };
          }

          const briefInput = {
            id: randomUUID(),
            projectId,
            inputType,
            content,
            createdBy,
            createdAt: new Date().toISOString()
          };

          latestDb.briefInputs.push(briefInput);
          latestProject.status = 'brief_pending_ai';
          logAudit(latestDb, {
            action: 'brief_input.create',
            projectId,
            targetType: 'brief_input',
            targetId: briefInput.id,
            user: currentUser,
            req,
            meta: {
              inputType: briefInput.inputType
            }
          });
          return { briefInput };
        });
        if (created.missingProject) {
          return notFound(res);
        }
        return sendJson(res, 201, created);
      }
    }

    const aiBriefMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/ai\/brief$/i);
    if (method === 'POST' && aiBriefMatch) {
      const projectId = aiBriefMatch[1];
      const body = await parseJsonBody(req);
      const inlineText = String(body.text || '').trim();
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      const projectInputs = db.briefInputs
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      const mergedText = [
        ...projectInputs.map((item) => `[${item.inputType}] ${item.content}`),
        inlineText ? `[text] ${inlineText}` : ''
      ]
        .filter(Boolean)
        .join(' | ');

      if (!mergedText) {
        return badRequest(res, 'No brief input available. Add brief input first.');
      }

      if (ENABLE_ASYNC_JOBS) {
        const job = await aiJobQueue.add('generate-brief', {
          projectId,
          mergedText,
          projectInputIds: projectInputs.map((item) => item.id),
          currentUser
        });
        return sendJson(res, 202, {
          jobId: job.id,
          status: 'queued',
          note: 'Brief generation task has been offloaded to background worker.'
        });
      }

      let briefData = inferBriefFromText(mergedText);
      let mode = 'heuristic';
      let providerError = '';

      const modelResult = await callOpenAIJson({
        schemaName: 'creator_editor_brief',
        schema: BRIEF_JSON_SCHEMA,
        systemPrompt:
          'You generate structured short-video editing briefs from unstructured creator/editor inputs. Respond with strict JSON only.',
        userPrompt: `Brief inputs:\n${mergedText}`
      });

      if (modelResult.ok) {
        const normalized = normalizeBriefFromModel(modelResult.data, mergedText);
        if (normalized) {
          briefData = normalized;
          mode = 'openai';
        } else {
          providerError = 'openai_shape_validation_failed';
        }
      } else {
        providerError = modelResult.error;
      }

      const generated = await mutateDb((mutableDb) => {
        const mutableProject = ensureProject(mutableDb, projectId);
        if (!mutableProject) {
          return { missingProject: true };
        }

        const brief = {
          id: randomUUID(),
          projectId,
          sourceInputIds: projectInputs.map((item) => item.id),
          brief: {
            ...briefData,
            source_input: mergedText
          },
          model: mode === 'openai' ? OPENAI_MODEL : 'heuristic',
          createdAt: new Date().toISOString()
        };

        mutableDb.briefs.push(brief);
        mutableProject.status = 'brief_ready';
        logAiRun(
          mutableDb,
          projectId,
          'brief_generation',
          { inputCount: projectInputs.length, mode },
          { briefId: brief.id },
          'success',
          providerError ? { providerError } : {}
        );
        logAudit(mutableDb, {
          action: 'ai.brief.generate',
          projectId,
          targetType: 'brief',
          targetId: brief.id,
          user: currentUser,
          req,
          result: mode === 'openai' ? 'success' : 'fallback',
          meta: {
            mode,
            inputCount: projectInputs.length,
            providerError: providerError || null
          }
        });
        return { brief };
      });

      if (generated.missingProject) {
        return notFound(res);
      }

      return sendJson(res, 200, {
        ...generated,
        note:
          mode === 'openai'
            ? `Generated using OpenAI model ${OPENAI_MODEL}.`
            : `OpenAI unavailable (${providerError || 'unknown_reason'}); used heuristic fallback.`
      });
    }

    const latestBriefMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/brief\/latest$/i);
    if (method === 'GET' && latestBriefMatch) {
      const projectId = latestBriefMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      const brief = db.briefs
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;

      return sendJson(res, 200, { brief });
    }

    const commentsMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/comments$/i);
    if (commentsMatch) {
      const projectId = commentsMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      if (method === 'GET') {
        const comments = db.comments
          .filter((item) => item.projectId === projectId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJson(res, 200, { comments });
      }

      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const text = String(body.text || '').trim();
        const authorRole = safeLower(currentUser.role);
        const source = safeLower(body.source || 'text');
        const timestampSec = Number(body.timestampSec);
        const versionLabel = safeLower(body.versionLabel || 'v1');

        if (!text) {
          return badRequest(res, 'text is required');
        }
        if (!['text', 'voice'].includes(source)) {
          return badRequest(res, 'source must be text or voice');
        }
        if (!Number.isFinite(timestampSec) || timestampSec < 0) {
          return badRequest(res, 'timestampSec must be a non-negative number');
        }
        if (!['raw', 'v1', 'v2'].includes(versionLabel)) {
          return badRequest(res, 'versionLabel must be raw, v1, or v2');
        }

        const created = await mutateDb((latestDb) => {
          const latestProject = ensureProject(latestDb, projectId);
          if (!latestProject) {
            return { missingProject: true };
          }

          const comment = {
            id: randomUUID(),
            projectId,
            versionLabel,
            timestampSec,
            text,
            source,
            authorRole,
            createdAt: new Date().toISOString()
          };

          latestDb.comments.push(comment);
          latestProject.status = 'feedback_added';
          logAudit(latestDb, {
            action: 'comment.create',
            projectId,
            targetType: 'comment',
            targetId: comment.id,
            user: currentUser,
            req,
            meta: {
              source,
              versionLabel,
              timestampSec
            }
          });
          return { comment };
        });

        if (created.missingProject) {
          return notFound(res);
        }
        return sendJson(res, 201, created);
      }
    }

    const aiChecklistMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/ai\/checklist$/i);
    if (method === 'POST' && aiChecklistMatch) {
      const projectId = aiChecklistMatch[1];
      const body = await parseJsonBody(req);
      const externalFeedback = Array.isArray(body.feedback) ? body.feedback : [];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      const commentsFromDb = db.comments.filter((item) => item.projectId === projectId);
      const normalizedExternal = externalFeedback
        .map((item) => {
          const text = String(item.note || item.text || '').trim();
          const timestampSec = Number(item.timestamp ?? item.timestampSec ?? 0);
          if (!text || !Number.isFinite(timestampSec) || timestampSec < 0) {
            return null;
          }
          return {
            id: `external-${randomUUID()}`,
            projectId,
            text,
            timestampSec,
            createdAt: new Date().toISOString(),
            source: 'text',
            authorRole: 'creator',
            versionLabel: 'v1'
          };
        })
        .filter(Boolean);

      const sourceComments = [...commentsFromDb, ...normalizedExternal]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50);

      if (!sourceComments.length) {
        return badRequest(res, 'No feedback available to generate checklist.');
      }

      if (ENABLE_ASYNC_JOBS) {
        const job = await aiJobQueue.add('generate-checklist', {
          projectId,
          sourceComments
        });
        return sendJson(res, 202, {
          jobId: job.id,
          status: 'queued',
          note: 'Checklist generation task has been offloaded to background worker.'
        });
      }

      let candidateItems = heuristicChecklistCandidates(sourceComments);
      let mode = 'heuristic';
      let providerError = '';

      const compactFeedback = sourceComments.map((item) => ({
        timestampSec: item.timestampSec,
        text: item.text,
        source: item.source,
        authorRole: item.authorRole,
        versionLabel: item.versionLabel
      }));

      const modelResult = await callOpenAIJson({
        schemaName: 'creator_editor_checklist',
        schema: CHECKLIST_JSON_SCHEMA,
        systemPrompt:
          'You are an assistant that converts review feedback into an actionable revision checklist for a video editor. Return strict JSON only.',
        userPrompt: `Feedback items (JSON):\n${JSON.stringify(compactFeedback)}`
      });

      if (modelResult.ok) {
        const normalized = normalizeChecklistCandidates(modelResult.data?.items);
        if (normalized.length > 0) {
          candidateItems = normalized.map((item) => ({
            ...item,
            sourceCommentId: closestCommentIdByTimestamp(sourceComments, item.timestampSec)
          }));
          mode = 'openai';
        } else {
          providerError = 'openai_shape_validation_failed';
        }
      } else {
        providerError = modelResult.error;
      }

      const generated = await mutateDb((mutableDb) => {
        const mutableProject = ensureProject(mutableDb, projectId);
        if (!mutableProject) {
          return { missingProject: true };
        }

        const generationId = randomUUID();
        const generatedItems = candidateItems.map((item) => ({
          id: randomUUID(),
          projectId,
          generationId,
          priority: pickPriority(item.priority),
          title: item.title,
          details: item.details,
          owner: 'editor',
          timestampSec: Math.max(0, Number(item.timestampSec) || 0),
          sourceCommentId: item.sourceCommentId || closestCommentIdByTimestamp(sourceComments, Number(item.timestampSec) || 0),
          status: 'todo',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }));

        mutableDb.checklistItems.push(...generatedItems);
        mutableProject.status = 'changes_requested';
        logAiRun(
          mutableDb,
          projectId,
          'checklist_generation',
          { commentCount: sourceComments.length, mode },
          { itemCount: generatedItems.length },
          'success',
          providerError ? { providerError } : {}
        );
        logAudit(mutableDb, {
          action: 'ai.checklist.generate',
          projectId,
          targetType: 'checklist_generation',
          targetId: generationId,
          user: currentUser,
          req,
          result: mode === 'openai' ? 'success' : 'fallback',
          meta: {
            mode,
            sourceCommentCount: sourceComments.length,
            generatedItemCount: generatedItems.length,
            providerError: providerError || null
          }
        });

        return {
          checklist: {
            projectId,
            generationId,
            generatedAt: new Date().toISOString(),
            items: generatedItems
          }
        };
      });

      if (generated.missingProject) {
        return notFound(res);
      }

      return sendJson(res, 200, {
        ...generated,
        note:
          mode === 'openai'
            ? `Generated using OpenAI model ${OPENAI_MODEL}.`
            : `OpenAI unavailable (${providerError || 'unknown_reason'}); used heuristic fallback.`
      });
    }

    const checklistListMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/checklist$/i);
    if (method === 'GET' && checklistListMatch) {
      const projectId = checklistListMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      const items = db.checklistItems
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => {
          if (a.status === b.status) {
            return a.createdAt.localeCompare(b.createdAt);
          }
          return a.status === 'done' ? 1 : -1;
        });

      return sendJson(res, 200, { items });
    }

    const checklistUpdateMatch = pathname.match(/^\/api\/checklist\/([a-f0-9-]+)$/i);
    if (method === 'PATCH' && checklistUpdateMatch) {
      const itemId = checklistUpdateMatch[1];
      const body = await parseJsonBody(req);
      const status = safeLower(body.status);
      const authDb = await readDb();
      const currentUser = await getCurrentUserFromDb(req, authDb);
      if (!currentUser) {
        return unauthorized(res);
      }

      if (!['todo', 'in_progress', 'done'].includes(status)) {
        return badRequest(res, 'status must be todo, in_progress, or done');
      }
      if (safeLower(currentUser.role) !== 'editor') {
        return forbidden(res, 'Only editor can update checklist item status');
      }

      const authItem = authDb.checklistItems.find((entry) => entry.id === itemId);
      if (!authItem) {
        return notFound(res);
      }
      const authProject = ensureProject(authDb, authItem.projectId);
      if (!authProject) {
        return notFound(res);
      }
      if (!canAccessProject(authProject, currentUser)) {
        return forbidden(res);
      }

      const updated = await mutateDb((db) => {
        const item = db.checklistItems.find((entry) => entry.id === itemId);
        if (!item) {
          return { missingItem: true };
        }

        const previousStatus = item.status;
        item.status = status;
        item.updatedAt = new Date().toISOString();
        updateProjectStatusFromChecklist(item.projectId, db);
        logAudit(db, {
          action: 'checklist.status.update',
          projectId: item.projectId,
          targetType: 'checklist_item',
          targetId: item.id,
          user: currentUser,
          req,
          meta: {
            previousStatus,
            nextStatus: status
          }
        });
        return { item };
      });
      if (updated.missingItem) {
        return notFound(res);
      }
      return sendJson(res, 200, updated);
    }

    const versionSummaryMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/ai\/version-summary$/i);
    if (method === 'POST' && versionSummaryMatch) {
      const projectId = versionSummaryMatch[1];
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }

      const assets = db.assets.filter((asset) => asset.projectId === projectId);
      const v1 = latestAssetByVersion(assets, 'v1');
      const v2 = latestAssetByVersion(assets, 'v2');
      if (!v1 || !v2) {
        return badRequest(res, 'Need both v1 and v2 assets before generating version summary.');
      }

      const checklistItems = db.checklistItems.filter((item) => item.projectId === projectId);
      const done = checklistItems.filter((item) => item.status === 'done');
      const pending = checklistItems.filter((item) => item.status !== 'done');
      const pendingP0 = pending.filter((item) => item.priority === 'P0').length;

      let fallbackScore = Math.round(40 + (done.length / Math.max(1, checklistItems.length)) * 60);
      if (pendingP0 > 0) {
        fallbackScore = Math.max(20, fallbackScore - pendingP0 * 20);
      }

      if (ENABLE_ASYNC_JOBS) {
        const job = await aiJobQueue.add('generate-summary', {
          projectId,
          projectTitle: project.title,
          v1Name: v1.originalName,
          v2Name: v2.originalName,
          completedChecklistItems: done.map((item) => item.title),
          pendingChecklistItems: pending.map((item) => item.title),
          totalChecklistItems: checklistItems.length,
          v1Url: v1.url,
          v2Url: v2.url,
          v1Id: v1.id,
          v2Id: v2.id
        });
        return sendJson(res, 202, {
          jobId: job.id,
          status: 'queued',
          note: 'Version summary generation task has been offloaded to background worker.'
        });
      }

      let summaryBody = {
        improvements: done.map((item) => item.title).slice(0, 5),
        remaining_issues: pending.map((item) => item.title).slice(0, 5),
        publish_readiness_score: fallbackScore
      };
      let mode = 'heuristic';
      let providerError = '';

      const modelResult = await callOpenAIJson({
        schemaName: 'creator_editor_version_summary',
        schema: SUMMARY_JSON_SCHEMA,
        systemPrompt:
          'You summarize editing progress between V1 and V2 based on checklist completion and known issues. Return strict JSON only.',
        userPrompt: JSON.stringify(
          {
            projectTitle: project.title,
            v1Name: v1.originalName,
            v2Name: v2.originalName,
            completedChecklistItems: done.map((item) => item.title),
            pendingChecklistItems: pending.map((item) => item.title),
            totalChecklistItems: checklistItems.length
          },
          null,
          2
        )
      });

      if (modelResult.ok) {
        const normalized = normalizeSummaryFromModel(modelResult.data);
        if (normalized) {
          summaryBody = normalized;
          mode = 'openai';
        } else {
          providerError = 'openai_shape_validation_failed';
        }
      } else {
        providerError = modelResult.error;
      }

      const generated = await mutateDb((mutableDb) => {
        const mutableProject = ensureProject(mutableDb, projectId);
        if (!mutableProject) {
          return { missingProject: true };
        }

        const summary = {
          projectId,
          comparedVersions: { from: v1.url, to: v2.url },
          generatedAt: new Date().toISOString(),
          ...summaryBody
        };

        logAiRun(
          mutableDb,
          projectId,
          'version_summary',
          { v1: v1.id, v2: v2.id, mode },
          summary,
          'success',
          providerError ? { providerError } : {}
        );
        logAudit(mutableDb, {
          action: 'ai.version_summary.generate',
          projectId,
          targetType: 'project',
          targetId: projectId,
          user: currentUser,
          req,
          result: mode === 'openai' ? 'success' : 'fallback',
          meta: {
            mode,
            providerError: providerError || null
          }
        });
        return { summary };
      });

      if (generated.missingProject) {
        return notFound(res);
      }

      return sendJson(res, 200, {
        ...generated,
        note:
          mode === 'openai'
            ? `Generated using OpenAI model ${OPENAI_MODEL}.`
            : `OpenAI unavailable (${providerError || 'unknown_reason'}); used heuristic fallback.`
      });
    }

    if (method === 'GET' && pathname.startsWith('/uploads/')) {
      const rel = pathname.replace('/uploads/', '');
      const safe = path.basename(rel);
      const db = await readDb();
      const currentUser = await getCurrentUserFromDb(req, db);
      if (!currentUser) {
        return unauthorized(res);
      }
      const projectId = extractProjectIdFromAssetFileName(safe);
      if (!projectId) {
        return forbidden(res, 'Invalid asset reference');
      }
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }
      if (!canAccessProject(project, currentUser)) {
        return forbidden(res);
      }
      try {
        const { data, contentType } = await objectStore.get({ fileName: safe });
        return serveBuffer(res, data, safe, contentType);
      } catch (err) {
        return notFound(res);
      }
    }

    if (method === 'GET' && pathname === '/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    if (method === 'GET' && pathname.startsWith('/public/')) {
      const rel = pathname.replace('/public/', '');
      const safe = path.normalize(rel).replace(/^\.\.[/\\]/, '');
      return serveStaticFile(res, path.join(PUBLIC_DIR, safe));
    }

    return notFound(res);
  } catch (error) {
    console.error('Unhandled server error:', error);
    return sendError(
      res,
      500,
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred on the server',
      process.env.NODE_ENV === 'development' ? { message: error.message, stack: error.stack } : null
    );
  }
});

ensureStorage()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Server running at http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize storage', error);
    process.exit(1);
  });

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await aiJobQueue.close();
      console.log('Job queue connection closed.');
      if (typeof stateStore.close === 'function') {
        await stateStore.close();
        console.log('State store connection closed.');
      }
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });

  // Force close after 10s
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
