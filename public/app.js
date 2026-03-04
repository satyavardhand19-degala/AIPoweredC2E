const authForm = document.getElementById('auth-form');
const logoutButton = document.getElementById('logout-button');
const authMeta = document.getElementById('auth-meta');

const projectForm = document.getElementById('project-form');
const uploadForm = document.getElementById('upload-form');
const briefInputForm = document.getElementById('brief-input-form');
const voiceForm = document.getElementById('voice-form');
const feedbackForm = document.getElementById('feedback-form');

const projectSelect = document.getElementById('project-select');
const activeProjectMeta = document.getElementById('active-project-meta');
const projectsEl = document.getElementById('projects');
const checklistEl = document.getElementById('checklist');
const voiceNotesEl = document.getElementById('voice-notes');
const previewVideo = document.getElementById('preview-video');
const previewMeta = document.getElementById('preview-meta');

const aiOutput = document.getElementById('ai-output');
const summaryOutput = document.getElementById('summary-output');

const briefButton = document.getElementById('generate-brief');
const checklistButton = document.getElementById('generate-checklist');
const summaryButton = document.getElementById('generate-summary');

let state = {
  user: null,
  csrfToken: null,
  projects: [],
  activeProjectId: null,
  context: null
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(ts) {
  const s = Math.floor(Number(ts) || 0);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function notifyError(message) {
  alert(message);
}

function setActiveProject(projectId) {
  state.activeProjectId = projectId;
}

function currentProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.headers || {})
  };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path !== '/api/auth/login' && state.csrfToken) {
    headers['x-csrf-token'] = state.csrfToken;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function handleUnauthorized() {
  state.user = null;
  state.csrfToken = null;
  state.projects = [];
  state.activeProjectId = null;
  state.context = null;
  renderAuth();
  renderProjectOptions();
  renderProjects();
  renderChecklist();
  renderVoiceNotes();
  renderContextDebug();
}

function applyRoleDefaults() {
  const creatorField = projectForm.querySelector('input[name="creatorName"]');
  if (!(creatorField instanceof HTMLInputElement)) {
    return;
  }

  if (!state.user) {
    creatorField.readOnly = false;
    return;
  }

  if (state.user.role === 'creator') {
    creatorField.value = state.user.name;
    creatorField.readOnly = true;
  } else {
    creatorField.readOnly = false;
  }
}

function setControlsEnabled(enabled) {
  const guardForms = [projectForm, uploadForm, briefInputForm, voiceForm, feedbackForm];
  for (const form of guardForms) {
    const controls = form.querySelectorAll('input, select, textarea, button');
    controls.forEach((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement)) {
        return;
      }
      el.disabled = !enabled;
    });
  }

  projectSelect.disabled = !enabled;
  briefButton.disabled = !enabled;
  checklistButton.disabled = !enabled;
  summaryButton.disabled = !enabled;

  const createButton = projectForm.querySelector('button[type="submit"]');
  if (createButton instanceof HTMLButtonElement && state.user?.role !== 'creator') {
    createButton.disabled = true;
    createButton.title = 'Only creator can create a project';
  }
}

function renderAuth() {
  if (!state.user) {
    authMeta.textContent = 'Not logged in';
    logoutButton.disabled = true;
    setControlsEnabled(false);
    applyRoleDefaults();
    renderVoiceNotes();
    return;
  }

  authMeta.textContent = `Logged in as ${state.user.name} (${state.user.role})`;
  logoutButton.disabled = false;
  setControlsEnabled(true);
  applyRoleDefaults();
}

function renderProjectOptions() {
  const options = state.projects
    .map((project) => {
      return `<option value="${project.id}">${escapeHtml(project.title)} (${escapeHtml(project.creatorName)} -> ${escapeHtml(project.editorName)})</option>`;
    })
    .join('');

  projectSelect.innerHTML = options || '<option value="">No projects yet</option>';

  if (!state.activeProjectId && state.projects.length) {
    setActiveProject(state.projects[0].id);
  }

  if (state.activeProjectId) {
    projectSelect.value = state.activeProjectId;
  }

  const active = currentProject();
  if (!active) {
    activeProjectMeta.textContent = 'No active project';
    return;
  }

  const m = active.metrics || {};
  activeProjectMeta.textContent = `Status: ${active.status} | Briefs: ${m.briefCount || 0} | Feedback: ${m.commentsCount || 0} | Checklist open: ${m.checklistOpenCount || 0}`;
}

