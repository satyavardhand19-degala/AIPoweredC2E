const pageRole = document.body.dataset.rolePage || '';

const authSummaryEl = document.getElementById('auth-summary');
const logoutButton = document.getElementById('logout-button');
const roleNav = document.getElementById('role-nav');
const dashboardTitle = document.getElementById('dashboard-title');
const dashboardSubtitle = document.getElementById('dashboard-subtitle');
const heroStats = document.getElementById('hero-stats');
const flashMessage = document.getElementById('flash-message');
const connectionsPanel = document.getElementById('connections-panel');
const projectForm = document.getElementById('project-form');
const connectForm = document.getElementById('connect-form');
const projectSelect = document.getElementById('project-select');
const activeProjectMeta = document.getElementById('active-project-meta');
const connectedEditorSelect = document.getElementById('connected-editor-select');
const uploadForm = document.getElementById('upload-form');
const uploadVersion = document.getElementById('upload-version');
const briefInputForm = document.getElementById('brief-input-form');
const feedbackForm = document.getElementById('feedback-form');
const voiceForm = document.getElementById('voice-form');
const generateBriefButton = document.getElementById('generate-brief');
const generateChecklistButton = document.getElementById('generate-checklist');
const generateSummaryButton = document.getElementById('generate-summary');
const projectsList = document.getElementById('projects-list');
const latestBrief = document.getElementById('latest-brief');
const commentsList = document.getElementById('comments-list');
const checklistList = document.getElementById('checklist-list');
const voiceNotesList = document.getElementById('voice-notes-list');
const previewMeta = document.getElementById('preview-meta');
const previewVideo = document.getElementById('preview-video');
const summaryOutput = document.getElementById('summary-output');

const state = {
  user: null,
  csrfToken: null,
  connections: [],
  projects: [],
  activeProjectId: '',
  context: null
};

