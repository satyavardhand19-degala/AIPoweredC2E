import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function run() {
  const server = spawn('node', ['server.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      RATE_LIMIT_AUTH_MAX: '6',
      RATE_LIMIT_MAX: '200'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(server);

    const unauthProjects = await request('/api/projects');
    assert.equal(unauthProjects.status, 401, 'Unauthenticated projects call should be 401');

    const creatorLogin = await request('/api/auth/login', {
      method: 'POST',
      body: {
        name: `TestCreator_${Date.now()}`,
        role: 'creator'
      }
    });
    assert.equal(creatorLogin.status, 200, 'Creator login should succeed');
    assert.ok(creatorLogin.data?.csrfToken, 'Creator login should return csrfToken');
    const creatorCookie = parseCookie(creatorLogin.headers.get('set-cookie'));
    assert.ok(creatorCookie.includes('ce_session='), 'Creator login should set session cookie');

    const noCsrfCreate = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'CSRF Block Test',
        creatorName: creatorLogin.data.user.name,
        editorName: 'EditorX'
      },
      cookie: creatorCookie
    });
    assert.equal(noCsrfCreate.status, 403, 'Missing CSRF should be blocked');

    const withCsrfCreate = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'CSRF Allowed Test',
        creatorName: creatorLogin.data.user.name,
        editorName: 'EditorX'
      },
      cookie: creatorCookie,
      csrf: creatorLogin.data.csrfToken
    });
    assert.equal(withCsrfCreate.status, 201, 'Valid CSRF should allow project creation');

    const editorLogin = await request('/api/auth/login', {
      method: 'POST',
      body: {
        name: `TestEditor_${Date.now()}`,
        role: 'editor'
      }
    });
    assert.equal(editorLogin.status, 200, 'Editor login should succeed');
    const editorCookie = parseCookie(editorLogin.headers.get('set-cookie'));

    const editorCreate = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'Editor Should Fail Create',
        creatorName: 'Someone',
        editorName: editorLogin.data.user.name
      },
      cookie: editorCookie,
      csrf: editorLogin.data.csrfToken
    });
    assert.equal(editorCreate.status, 403, 'Editor must not be allowed to create project');

    let sawRateLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await request('/api/auth/login', {
        method: 'POST',
        body: {
          name: `BurstUser_${i}_${Date.now()}`,
          role: 'creator'
        }
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
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
