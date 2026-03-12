import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = path.join(process.cwd(), 'test-security-env');

function waitForServer(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Server start timeout'));
    }, timeoutMs);

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
  const pair = setCookieHeader.split(';')[0];
  return pair.trim();
}

async function request(path, { method = 'GET', body, cookie = '', csrf = '', json = true } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body && json) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? (json ? JSON.stringify(body) : body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return {
    status: res.status,
    headers: res.headers,
    data
  };
}

async function registerUser({ name, email, password, role }) {
  return request('/api/auth/register', {
    method: 'POST',
    body: { name, email, password, role }
  });
}

async function loginUser({ identifier, password, role }) {
  return request('/api/auth/login', {
    method: 'POST',
    body: { identifier, password, role }
  });
}

async function run() {
  await mkdir(TEST_DIR, { recursive: true });
  const server = spawn('node', ['server.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_BACKEND: 'sqlite',
      DATA_DIR: path.join(TEST_DIR, 'data'),
      UPLOAD_DIR: path.join(TEST_DIR, 'uploads'),
      NODE_ENV: 'test',
      RATE_LIMIT_AUTH_MAX: '6',
      RATE_LIMIT_MAX: '200'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(server);

    const unauthProjects = await request('/api/projects');
    assert.equal(unauthProjects.status, 401, 'Unauthenticated projects call should be 401');

    const unique = Date.now();
    const creatorEmail = `security_creator_${unique}@example.com`;
    const creatorRegister = await registerUser({
      name: `TestCreator_${unique}`,
      email: creatorEmail,
      password: 'Password123',
      role: 'creator'
    });
    assert.equal(creatorRegister.status, 201, 'Creator registration should succeed');

    const creatorLogin = await loginUser({
      identifier: creatorEmail,
      password: 'Password123',
      role: 'creator'
    });
    assert.equal(creatorLogin.status, 200, 'Creator login should succeed');
    assert.ok(creatorLogin.data?.csrfToken, 'Creator login should return csrfToken');
    const creatorCookie = parseCookie(creatorLogin.headers.get('set-cookie'));
    assert.ok(creatorCookie.includes('ce_session='), 'Creator login should set session cookie');

    const noCsrfCreate = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'CSRF Block Test'
      },
      cookie: creatorCookie
    });
    assert.equal(noCsrfCreate.status, 403, 'Missing CSRF should be blocked');

    const withCsrfCreate = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'CSRF Allowed Test'
      },
      cookie: creatorCookie,
      csrf: creatorLogin.data.csrfToken
    });
    assert.equal(withCsrfCreate.status, 201, 'Valid CSRF should allow project creation');

    const editorEmail = `security_editor_${unique}@example.com`;
    const editorRegister = await registerUser({
      name: `TestEditor_${unique}`,
      email: editorEmail,
      password: 'Password123',
      role: 'editor'
    });
    assert.equal(editorRegister.status, 201, 'Editor registration should succeed');

    const editorLogin = await loginUser({
      identifier: editorEmail,
      password: 'Password123',
      role: 'editor'
    });
    assert.equal(editorLogin.status, 200, 'Editor login should succeed');
    const editorCookie = parseCookie(editorLogin.headers.get('set-cookie'));

    const editorCreate = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'Editor Should Fail Create'
      },
      cookie: editorCookie,
      csrf: editorLogin.data.csrfToken
    });
    assert.equal(editorCreate.status, 403, 'Editor must not be allowed to create project');

    let sawRateLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await loginUser({
        identifier: creatorEmail,
        password: `WrongPassword${i}`,
        role: 'creator'
      });
      if (r.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    assert.equal(sawRateLimit, true, 'Auth rate limiting should eventually return 429');

    console.log('Security smoke test passed');
  } finally {
    server.kill('SIGTERM');
    await rm(TEST_DIR, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
