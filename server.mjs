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

async function ensureStorage() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });

  try {
    await stat(DB_FILE);
  } catch {
    const initial = {
      projects: [],
      assets: [],
      comments: [],
      briefs: [],
      checklistItems: [],
      aiRuns: []
    };
    await writeFile(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

async function readDb() {
  const raw = await readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, payload, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
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
      '.webm': 'video/webm'
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

function withAssets(project, db) {
  return {
    ...project,
    assets: db.assets.filter((asset) => asset.projectId === project.id)
  };
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
      const projects = db.projects.map((project) => withAssets(project, db));
      return sendJson(res, 200, { projects });
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const body = await parseJsonBody(req);
      const title = (body.title || '').trim();
      const creatorName = (body.creatorName || '').trim();
      const editorName = (body.editorName || '').trim();

      if (!title || !creatorName || !editorName) {
        return badRequest(res, 'title, creatorName, and editorName are required');
      }

      const db = await readDb();
      const project = {
        id: randomUUID(),
        title,
        creatorName,
        editorName,
        status: 'draft',
        createdAt: new Date().toISOString()
      };

      db.projects.push(project);
      await writeDb(db);

      return sendJson(res, 201, { project: withAssets(project, db) });
    }

    const projectUploadMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/upload$/i);
    if (method === 'POST' && projectUploadMatch) {
      const projectId = projectUploadMatch[1];
      const contentType = req.headers['content-type'] || '';
      if (!contentType.startsWith('multipart/form-data')) {
        return badRequest(res, 'Expected multipart/form-data');
      }

      const { fields, file } = await parseMultipartBody(req, contentType);
      const versionLabel = (fields.versionLabel || '').toLowerCase();

      if (!file) {
        return badRequest(res, 'No file found in upload');
      }
      if (!['raw', 'v1', 'v2'].includes(versionLabel)) {
        return badRequest(res, 'versionLabel must be one of raw, v1, v2');
      }

      const db = await readDb();
      const project = db.projects.find((p) => p.id === projectId);
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

      db.assets.push(asset);
      if (versionLabel === 'v2') {
        project.status = 'ready_for_review';
      }
      await writeDb(db);

      return sendJson(res, 201, { asset });
    }

    const aiBriefMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/ai\/brief$/i);
    if (method === 'POST' && aiBriefMatch) {
      const projectId = aiBriefMatch[1];
      const body = await parseJsonBody(req);
      const text = (body.text || '').trim();

      const mockBrief = {
        projectId,
        generatedAt: new Date().toISOString(),
        hook_style: 'Pattern interrupt + bold opening claim',
        tone: 'Direct, energetic, practical',
        target_duration_sec: 30,
        caption_style: 'Large yellow keywords + white supporting text',
        music_vibe: 'Low-key trending beat, non-distracting',
        cta_type: 'Comment prompt',
        dos: ['Open with pain point in first 2 seconds', 'Cut silence gaps', 'Use 1 key message'],
        donts: ['Overcrowded captions', 'Slow intro', 'Long outro'],
        source_input: text
      };

      return sendJson(res, 200, { brief: mockBrief, note: 'Placeholder AI endpoint. Real model integration in Phase 2.' });
    }

    const aiChecklistMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/ai\/checklist$/i);
    if (method === 'POST' && aiChecklistMatch) {
      const projectId = aiChecklistMatch[1];
      const body = await parseJsonBody(req);
      const feedback = body.feedback || [];

      const checklist = {
        projectId,
        generatedAt: new Date().toISOString(),
        items: [
          { priority: 'P0', title: 'Fix hook pacing in first 3 seconds', owner: 'editor' },
          { priority: 'P1', title: 'Update caption wording at 0:22', owner: 'editor' },
          { priority: 'P1', title: 'Add CTA at ending frame', owner: 'editor' }
        ],
        source_feedback_count: Array.isArray(feedback) ? feedback.length : 0
      };

      return sendJson(res, 200, { checklist, note: 'Placeholder AI endpoint. Real model integration in Phase 2.' });
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