function setFlash(message, type = '') {
  if (!flashMessage) {
    return;
  }
  flashMessage.textContent = message;
  flashMessage.className = `status ${type}`.trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function persistActiveProject() {
  if (!state.user) {
    return;
  }
  localStorage.setItem(`ce-active-project-${state.user.id}`, state.activeProjectId || '');
}

function restoreActiveProject() {
  if (!state.user) {
    return '';
  }
  return localStorage.getItem(`ce-active-project-${state.user.id}`) || '';
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path !== '/api/auth/login' && path !== '/api/auth/register' && state.csrfToken) {
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

function ensurePageRole() {
  if (!state.user) {
    window.location.href = '/login';
    return false;
  }
  if (state.user.role !== pageRole) {
    window.location.href = state.user.role === 'creator' ? '/creator-dashboard' : '/editor-dashboard';
    return false;
  }
  return true;
}

function renderNav() {
  if (!roleNav) {
    return;
  }
  roleNav.innerHTML = `
    <a href="#overview" class="is-active">Overview</a>
    <a href="#connections">Connections</a>
    <a href="#projects">Projects</a>
    <a href="#workspace">Workspace</a>
  `;
}

function renderHeader() {
  if (!state.user) {
    return;
  }
  if (dashboardTitle) {
    dashboardTitle.textContent = pageRole === 'creator' ? 'Creator Dashboard' : 'Editor Dashboard';
  }
  if (dashboardSubtitle) {
    dashboardSubtitle.textContent =
      pageRole === 'creator'
        ? `You are signed in as ${state.user.name}. Use ${state.user.profileId} to let editors connect before you assign them.`
        : `You are signed in as ${state.user.name}. Connect with a Creator ID before you start editing assigned content.`;
  }
  if (authSummaryEl) {
    authSummaryEl.textContent = `${state.user.name} | ${state.user.email} | ${state.user.profileId}`;
  }
}

function renderHeroStats() {
  if (!heroStats || !state.user) {
    return;
  }
  const assignedCount = state.projects.length;
  const connectedCount = state.connections.length;
  const latest = activeProject();
  heroStats.innerHTML = `
    <div class="stat-card">
      <span class="meta">${pageRole === 'creator' ? 'Creator ID' : 'Editor ID'}</span>
      <strong>${escapeHtml(state.user.profileId)}</strong>
      <span class="meta">Stored in the database and used in role-aware access.</span>
    </div>
    <div class="stat-card">
      <span class="meta">${pageRole === 'creator' ? 'Connected editors' : 'Connected creators'}</span>
      <strong>${connectedCount}</strong>
      <span class="meta">${pageRole === 'creator' ? 'Assignable to new projects' : 'Available for creator-approved work'}</span>
    </div>
    <div class="stat-card">
      <span class="meta">${pageRole === 'creator' ? 'My projects' : 'Assigned projects'}</span>
      <strong>${assignedCount}</strong>
      <span class="meta">${latest ? `Active: ${escapeHtml(latest.title)}` : 'Select a project to open its workspace'}</span>
    </div>
  `;
}

function renderConnections() {
  if (!connectionsPanel) {
    return;
  }
  if (!state.connections.length) {
    connectionsPanel.innerHTML = `<div class="empty-state"><p class="meta">${pageRole === 'creator' ? 'No editors connected yet.' : 'No creators connected yet. Add a Creator ID above.'}</p></div>`;
  } else {
    connectionsPanel.innerHTML = state.connections
      .map((connection) => {
        const label = pageRole === 'creator' ? 'Editor' : 'Creator';
        return `
          <article class="card">
            <h3>${escapeHtml(connection.user.name)}</h3>
            <p class="meta">${label} | ${escapeHtml(connection.user.email)}</p>
            <div class="chip-row">
              <span class="chip">${escapeHtml(connection.user.profileId)}</span>
              <span class="chip neutral">Connected ${new Date(connection.connectedAt).toLocaleDateString()}</span>
            </div>
          </article>
        `;
      })
      .join('');
  }

  if (connectedEditorSelect) {
    const options = state.connections
      .map((connection) => `<option value="${connection.user.id}">${escapeHtml(connection.user.name)} (${escapeHtml(connection.user.profileId)})</option>`)
      .join('');
    connectedEditorSelect.innerHTML = `<option value="">Unassigned</option>${options}`;
  }
}

function renderProjectOptions() {
  if (!projectSelect) {
    return;
  }
  const options = state.projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.title)}${project.editorName ? ` | ${escapeHtml(project.editorName)}` : ''}</option>`)
    .join('');
  projectSelect.innerHTML = options || '<option value="">No projects available</option>';

  if (!state.activeProjectId && state.projects.length) {
    state.activeProjectId = state.projects[0].id;
  }
  if (state.activeProjectId) {
    projectSelect.value = state.activeProjectId;
  }

  const project = activeProject();
  activeProjectMeta.textContent = project
    ? `${project.status} | Creator ${project.creatorProfileId || 'pending'}${project.editorProfileId ? ` | Editor ${project.editorProfileId}` : ' | Unassigned'}` 
    : 'No active project selected.';
}

function renderProjects() {
  if (!projectsList) {
    return;
  }
  if (!state.projects.length) {
    projectsList.innerHTML = '<div class="empty-state"><p class="meta">No projects available for this account.</p></div>';
    return;
  }

  projectsList.innerHTML = state.projects
    .map((project) => {
      const assetButtons = (project.assets || [])
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(
          (asset) => `
            <div class="asset-row">
              <div>
                <strong>${escapeHtml(asset.versionLabel.toUpperCase())}</strong>
                <p class="meta">${escapeHtml(asset.originalName)} | ${Math.round((asset.sizeBytes || 0) / 1024)} KB</p>
              </div>
              <div class="asset-actions">
                <button class="button-secondary" type="button" data-asset-url="${asset.url}" data-asset-label="${escapeHtml(project.title)} / ${escapeHtml(asset.versionLabel)}">Preview</button>
              </div>
            </div>
          `
        )
        .join('');

      const assignmentControl =
        pageRole === 'creator'
          ? `
            <div class="inline">
              <label>
                Assigned Editor
                <select data-project-assignment="${project.id}">
                  <option value="">Unassigned</option>
                  ${state.connections
                    .map(
                      (connection) => `
                        <option value="${connection.user.id}" ${project.editorUserId === connection.user.id ? 'selected' : ''}>
                          ${escapeHtml(connection.user.name)} (${escapeHtml(connection.user.profileId)})
                        </option>
                      `
                    )
                    .join('')}
                </select>
              </label>
              <button class="button-secondary" type="button" data-save-assignment="${project.id}">Save Assignment</button>
            </div>
          `
          : '';

      return `
        <article class="card">
          <div class="split-row">
            <div>
              <h3>${escapeHtml(project.title)}</h3>
              <p class="meta">Creator: ${escapeHtml(project.creatorName || '-')} (${escapeHtml(project.creatorProfileId || 'n/a')})</p>
              <p class="meta">Editor: ${escapeHtml(project.editorName || 'Unassigned')}${project.editorProfileId ? ` (${escapeHtml(project.editorProfileId)})` : ''}</p>
            </div>
            <div class="chip-row">
              <span class="chip">${escapeHtml(project.status)}</span>
              <span class="chip neutral">${project.metrics?.briefCount || 0} briefs</span>
              <span class="chip neutral">${project.metrics?.commentsCount || 0} comments</span>
            </div>
          </div>
          <div class="inline-form-actions">
            <button class="button-secondary" type="button" data-open-project="${project.id}">Open Workspace</button>
          </div>
          ${assignmentControl}
          <div class="asset-list">${assetButtons || '<div class="empty-state"><p class="meta">No assets uploaded yet.</p></div>'}</div>
        </article>
      `;
    })
    .join('');
}

function renderContext() {
  const project = activeProject();
  const context = state.context;

  latestBrief.innerHTML = '<p class="meta">No project selected.</p>';
  commentsList.innerHTML = '<div class="empty-state"><p class="meta">No comments yet.</p></div>';
  checklistList.innerHTML = '<div class="empty-state"><p class="meta">No checklist items yet.</p></div>';
  voiceNotesList.innerHTML = '<div class="empty-state"><p class="meta">No voice notes yet.</p></div>';
  summaryOutput.innerHTML = '<p class="meta">Generate a version summary when V1 and V2 are available.</p>';

  if (!project || !context) {
    return;
  }

  const brief = context.briefs?.[0]?.brief || null;
  latestBrief.innerHTML = brief
    ? `
      <div class="chip-row">
        <span class="chip">${escapeHtml(brief.cta_type)}</span>
        <span class="chip neutral">${escapeHtml(String(brief.target_duration_sec))} sec</span>
      </div>
      <p><strong>Hook:</strong> ${escapeHtml(brief.hook_style)}</p>
      <p><strong>Tone:</strong> ${escapeHtml(brief.tone)}</p>
      <p><strong>Caption style:</strong> ${escapeHtml(brief.caption_style)}</p>
      <p><strong>Music vibe:</strong> ${escapeHtml(brief.music_vibe)}</p>
    `
    : '<p class="meta">No structured brief generated yet.</p>';

  const comments = context.comments || [];
  commentsList.innerHTML = comments.length
    ? comments
        .slice(0, 8)
        .map(
          (comment) => `
            <article class="detail-item">
              <h4>${escapeHtml(comment.versionLabel.toUpperCase())} @ ${formatTime(comment.timestampSec)}</h4>
              <p class="meta">${escapeHtml(comment.authorRole)} via ${escapeHtml(comment.source)}</p>
              <p>${escapeHtml(comment.text)}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state"><p class="meta">No comments yet.</p></div>';

  const checklist = context.checklistItems || [];
  checklistList.innerHTML = checklist.length
    ? checklist
        .map((item) => {
          const actions =
            pageRole === 'editor'
              ? `
                <div class="check-actions">
                  <button class="button-secondary" type="button" data-check-status="todo" data-check-id="${item.id}">Todo</button>
                  <button class="button-secondary" type="button" data-check-status="in_progress" data-check-id="${item.id}">In Progress</button>
                  <button class="button-secondary" type="button" data-check-status="done" data-check-id="${item.id}">Done</button>
                </div>
              `
              : '';

          return `
            <article class="check-item">
              <h4>[${escapeHtml(item.priority)}] ${escapeHtml(item.title)}</h4>
              <p class="meta">${escapeHtml(item.status)} | ${formatTime(item.timestampSec)}</p>
              <p>${escapeHtml(item.details)}</p>
              ${actions}
            </article>
          `;
        })
        .join('')
    : '<div class="empty-state"><p class="meta">No checklist items yet.</p></div>';

  const voiceNotes = context.voiceNotes || [];
  voiceNotesList.innerHTML = voiceNotes.length
    ? voiceNotes
        .slice(0, 8)
        .map(
          (item) => `
            <article class="detail-item">
              <h4>${escapeHtml(item.contextType)} | ${escapeHtml(item.originalName || 'voice-note')}</h4>
              <p class="meta">${escapeHtml(item.uploaderRole)} | ${escapeHtml(item.sttMode)}</p>
              <p>${escapeHtml(item.transcript || '')}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state"><p class="meta">No voice notes yet.</p></div>';
}

function setUploadOptions() {
  if (!uploadVersion) {
    return;
  }
  uploadVersion.innerHTML =
    pageRole === 'creator'
      ? '<option value="raw">Raw</option>'
      : '<option value="v1">V1</option><option value="v2">V2</option>';
}

async function restoreSession() {
  const { ok, data } = await api('/api/auth/me');
  if (!ok || !data?.user) {
    window.location.href = '/login';
    return;
  }
  state.user = data.user;
  state.csrfToken = data.csrfToken || '';
}

async function loadConnections() {
  const { ok, data } = await api('/api/connections');
  if (!ok) {
    throw new Error(data?.error?.message || 'Failed to load connections');
  }
  state.connections = data.connections || [];
}

async function loadProjects() {
  const { ok, data } = await api('/api/projects');
  if (!ok) {
    throw new Error(data?.error?.message || 'Failed to load projects');
  }
  state.projects = data.projects || [];

  if (!state.activeProjectId) {
    state.activeProjectId = restoreActiveProject();
  }
  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = '';
  }
  if (!state.activeProjectId && state.projects[0]) {
    state.activeProjectId = state.projects[0].id;
  }
  persistActiveProject();
}

async function loadContext() {
  if (!state.activeProjectId) {
    state.context = null;
    return;
  }
  const { ok, data, status } = await api(`/api/projects/${state.activeProjectId}/context`);
  if (!ok) {
    if (status === 403 || status === 404) {
      state.context = null;
      return;
    }
    throw new Error(data?.error?.message || 'Failed to load project context');
  }
  state.context = data;
}

async function refreshAll() {
  await loadConnections();
  await loadProjects();
  await loadContext();
  renderHeader();
  renderHeroStats();
  renderConnections();
  renderProjectOptions();
  renderProjects();
  renderContext();
  setUploadOptions();
}

logoutButton?.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

projectSelect?.addEventListener('change', async (event) => {
  state.activeProjectId = event.target.value;
  persistActiveProject();
  await loadContext();
  renderHeroStats();
  renderProjectOptions();
  renderContext();
});

projectForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(projectForm);
  const payload = {
    title: String(formData.get('title') || '').trim(),
    editorUserId: String(formData.get('editorUserId') || '')
  };
  const { ok, data } = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Failed to create project', 'error');
    return;
  }
  setFlash('Project created.', 'success');
  projectForm.reset();
  await refreshAll();
  state.activeProjectId = data.project.id;
  persistActiveProject();
  await loadContext();
  renderHeroStats();
  renderProjectOptions();
  renderContext();
});

connectForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(connectForm);
  const payload = { creatorId: String(formData.get('creatorId') || '').trim().toUpperCase() };
  const { ok, data } = await api('/api/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Connection failed', 'error');
    return;
  }
  setFlash('Creator connected.', 'success');
  connectForm.reset();
  await refreshAll();
});

uploadForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const formData = new FormData(uploadForm);
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/upload`, {
    method: 'POST',
    body: formData
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Upload failed', 'error');
    return;
  }
  setFlash('Asset uploaded.', 'success');
  uploadForm.reset();
  setUploadOptions();
  await refreshAll();
});

briefInputForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const formData = new FormData(briefInputForm);
  const payload = {
    inputType: String(formData.get('inputType') || ''),
    content: String(formData.get('content') || '')
  };
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/brief-inputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Failed to save brief input', 'error');
    return;
  }
  setFlash('Brief input saved.', 'success');
  briefInputForm.reset();
  await refreshAll();
});

feedbackForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const formData = new FormData(feedbackForm);
  const payload = {
    versionLabel: String(formData.get('versionLabel') || ''),
    timestampSec: Number(formData.get('timestampSec') || 0),
    source: String(formData.get('source') || ''),
    text: String(formData.get('text') || '')
  };
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Failed to save feedback', 'error');
    return;
  }
  setFlash('Feedback added.', 'success');
  feedbackForm.reset();
  await refreshAll();
});

voiceForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const formData = new FormData(voiceForm);
  const contextType = String(formData.get('contextType') || '');
  if (contextType !== 'feedback') {
    formData.delete('versionLabel');
    formData.delete('timestampSec');
  }
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/voice-notes`, {
    method: 'POST',
    body: formData
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Voice note upload failed', 'error');
    return;
  }
  setFlash(data?.note || 'Voice note uploaded.', 'success');
  voiceForm.reset();
  await refreshAll();
});

generateBriefButton?.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Brief generation failed', 'error');
    return;
  }
  setFlash(data?.note || 'Brief generated.', 'success');
  await refreshAll();
});

generateChecklistButton?.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/ai/checklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Checklist generation failed', 'error');
    return;
  }
  setFlash(data?.note || 'Checklist generated.', 'success');
  await refreshAll();
});

generateSummaryButton?.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    setFlash('Select a project first.', 'error');
    return;
  }
  const { ok, data } = await api(`/api/projects/${state.activeProjectId}/ai/version-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Summary generation failed', 'error');
    return;
  }
  summaryOutput.innerHTML = `<pre>${escapeHtml(JSON.stringify(data.summary || data, null, 2))}</pre>`;
  setFlash(data?.note || 'Summary generated.', 'success');
});