function renderProjects() {
  if (!state.user) {
    projectsEl.innerHTML = '<p class="meta">Login to view your projects.</p>';
    return;
  }

  if (!state.projects.length) {
    projectsEl.innerHTML = '<p class="meta">No projects available for your account.</p>';
    return;
  }

  projectsEl.innerHTML = state.projects
    .map((project) => {
      const assets = [...project.assets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const assetsHtml = assets.length
        ? assets
            .map(
              (asset) => `
                <li class="asset-row">
                  <div>
                    <strong>${escapeHtml(asset.versionLabel.toUpperCase())}</strong>
                    <div class="meta">${escapeHtml(asset.originalName)} (${Math.round(asset.sizeBytes / 1024)} KB)</div>
                  </div>
                  <button data-asset-url="${asset.url}" data-asset-label="${escapeHtml(project.title)} / ${escapeHtml(asset.versionLabel)}">Play</button>
                </li>
              `
            )
            .join('')
        : '<li class="meta">No uploads yet</li>';

      return `
        <article class="card">
          <h3>${escapeHtml(project.title)}</h3>
          <p class="meta">Creator: ${escapeHtml(project.creatorName)} | Editor: ${escapeHtml(project.editorName)}</p>
          <p class="meta">Status: ${escapeHtml(project.status)}</p>
          <button data-open-project="${project.id}">Set Active Project</button>
          <ul class="asset-list">${assetsHtml}</ul>
        </article>
      `;
    })
    .join('');
}

function renderChecklist() {
  const items = state.context?.checklistItems || [];

  if (!state.user) {
    checklistEl.innerHTML = '<p class="meta">Login to view checklist.</p>';
    return;
  }

  if (!items.length) {
    checklistEl.innerHTML = '<p class="meta">No checklist items yet. Add feedback and generate checklist.</p>';
    return;
  }

  checklistEl.innerHTML = items
    .map((item) => {
      const disableActions = state.user?.role !== 'editor' ? 'disabled' : '';
      return `
        <div class="check-item ${item.status === 'done' ? 'is-done' : ''}">
          <div>
            <div><strong>[${escapeHtml(item.priority)}]</strong> ${escapeHtml(item.title)}</div>
            <div class="meta">At ${formatTime(item.timestampSec)} | Owner: ${escapeHtml(item.owner)} | Status: ${escapeHtml(item.status)}</div>
            <div class="meta">${escapeHtml(item.details || '')}</div>
          </div>
          <div class="actions">
            <button ${disableActions} data-item-id="${item.id}" data-item-status="todo">todo</button>
            <button ${disableActions} data-item-id="${item.id}" data-item-status="in_progress">in progress</button>
            <button ${disableActions} data-item-id="${item.id}" data-item-status="done">done</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderVoiceNotes() {
  const items = state.context?.voiceNotes || [];

  if (!state.user) {
    voiceNotesEl.innerHTML = '<p class="meta">Login to view voice notes.</p>';
    return;
  }

  if (!items.length) {
    voiceNotesEl.innerHTML = '<p class="meta">No voice notes uploaded yet.</p>';
    return;
  }

  voiceNotesEl.innerHTML = items
    .slice(0, 8)
    .map((item) => {
      return `
        <div class="voice-item">
          <div><strong>${escapeHtml(item.contextType)}</strong> | ${escapeHtml(item.sttMode)} | ${escapeHtml(item.originalName || 'voice')}</div>
          <div class="meta">By ${escapeHtml(item.uploaderRole)}${item.versionLabel ? ` | ${escapeHtml(item.versionLabel)} @ ${formatTime(item.timestampSec || 0)}` : ''}</div>
          <div class="meta">${escapeHtml(item.transcript || '')}</div>
        </div>
      `;
    })
    .join('');
}

function renderContextDebug() {
  if (!state.user) {
    aiOutput.textContent = 'Login to view context.';
    return;
  }

  if (!state.context) {
    aiOutput.textContent = 'No project context loaded.';
    return;
  }

  const latestBrief = state.context.briefs?.[0] || null;
  const latestComments = state.context.comments?.slice(0, 5) || [];

  aiOutput.textContent = JSON.stringify(
    {
      user: state.user,
      latestBrief,
      recentComments: latestComments,
      checklistCount: state.context.checklistItems?.length || 0,
      voiceNoteCount: state.context.voiceNotes?.length || 0
    },
    null,
    2
  );
}

async function restoreSession() {
  const { ok, data } = await api('/api/auth/me');
  if (!ok || !data?.user || !data?.csrfToken) {
    state.user = null;
    state.csrfToken = null;
  } else {
    state.user = data.user;
    state.csrfToken = data.csrfToken;
  }
  renderAuth();
}

async function fetchProjects() {
  if (!state.user) {
    state.projects = [];
    renderProjectOptions();
    renderProjects();
    return;
  }

  const { ok, status, data } = await api('/api/projects');
  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(data?.error || 'Failed to fetch projects');
    return;
  }

  state.projects = data.projects || [];
  if (state.activeProjectId && !state.projects.some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = null;
  }

  renderProjectOptions();
  renderProjects();
}

async function fetchContext() {
  if (!state.user || !state.activeProjectId) {
    state.context = null;
    renderChecklist();
    renderVoiceNotes();
    renderContextDebug();
    return;
  }

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/context`);
  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    state.context = null;
    renderChecklist();
    renderVoiceNotes();
    renderContextDebug();
    return;
  }

  state.context = data;
  renderChecklist();
  renderVoiceNotes();
  renderContextDebug();
}

async function refreshAll() {
  await fetchProjects();
  await fetchContext();
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(authForm);
  const payload = {
    name: String(formData.get('name') || ''),
    role: String(formData.get('role') || '')
  };

  const { ok, data } = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!ok) {
    notifyError(data?.error || 'Login failed');
    return;
  }

  state.user = data.user;
  state.csrfToken = data.csrfToken || null;
  authForm.reset();
  renderAuth();
  await refreshAll();
});

