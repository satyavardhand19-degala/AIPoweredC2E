import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function request(path, { method = 'GET', body, cookie = '', csrf = '', headers = {} } = {}) {
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

async function login(name, role) {
  const res = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role })
  });
  assert.equal(res.status, 200, `Login failed for ${name}`);
  return {
    user: res.data.user,
    csrf: res.data.csrfToken,
    cookie: parseCookie(res.headers.get('set-cookie'))
  };
}

async function run() {
  const server = spawn('node', ['server.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      RATE_LIMIT_AUTH_MAX: '30',
      RATE_LIMIT_MAX: '300'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(server);

    const unique = Date.now();
    const creator = await login(`FlowCreator_${unique}`, 'creator');
    const editor = await login(`FlowEditor_${unique}`, 'editor');

    const createProject = await request('/api/projects', {
      method: 'POST',
      cookie: creator.cookie,
      csrf: creator.csrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `Flow Project ${unique}`,
        creatorName: creator.user.name,
        editorName: editor.user.name
      })
    });
    assert.equal(createProject.status, 201, 'Project creation failed');
    const projectId = createProject.data.project.id;

    const rawForm = new FormData();
    rawForm.append('versionLabel', 'raw');
    rawForm.append('file', new Blob([Buffer.from('raw-video')], { type: 'video/mp4' }), 'raw.mp4');
    const rawUpload = await request(`/api/projects/${projectId}/upload`, {
      method: 'POST',
      cookie: creator.cookie,
      csrf: creator.csrf,
      body: rawForm
    });
    assert.equal(rawUpload.status, 201, 'Raw upload failed');

    const voiceForm = new FormData();
    voiceForm.append('contextType', 'brief');
    voiceForm.append('file', new Blob([Buffer.from('RIFFabcdWAVEfmt ')], { type: 'audio/wav' }), 'brief.wav');
    const voiceUpload = await request(`/api/projects/${projectId}/voice-notes`, {
      method: 'POST',
      cookie: creator.cookie,
      csrf: creator.csrf,
      body: voiceForm
    });
    assert.equal(voiceUpload.status, 201, 'Voice note upload failed');

    const genBrief = await request(`/api/projects/${projectId}/ai/brief`, {
      method: 'POST',
      cookie: creator.cookie,
      csrf: creator.csrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(genBrief.status, 200, 'Brief generation failed');

    const v1Form = new FormData();
    v1Form.append('versionLabel', 'v1');
    v1Form.append('file', new Blob([Buffer.from('v1-video')], { type: 'video/mp4' }), 'v1.mp4');
    const v1Upload = await request(`/api/projects/${projectId}/upload`, {
      method: 'POST',
      cookie: editor.cookie,
      csrf: editor.csrf,
      body: v1Form
    });
    assert.equal(v1Upload.status, 201, 'V1 upload failed');

    const feedback = await request(`/api/projects/${projectId}/comments`, {
      method: 'POST',
      cookie: creator.cookie,
      csrf: creator.csrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        versionLabel: 'v1',
        timestampSec: 14,
        source: 'text',
        text: 'Hook too slow here'
      })
    });
    assert.equal(feedback.status, 201, 'Feedback save failed');

    const checklist = await request(`/api/projects/${projectId}/ai/checklist`, {
      method: 'POST',
      cookie: editor.cookie,
      csrf: editor.csrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(checklist.status, 200, 'Checklist generation failed');
    assert.ok(checklist.data?.checklist?.items?.length > 0, 'Checklist must contain items');

    const checklistId = checklist.data.checklist.items[0].id;
    const checklistDone = await request(`/api/checklist/${checklistId}`, {
      method: 'PATCH',
      cookie: editor.cookie,
      csrf: editor.csrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' })
    });
    assert.equal(checklistDone.status, 200, 'Checklist status update failed');

    const v2Form = new FormData();
    v2Form.append('versionLabel', 'v2');
    v2Form.append('file', new Blob([Buffer.from('v2-video')], { type: 'video/mp4' }), 'v2.mp4');
    const v2Upload = await request(`/api/projects/${projectId}/upload`, {
      method: 'POST',
      cookie: editor.cookie,
      csrf: editor.csrf,
      body: v2Form
    });
    assert.equal(v2Upload.status, 201, 'V2 upload failed');

    const summary = await request(`/api/projects/${projectId}/ai/version-summary`, {
      method: 'POST',
      cookie: creator.cookie,
      csrf: creator.csrf,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(summary.status, 200, 'Version summary failed');
    assert.ok(Number.isFinite(summary.data?.summary?.publish_readiness_score), 'Summary should include readiness score');

    const context = await request(`/api/projects/${projectId}/context`, {
      method: 'GET',
      cookie: creator.cookie
    });
    assert.equal(context.status, 200, 'Context fetch failed');
    assert.ok((context.data?.briefInputs || []).length > 0, 'Expected brief inputs in context');
    assert.ok((context.data?.voiceNotes || []).length > 0, 'Expected voice notes in context');
    assert.ok((context.data?.checklistItems || []).length > 0, 'Expected checklist items in context');

    console.log('Workflow smoke test passed');
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
