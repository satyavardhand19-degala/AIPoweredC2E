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

async function registerUser({ name, email, password, role }) {
  return apiRequest('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password, role })
  });
}

async function loginUser({ identifier, password, role }) {
  return apiRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password, role })
  });
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
    const registerRes = await registerUser({
      name: `User_${unique}`,
      email: `user_${unique}@example.com`,
      password: 'Password123',
      role: 'creator'
    });
    assert.equal(registerRes.status, 201);
    assert.ok(registerRes.data.csrfToken);
    assert.ok(registerRes.data.user.profileId);
    assert.ok(registerRes.headers.get('set-cookie'));

    const cookie = parseCookie(registerRes.headers.get('set-cookie'));
    const me = await apiRequest('/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.name, `User_${unique}`);
    assert.equal(me.data.user.email, `user_${unique}@example.com`);
    assert.equal(me.data.user.role, 'creator');

    const loginRes = await loginUser({
      identifier: `user_${unique}@example.com`,
      password: 'Password123',
      role: 'creator'
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.data.user.name, `User_${unique}`);
  });

  await t.test('Project Creation, Connection, and Access', async () => {
    const unique = Date.now();
    const creator = await registerUser({
      name: `Creator_${unique}`,
      email: `creator_${unique}@example.com`,
      password: 'Password123',
      role: 'creator'
    });
    const creatorCookie = parseCookie(creator.headers.get('set-cookie'));
    const creatorCsrf = creator.data.csrfToken;

    const editor = await registerUser({
      name: `Editor_${unique}`,
      email: `editor_${unique}@example.com`,
      password: 'Password123',
      role: 'editor'
    });
    const editorCookie = parseCookie(editor.headers.get('set-cookie'));
    const editorCsrf = editor.data.csrfToken;

    const connection = await apiRequest('/api/connections', {
      method: 'POST',
      cookie: editorCookie,
      csrf: editorCsrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorId: creator.data.user.profileId })
    });
    assert.equal(connection.status, 201);

    const createRes = await apiRequest('/api/projects', {
      method: 'POST',
      cookie: creatorCookie,
      csrf: creatorCsrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration Test Project',
        editorUserId: editor.data.user.id
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
    const randomUser = await registerUser({
      name: `Other_${unique}`,
      email: `other_${unique}@example.com`,
      password: 'Password123',
      role: 'creator'
    });
    const otherCookie = parseCookie(randomUser.headers.get('set-cookie'));
    const otherContext = await apiRequest(`/api/projects/${projectId}/context`, {
      cookie: otherCookie
    });
    assert.equal(otherContext.status, 403);
  });

  await t.test('Role-Based Page Protection', async () => {
    const unique = Date.now();
    const creator = await registerUser({
      name: `RouteCreator_${unique}`,
      email: `route_creator_${unique}@example.com`,
      password: 'Password123',
      role: 'creator'
    });
    const creatorCookie = parseCookie(creator.headers.get('set-cookie'));

    const editor = await registerUser({
      name: `RouteEditor_${unique}`,
      email: `route_editor_${unique}@example.com`,
      password: 'Password123',
      role: 'editor'
    });
    const editorCookie = parseCookie(editor.headers.get('set-cookie'));

    const creatorDashboard = await fetch(`${BASE}/creator-dashboard`, {
      headers: { Cookie: creatorCookie },
      redirect: 'manual'
    });
    assert.equal(creatorDashboard.status, 200);

    const creatorToEditor = await fetch(`${BASE}/editor-dashboard`, {
      headers: { Cookie: creatorCookie },
      redirect: 'manual'
    });
    assert.equal(creatorToEditor.status, 302);
    assert.equal(creatorToEditor.headers.get('location'), '/creator-dashboard');

    const editorDashboard = await fetch(`${BASE}/editor-dashboard`, {
      headers: { Cookie: editorCookie },
      redirect: 'manual'
    });
    assert.equal(editorDashboard.status, 200);

    const editorToCreator = await fetch(`${BASE}/creator-dashboard`, {
      headers: { Cookie: editorCookie },
      redirect: 'manual'
    });
    assert.equal(editorToCreator.status, 302);
    assert.equal(editorToCreator.headers.get('location'), '/editor-dashboard');
  });
});