logoutButton.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  handleUnauthorized();
  summaryOutput.textContent = '';
  previewVideo.removeAttribute('src');
  previewMeta.textContent = 'Select a project asset to preview.';
});

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!state.user) {
    notifyError('Login first');
    return;
  }

  const formData = new FormData(projectForm);
  const payload = {
    title: String(formData.get('title') || ''),
    creatorName: String(formData.get('creatorName') || state.user.name),
    editorName: String(formData.get('editorName') || '')
  };

  const { ok, status, data } = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Failed to create project: ${data?.error || 'Unknown error'}`);
    return;
  }

  setActiveProject(data.project.id);
  projectForm.reset();
  applyRoleDefaults();
  await refreshAll();
});

projectSelect.addEventListener('change', async (event) => {
  setActiveProject(event.target.value);
  await fetchContext();
  renderProjectOptions();
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const formData = new FormData(uploadForm);
  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/upload`, {
    method: 'POST',
    body: formData
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Upload failed: ${data?.error || 'Unknown error'}`);
    return;
  }

  uploadForm.reset();
  await refreshAll();
});

briefInputForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const formData = new FormData(briefInputForm);
  const payload = {
    inputType: String(formData.get('inputType') || ''),
    content: String(formData.get('content') || '')
  };

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/brief-inputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Failed to save brief input: ${data?.error || 'Unknown error'}`);
    return;
  }

  briefInputForm.reset();
  await refreshAll();
});

voiceForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const formData = new FormData(voiceForm);
  const contextType = String(formData.get('contextType') || 'brief');
  if (contextType !== 'feedback') {
    formData.delete('versionLabel');
    formData.delete('timestampSec');
  }

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/voice-notes`, {
    method: 'POST',
    body: formData
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Voice note upload failed: ${data?.error || 'Unknown error'}`);
    return;
  }

  aiOutput.textContent = JSON.stringify(data, null, 2);
  voiceForm.reset();
  await refreshAll();
});

feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const formData = new FormData(feedbackForm);
  const payload = {
    versionLabel: String(formData.get('versionLabel') || ''),
    timestampSec: Number(formData.get('timestampSec') || 0),
    source: String(formData.get('source') || ''),
    text: String(formData.get('text') || '')
  };

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Failed to add feedback: ${data?.error || 'Unknown error'}`);
    return;
  }

  feedbackForm.reset();
  await refreshAll();
});

projectsEl.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const openProjectId = target.getAttribute('data-open-project');
  if (openProjectId) {
    setActiveProject(openProjectId);
    renderProjectOptions();
    await fetchContext();
    return;
  }

  const assetUrl = target.getAttribute('data-asset-url');
  const assetLabel = target.getAttribute('data-asset-label');
  if (assetUrl) {
    previewVideo.src = assetUrl;
    previewMeta.textContent = `Previewing: ${assetLabel || assetUrl}`;
    previewVideo.play().catch(() => {});
  }
});

checklistEl.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const itemId = target.getAttribute('data-item-id');
  const status = target.getAttribute('data-item-status');
  if (!itemId || !status) {
    return;
  }

  const { ok, status: httpStatus, data } = await api(`/api/checklist/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });

  if (!ok) {
    if (httpStatus === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Failed to update checklist item: ${data?.error || 'Unknown error'}`);
    return;
  }

  await refreshAll();
});

briefButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Brief generation failed: ${data?.error || 'Unknown error'}`);
    return;
  }

  aiOutput.textContent = JSON.stringify(data, null, 2);
  await refreshAll();
});

checklistButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/ai/checklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Checklist generation failed: ${data?.error || 'Unknown error'}`);
    return;
  }

  aiOutput.textContent = JSON.stringify(data, null, 2);
  await refreshAll();
});

summaryButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const { ok, status, data } = await api(`/api/projects/${state.activeProjectId}/ai/version-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  if (!ok) {
    if (status === 401) {
      handleUnauthorized();
      return;
    }
    notifyError(`Summary generation failed: ${data?.error || 'Unknown error'}`);
    return;
  }

  summaryOutput.textContent = JSON.stringify(data, null, 2);
  await refreshAll();
});

(async () => {
  await restoreSession();
  await refreshAll();
  renderAuth();
})().catch((error) => {
  aiOutput.textContent = `Failed to initialize app: ${error.message}`;
});
