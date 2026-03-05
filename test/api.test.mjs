import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PORT = 3113;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = path.join(process.cwd(), 'test-api-env');

function waitForServer(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timeout')), timeoutMs);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes('Server running at')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

function parseCookie(setCookieHeader) {
  if (!setCookieHeader) return '';
  return setCookieHeader.split(';')[0].trim();
}

async function apiRequest(path, { method = 'GET', body, cookie = '', csrf = '', headers = {} } = {}) {
  const merged = { ...headers };
  if (cookie) merged.Cookie = cookie;
  if (csrf) merged['x-csrf-token'] = csrf;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: merged,
    body
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, headers: res.headers, data };
}

test('API Integration', async (t) => {
  let serverProc;

  await t.before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    serverProc = spawn('node', ['server.mjs'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_BACKEND: 'sqlite',
        DATA_DIR: path.join(TEST_DIR, 'data'),
        UPLOAD_DIR: path.join(TEST_DIR, 'uploads'),
        NODE_ENV: 'test',
        RATE_LIMIT_AUTH_MAX: '100',
        RATE_LIMIT_MAX: '1000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForServer(serverProc);
  });

  await t.after(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  await t.test('Health and Metrics', async () => {
    const health = await apiRequest('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);

    const metrics = await apiRequest('/api/metrics');
    assert.equal(metrics.status, 200);
    assert.ok(metrics.data.uptime_seconds > 0);
  });

  await t.test('Auth Flow', async () => {
    const unique = Date.now();
    const loginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `User_${unique}`, role: 'creator' })
    });
    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.data.csrfToken);
    assert.ok(loginRes.headers.get('set-cookie'));

    const cookie = parseCookie(loginRes.headers.get('set-cookie'));
    const me = await apiRequest('/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.name, `User_${unique}`);
  });

  await t.test('Project Creation and Access', async () => {
    const unique = Date.now();
    const creator = await apiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Creator_${unique}`, role: 'creator' })
    });
    const creatorCookie = parseCookie(creator.headers.get('set-cookie'));
    const creatorCsrf = creator.data.csrfToken;

    const editor = await apiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Editor_${unique}`, role: 'editor' })
    });
    const editorCookie = parseCookie(editor.headers.get('set-cookie'));

    const createRes = await apiRequest('/api/projects', {
      method: 'POST',
      cookie: creatorCookie,
      csrf: creatorCsrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration Test Project',
        creatorName: creator.data.user.name,
        editorName: editor.data.user.name
      })
    });
    assert.equal(createRes.status, 201);
    const projectId = createRes.data.project.id;

    // Check access
    const context = await apiRequest(`/api/projects/${projectId}/context`, {
      cookie: creatorCookie
    });
    assert.equal(context.status, 200);

    const editorContext = await apiRequest(`/api/projects/${projectId}/context`, {
      cookie: editorCookie
    });
    assert.equal(editorContext.status, 200);

    // Forbidden access
    const randomUser = await apiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Other_${unique}`, role: 'creator' })
    });
    const otherCookie = parseCookie(randomUser.headers.get('set-cookie'));
    const otherContext = await apiRequest(`/api/projects/${projectId}/context`, {
      cookie: otherCookie
    });
    assert.equal(otherContext.status, 403);
  });
});
