import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

function emptyDb() {
  return {
    projects: [],
    assets: [],
    briefInputs: [],
    briefs: [],
    comments: [],
    checklistItems: [],
    aiRuns: []
  };
}

function normalizeDb(db) {
  const base = emptyDb();
  return {
    ...base,
    ...db,
    projects: Array.isArray(db.projects) ? db.projects : [],
    assets: Array.isArray(db.assets) ? db.assets : [],
    briefInputs: Array.isArray(db.briefInputs) ? db.briefInputs : [],
    briefs: Array.isArray(db.briefs) ? db.briefs : [],
    comments: Array.isArray(db.comments) ? db.comments : [],
    checklistItems: Array.isArray(db.checklistItems) ? db.checklistItems : [],
    aiRuns: Array.isArray(db.aiRuns) ? db.aiRuns : []
  };
}

async function ensureStorage() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });

  try {
    await stat(DB_FILE);
  } catch {
    await writeFile(DB_FILE, JSON.stringify(emptyDb(), null, 2), 'utf8');
  }
}

async function readDb() {
  const raw = await readFile(DB_FILE, 'utf8');
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(normalizeDb(db), null, 2), 'utf8');
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeLower(value) {
  return String(value || '').trim().toLowerCase();
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
      return { ok: false, error: `openai_http_${response.status}` };
    }

    const payload = await response.json();
    const rawText = extractResponsesOutputText(payload);
    if (!rawText) {
      return { ok: false, error: 'empty_output' };
    }

    try {
      const data = JSON.parse(rawText);
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'invalid_json_output' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'openai_request_failed' };
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

async function serveStaticFile(res, fsPath) {
  try {
    const data = await readFile(fsPath);
    const ext = path.extname(fsPath).toLowerCase();

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

    const contentType = mimeMap[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length
    });
    res.end(data);
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

const server = createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (method === 'GET' && pathname === '/api/projects') {
      const db = await readDb();
      const projects = db.projects.map((project) => projectSummary(project, db));
      return sendJson(res, 200, { projects });
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const body = await parseJsonBody(req);
      const title = String(body.title || '').trim();
      const creatorName = String(body.creatorName || '').trim();
      const editorName = String(body.editorName || '').trim();

      if (!title || !creatorName || !editorName) {
        return badRequest(res, 'title, creatorName, and editorName are required');
      }

      const created = await mutateDb((db) => {
        const project = {
          id: randomUUID(),
          title,
          creatorName,
          editorName,
          status: 'draft',
          createdAt: new Date().toISOString()
        };
        db.projects.push(project);
        return { project: projectSummary(project, db) };
      });
      return sendJson(res, 201, created);
    }

    const projectContextMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/context$/i);
    if (method === 'GET' && projectContextMatch) {
      const projectId = projectContextMatch[1];
      const db = await readDb();
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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
        comments,
        checklistItems
      });
    }

    const projectUploadMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/upload$/i);
    if (method === 'POST' && projectUploadMatch) {
      const projectId = projectUploadMatch[1];
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

      const db = await readDb();
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }

      const safeOriginal = sanitizeFilename(file.originalName || 'upload.bin');
      const storedName = `${projectId}_${versionLabel}_${Date.now()}_${safeOriginal}`;
      const filePath = path.join(UPLOAD_DIR, storedName);
      await writeFile(filePath, file.buffer);

      const asset = {
        id: randomUUID(),
        projectId,
        versionLabel,
        originalName: file.originalName,
        mimeType: file.mimeType,
        sizeBytes: file.buffer.length,
        fileName: storedName,
        url: `/uploads/${storedName}`,
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
      });
      return sendJson(res, 201, { asset });
    }

    const briefInputMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/brief-inputs$/i);
    if (briefInputMatch) {
      const projectId = briefInputMatch[1];
      const db = await readDb();
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
      }

      if (method === 'GET') {
        const briefInputs = db.briefInputs
          .filter((item) => item.projectId === projectId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return sendJson(res, 200, { briefInputs });
      }

      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const inputType = safeLower(body.inputType);
        const content = String(body.content || '').trim();
        const createdBy = safeLower(body.createdBy || 'creator');

        if (!['text', 'voice', 'url'].includes(inputType)) {
          return badRequest(res, 'inputType must be one of text, voice, url');
        }
        if (!content) {
          return badRequest(res, 'content is required');
        }
        if (!['creator', 'editor'].includes(createdBy)) {
          return badRequest(res, 'createdBy must be creator or editor');
        }

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
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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
        const authorRole = safeLower(body.authorRole || 'creator');
        const source = safeLower(body.source || 'text');
        const timestampSec = Number(body.timestampSec);
        const versionLabel = safeLower(body.versionLabel || 'v1');

        if (!text) {
          return badRequest(res, 'text is required');
        }
        if (!['creator', 'editor'].includes(authorRole)) {
          return badRequest(res, 'authorRole must be creator or editor');
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
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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

      if (!['todo', 'in_progress', 'done'].includes(status)) {
        return badRequest(res, 'status must be todo, in_progress, or done');
      }

      const updated = await mutateDb((db) => {
        const item = db.checklistItems.find((entry) => entry.id === itemId);
        if (!item) {
          return { missingItem: true };
        }

        item.status = status;
        item.updatedAt = new Date().toISOString();
        updateProjectStatusFromChecklist(item.projectId, db);
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
      const project = ensureProject(db, projectId);
      if (!project) {
        return notFound(res);
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
      return serveStaticFile(res, path.join(UPLOAD_DIR, safe));
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
    return sendJson(res, 500, {
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
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
