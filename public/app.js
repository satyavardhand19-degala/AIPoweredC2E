const projectForm = document.getElementById('project-form');
const uploadForm = document.getElementById('upload-form');
const briefInputForm = document.getElementById('brief-input-form');
const feedbackForm = document.getElementById('feedback-form');

const projectSelect = document.getElementById('project-select');
const activeProjectMeta = document.getElementById('active-project-meta');
const projectsEl = document.getElementById('projects');
const checklistEl = document.getElementById('checklist');
const previewVideo = document.getElementById('preview-video');
const previewMeta = document.getElementById('preview-meta');

const aiOutput = document.getElementById('ai-output');
const summaryOutput = document.getElementById('summary-output');

const briefButton = document.getElementById('generate-brief');
const checklistButton = document.getElementById('generate-checklist');
const summaryButton = document.getElementById('generate-summary');

let state = {
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
  if (!state.projects.length) {
    projectsEl.innerHTML = '<p class="meta">No projects yet. Create one above.</p>';
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

  if (!items.length) {
    checklistEl.innerHTML = '<p class="meta">No checklist items yet. Add feedback and generate checklist.</p>';
    return;
  }

  checklistEl.innerHTML = items
    .map((item) => {
      return `
        <div class="check-item ${item.status === 'done' ? 'is-done' : ''}">
          <div>
            <div><strong>[${escapeHtml(item.priority)}]</strong> ${escapeHtml(item.title)}</div>
            <div class="meta">At ${formatTime(item.timestampSec)} | Owner: ${escapeHtml(item.owner)} | Status: ${escapeHtml(item.status)}</div>
            <div class="meta">${escapeHtml(item.details || '')}</div>
          </div>
          <div class="actions">
            <button data-item-id="${item.id}" data-item-status="todo">todo</button>
            <button data-item-id="${item.id}" data-item-status="in_progress">in progress</button>
            <button data-item-id="${item.id}" data-item-status="done">done</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderContextDebug() {
  if (!state.context) {
    aiOutput.textContent = 'No project context loaded.';
    return;
  }

  const latestBrief = state.context.briefs?.[0] || null;
  const latestComments = state.context.comments?.slice(0, 5) || [];

  aiOutput.textContent = JSON.stringify(
    {
      latestBrief,
      recentComments: latestComments,
      checklistCount: state.context.checklistItems?.length || 0
    },
    null,
    2
  );
}

async function fetchProjects() {
  const res = await fetch('/api/projects');
  const data = await res.json();
  state.projects = data.projects || [];

  if (state.activeProjectId && !state.projects.some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = null;
  }

  renderProjectOptions();
  renderProjects();
}

async function fetchContext() {
  if (!state.activeProjectId) {
    state.context = null;
    renderChecklist();
    renderContextDebug();
    return;
  }

  const res = await fetch(`/api/projects/${state.activeProjectId}/context`);
  if (!res.ok) {
    state.context = null;
    renderChecklist();
    renderContextDebug();
    return;
  }

  state.context = await res.json();
  renderChecklist();
  renderContextDebug();
}

async function refreshAll() {
  await fetchProjects();
  await fetchContext();
}

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(projectForm);

  const payload = {
    title: String(formData.get('title') || ''),
    creatorName: String(formData.get('creatorName') || ''),
    editorName: String(formData.get('editorName') || '')
  };

  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json();
    notifyError(`Failed to create project: ${err.error || 'Unknown error'}`);
    return;
  }

  const created = await res.json();
  setActiveProject(created.project.id);
  projectForm.reset();
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

  const res = await fetch(`/api/projects/${state.activeProjectId}/upload`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const err = await res.json();
    notifyError(`Upload failed: ${err.error || 'Unknown error'}`);
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
    createdBy: String(formData.get('createdBy') || ''),
    content: String(formData.get('content') || '')
  };

  const res = await fetch(`/api/projects/${state.activeProjectId}/brief-inputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json();
    notifyError(`Failed to save brief input: ${err.error || 'Unknown error'}`);
    return;
  }

  briefInputForm.reset();
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
    authorRole: String(formData.get('authorRole') || ''),
    text: String(formData.get('text') || '')
  };

  const res = await fetch(`/api/projects/${state.activeProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json();
    notifyError(`Failed to add feedback: ${err.error || 'Unknown error'}`);
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

  const res = await fetch(`/api/checklist/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });

  if (!res.ok) {
    const err = await res.json();
    notifyError(`Failed to update checklist item: ${err.error || 'Unknown error'}`);
    return;
  }

  await refreshAll();
});

briefButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const res = await fetch(`/api/projects/${state.activeProjectId}/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const data = await res.json();
  aiOutput.textContent = JSON.stringify(data, null, 2);
  await refreshAll();
});

checklistButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const res = await fetch(`/api/projects/${state.activeProjectId}/ai/checklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const data = await res.json();
  aiOutput.textContent = JSON.stringify(data, null, 2);
  await refreshAll();
});

summaryButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    notifyError('Select an active project first.');
    return;
  }

  const res = await fetch(`/api/projects/${state.activeProjectId}/ai/version-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  const data = await res.json();
  summaryOutput.textContent = JSON.stringify(data, null, 2);
  await refreshAll();
});

refreshAll().catch((error) => {
  aiOutput.textContent = `Failed to initialize app: ${error.message}`;
});
