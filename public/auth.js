const form = document.getElementById('auth-form');
const statusEl = document.getElementById('auth-status');
const mode = form?.dataset.mode || 'login';

function setStatus(message, type = '') {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
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

async function redirectIfAuthenticated() {
  const { ok, data } = await api('/api/auth/me', {
    method: 'GET',
    headers: {}
  });
  if (ok && data?.user?.role) {
    window.location.href = data.user.role === 'creator' ? '/creator-dashboard' : '/editor-dashboard';
  }
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');

    const formData = new FormData(form);
    const payload =
      mode === 'register'
        ? {
            name: String(formData.get('name') || '').trim(),
            email: String(formData.get('email') || '').trim(),
            password: String(formData.get('password') || ''),
            role: String(formData.get('role') || '')
          }
        : {
            identifier: String(formData.get('identifier') || '').trim(),
            password: String(formData.get('password') || ''),
            role: String(formData.get('role') || '')
          };

    const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
    }

    try {
      const { ok, data } = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!ok) {
        const detail = Array.isArray(data?.error?.details) ? data.error.details.join(' ') : data?.error?.message || 'Request failed';
        setStatus(detail, 'error');
        return;
      }

      const redirectTo = data?.redirectTo || (data?.user?.role === 'creator' ? '/creator-dashboard' : '/editor-dashboard');
      setStatus(mode === 'register' ? 'Account created. Redirecting...' : 'Login successful. Redirecting...', 'success');
      window.location.href = redirectTo;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Request failed', 'error');
    } finally {
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
      }
    }
  });
}

redirectIfAuthenticated().catch(() => {});