projectsList?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const openProjectId = target.getAttribute('data-open-project');
  if (openProjectId) {
    state.activeProjectId = openProjectId;
    persistActiveProject();
    await loadContext();
    renderHeroStats();
    renderProjectOptions();
    renderContext();
    return;
  }

  const assetUrl = target.getAttribute('data-asset-url');
  const assetLabel = target.getAttribute('data-asset-label');
  if (assetUrl) {
    previewVideo.src = assetUrl;
    previewMeta.textContent = assetLabel || assetUrl;
    previewVideo.play().catch(() => {});
    return;
  }

  const projectId = target.getAttribute('data-save-assignment');
  if (projectId) {
    const select = document.querySelector(`[data-project-assignment="${projectId}"]`);
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    const { ok, data } = await api(`/api/projects/${projectId}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editorUserId: select.value })
    });
    if (!ok) {
      setFlash(data?.error?.message || 'Failed to update assignment', 'error');
      return;
    }
    setFlash('Assignment updated.', 'success');
    await refreshAll();
  }
});

checklistList?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const itemId = target.getAttribute('data-check-id');
  const status = target.getAttribute('data-check-status');
  if (!itemId || !status) {
    return;
  }
  const { ok, data } = await api(`/api/checklist/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!ok) {
    setFlash(data?.error?.message || 'Failed to update checklist item', 'error');
    return;
  }
  setFlash('Checklist updated.', 'success');
  await refreshAll();
});

(async () => {
  renderNav();
  await restoreSession();
  if (!ensurePageRole()) {
    return;
  }
  await refreshAll();
})().catch((error) => {
  setFlash(error instanceof Error ? error.message : 'Failed to initialize dashboard', 'error');
});
