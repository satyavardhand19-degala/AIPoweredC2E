const projectForm = document.getElementById('project-form');
const uploadForm = document.getElementById('upload-form');
const projectsEl = document.getElementById('projects');
const projectSelect = document.getElementById('project-select');
const previewVideo = document.getElementById('preview-video');
const previewMeta = document.getElementById('preview-meta');
const aiOutput = document.getElementById('ai-output');
const briefButton = document.getElementById('generate-brief');
const checklistButton = document.getElementById('generate-checklist');

let state = {
  projects: [],
  activeProjectId: null
};

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setActiveProject(projectId) {
  state.activeProjectId = projectId;
}

function renderProjectOptions() {
  const options = state.projects
    .map(
      (project) =>
        `<option value="${project.id}">${escapeHtml(project.title)} (${escapeHtml(project.creatorName)} -> ${escapeHtml(project.editorName)})</option>`
    )
    .join('');

  projectSelect.innerHTML = options || '<option value="">No projects yet</option>';

  if (state.projects.length && !state.activeProjectId) {
    setActiveProject(state.projects[0].id);
  }

  if (state.activeProjectId) {
    projectSelect.value = state.activeProjectId;
  }
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
    alert(`Failed to create project: ${err.error || 'Unknown error'}`);
    return;
  }

  projectForm.reset();
  await fetchProjects();
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);
  const projectId = String(formData.get('projectId') || '');

  if (!projectId) {
    alert('Select a project first.');
    return;
  }

  const res = await fetch(`/api/projects/${projectId}/upload`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const err = await res.json();
    alert(`Upload failed: ${err.error || 'Unknown error'}`);
    return;
  }

  setActiveProject(projectId);
  uploadForm.reset();
  projectSelect.value = projectId;
  await fetchProjects();
});

projectSelect.addEventListener('change', (event) => {
  setActiveProject(event.target.value);
});

projectsEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const openProjectId = target.getAttribute('data-open-project');
  if (openProjectId) {
    setActiveProject(openProjectId);
    renderProjectOptions();
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

briefButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    alert('Set an active project first.');
    return;
  }

  const res = await fetch(`/api/projects/${state.activeProjectId}/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Make hook punchy, big yellow captions, under 30s, end with CTA.' })
  });
  const data = await res.json();
  aiOutput.textContent = JSON.stringify(data, null, 2);
});

checklistButton.addEventListener('click', async () => {
  if (!state.activeProjectId) {
    alert('Set an active project first.');
    return;
  }

  const res = await fetch(`/api/projects/${state.activeProjectId}/ai/checklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feedback: [
        { timestamp: 14, note: 'Zoom looks laggy at this point' },
        { timestamp: 22, note: 'Change text wording here' },
        { timestamp: 28, note: 'Add CTA at the ending' }
      ]
    })
  });
  const data = await res.json();
  aiOutput.textContent = JSON.stringify(data, null, 2);
});

fetchProjects().catch((error) => {
  aiOutput.textContent = `Failed to initialize app: ${error.message}`;
});
