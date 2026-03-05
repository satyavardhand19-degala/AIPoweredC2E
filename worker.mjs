import { createWorker } from './lib/queue.mjs';
import { createStateStore } from './lib/state_store.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DATA_JSON_FILE = path.join(DATA_DIR, 'db.json');
const DATA_SQLITE_FILE = path.join(DATA_DIR, 'app_state.db');
const DATA_BACKEND = process.env.DATA_BACKEND || (process.env.NODE_ENV === 'production' ? 'postgres' : 'sqlite');
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

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

const stateStore = createStateStore({
  backend: DATA_BACKEND,
  jsonFilePath: DATA_JSON_FILE,
  sqliteFilePath: DATA_SQLITE_FILE,
  postgresConfig: POSTGRES_CONFIG
});

async function readDb() {
  return stateStore.read();
}

async function writeDb(db) {
  await stateStore.write(db);
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

// Helpers
function safeLower(value) { return String(value || '').trim().toLowerCase(); }
function pickPriority(value) {
  const p = String(value || '').toUpperCase();
  return ['P0', 'P1', 'P2'].includes(p) ? p : 'P2';
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function parseDurationHint(text) {
  const normalized = text.toLowerCase();
  const under = normalized.match(/under\s*(\d{1,3})\s*(s|sec|seconds)?/i);
  if (under) return Number(under[1]);
  const generic = normalized.match(/(\d{1,3})\s*(s|sec|seconds)/i);
  return generic ? Number(generic[1]) : 30;
}

function extractResponsesOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload?.output)) return '';
  const chunks = [];
  for (const outputItem of payload.output) {
    if (!Array.isArray(outputItem?.content)) continue;
    for (const contentItem of outputItem.content) {
      if (contentItem?.type === 'output_text' && typeof contentItem?.text === 'string') {
        chunks.push(contentItem.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

async function callAIJson({ schemaName, schema, systemPrompt, userPrompt }) {
  const isGroq = AI_PROVIDER === 'groq';
  const apiKey = isGroq ? GROQ_API_KEY : OPENAI_API_KEY;
  const model = isGroq ? GROQ_MODEL : OPENAI_MODEL;
  const baseUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/responses';

  if (!apiKey) return { ok: false, error: 'missing_api_key' };
  try {
    const body = isGroq ? {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    } : {
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
      ],
      text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } }
    };

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    if (!response.ok) return { ok: false, error: `${AI_PROVIDER}_http_${response.status}` };
    const payload = await response.json();

    let rawText = '';
    if (isGroq) {
      rawText = payload.choices?.[0]?.message?.content || '';
    } else {
      rawText = extractResponsesOutputText(payload);
    }

    if (!rawText) return { ok: false, error: 'empty_output' };
    try {
      return { ok: true, data: JSON.parse(rawText) };
    } catch {
      return { ok: false, error: 'invalid_json_output' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : `${AI_PROVIDER}_request_failed` };
  }
}

function normalizeChecklistCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  const dedup = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const title = String(candidate.title || '').trim();
    if (!title) continue;
    const timestampSec = Math.max(0, Number(candidate.timestampSec ?? candidate.timestamp ?? 0) || 0);
    const key = `${title.toLowerCase()}|${Math.floor(timestampSec / 3)}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    out.push({
      priority: pickPriority(candidate.priority),
      title,
      details: String(candidate.details || title).trim(),
      owner: 'editor',
      timestampSec
    });
  }
  return out.slice(0, 30);
}

function closestCommentIdByTimestamp(comments, timestampSec) {
  if (!comments.length) return null;
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

// AI Task Processors
async function processBriefGeneration(job) {
  const { projectId, mergedText, projectInputIds } = job.data;
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

  const modelResult = await callAIJson({
    schemaName: 'creator_editor_brief',
    schema: BRIEF_JSON_SCHEMA,
    systemPrompt: 'You generate structured short-video editing briefs from unstructured creator/editor inputs. Respond with strict JSON only.',
    userPrompt: `Brief inputs:\n${mergedText}`
  });

  if (!modelResult.ok) throw new Error(modelResult.error);

  const candidate = modelResult.data;
  const briefData = {
    hook_style: String(candidate.hook_style || '').trim(),
    tone: String(candidate.tone || '').trim(),
    target_duration_sec: clampNumber(candidate.target_duration_sec, 5, 180, parseDurationHint(mergedText)),
    caption_style: String(candidate.caption_style || '').trim(),
    music_vibe: String(candidate.music_vibe || '').trim(),
    cta_type: String(candidate.cta_type || '').trim(),
    dos: Array.isArray(candidate.dos) ? candidate.dos.map(s => String(s || '').trim()).filter(Boolean) : [],
    donts: Array.isArray(candidate.donts) ? candidate.donts.map(s => String(s || '').trim()).filter(Boolean) : []
  };

  await mutateDb((db) => {
    const brief = {
      id: randomUUID(),
      projectId,
      sourceInputIds: projectInputIds,
      brief: { ...briefData, source_input: mergedText },
      model: AI_PROVIDER === 'groq' ? GROQ_MODEL : OPENAI_MODEL,
      createdAt: new Date().toISOString()
    };
    db.briefs.push(brief);
    const p = db.projects.find(p => p.id === projectId);
    if (p) p.status = 'brief_ready';

    db.aiRuns.push({
      id: randomUUID(),
      projectId,
      taskType: 'brief_generation_async',
      status: 'success',
      briefId: brief.id,
      createdAt: new Date().toISOString()
    });
  });

  return { ok: true, type: 'brief' };
}

async function processChecklistGeneration(job) {
  const { projectId, sourceComments } = job.data;
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

  const compactFeedback = sourceComments.map(item => ({
    timestampSec: item.timestampSec,
    text: item.text,
    source: item.source,
    authorRole: item.authorRole,
    versionLabel: item.versionLabel
  }));

  const modelResult = await callAIJson({
    schemaName: 'creator_editor_checklist',
    schema: CHECKLIST_JSON_SCHEMA,
    systemPrompt: 'You are an assistant that converts review feedback into an actionable revision checklist for a video editor. Return strict JSON only.',
    userPrompt: `Feedback items (JSON):\n${JSON.stringify(compactFeedback)}`
  });

  if (!modelResult.ok) throw new Error(modelResult.error);

  const candidates = normalizeChecklistCandidates(modelResult.data?.items);
  if (candidates.length === 0) throw new Error('no_items_generated');

  await mutateDb((db) => {
    const generationId = randomUUID();
    const generatedItems = candidates.map(item => ({
      id: randomUUID(),
      projectId,
      generationId,
      priority: item.priority,
      title: item.title,
      details: item.details,
      owner: 'editor',
      timestampSec: item.timestampSec,
      sourceCommentId: closestCommentIdByTimestamp(sourceComments, item.timestampSec),
      status: 'todo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));

    db.checklistItems.push(...generatedItems);
    const p = db.projects.find(p => p.id === projectId);
    if (p) p.status = 'changes_requested';

    db.aiRuns.push({
      id: randomUUID(),
      projectId,
      taskType: 'checklist_generation_async',
      status: 'success',
      itemCount: generatedItems.length,
      createdAt: new Date().toISOString()
    });
  });

  return { ok: true, type: 'checklist' };
}

async function processSummaryGeneration(job) {
  const { projectId, projectTitle, v1Name, v2Name, completedChecklistItems, pendingChecklistItems, totalChecklistItems, v1Url, v2Url, v1Id, v2Id } = job.data;
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

  const modelResult = await callAIJson({
    schemaName: 'creator_editor_version_summary',
    schema: SUMMARY_JSON_SCHEMA,
    systemPrompt: 'You summarize editing progress between V1 and V2 based on checklist completion and known issues. Return strict JSON only.',
    userPrompt: JSON.stringify({
      projectTitle, v1Name, v2Name, completedChecklistItems, pendingChecklistItems, totalChecklistItems
    })
  });

  if (!modelResult.ok) throw new Error(modelResult.error);

  const summaryBody = {
    improvements: Array.isArray(modelResult.data.improvements) ? modelResult.data.improvements.map(s => String(s).trim()).filter(Boolean) : [],
    remaining_issues: Array.isArray(modelResult.data.remaining_issues) ? modelResult.data.remaining_issues.map(s => String(s).trim()).filter(Boolean) : [],
    publish_readiness_score: clampNumber(modelResult.data.publish_readiness_score, 0, 100, 50)
  };

  await mutateDb((db) => {
    const summary = {
      projectId,
      comparedVersions: { from: v1Url, to: v2Url },
      generatedAt: new Date().toISOString(),
      ...summaryBody
    };
    // Note: summary is not currently its own collection, it is logged in aiRuns or as part of project context
    // In server.mjs it was returned directly. For async, we log it in aiRuns results.
    db.aiRuns.push({
      id: randomUUID(),
      projectId,
      taskType: 'version_summary_async',
      status: 'success',
      v1: v1Id,
      v2: v2Id,
      result: summary,
      createdAt: new Date().toISOString()
    });
  });

  return { ok: true, type: 'summary' };
}

const worker = createWorker('ai-tasks', async (job) => {
  console.log(`Processing job ${job.id} of type ${job.name}`);
  if (job.name === 'generate-brief') {
    return processBriefGeneration(job);
  }
  if (job.name === 'generate-checklist') {
    return processChecklistGeneration(job);
  }
  if (job.name === 'generate-summary') {
    return processSummaryGeneration(job);
  }
  throw new Error(`Unknown job type: ${job.name}`);
});

console.log('Worker started, listening for jobs...');
stateStore.init().then(() => console.log('State store initialized in worker'));

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down worker gracefully...`);
  try {
    await worker.close();
    console.log('BullMQ worker closed.');
    if (typeof stateStore.close === 'function') {
      await stateStore.close();
      console.log('State store connection closed.');
    }
    process.exit(0);
  } catch (err) {
    console.error('Error during worker shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
