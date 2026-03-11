# Creator-Editor AI Workflow (MVP)

Phase 3.4 persistence abstraction with pluggable state/object stores.

## What is implemented
- Registration + login with password-based sessions
- Role-specific Creator ID / Editor ID for creator-editor connections
- Separate login, register, creator dashboard, and editor dashboard pages
- Project creation for creator-editor pairs
- Video upload by version (`raw`, `v1`, `v2`)
- In-browser playback of uploaded assets
- Brief input persistence (`text`, `voice`, `url`)
- AI brief generation endpoint with persisted outputs
- Timestamp feedback persistence for draft versions
- AI checklist generation with persisted checklist items
- Checklist status updates (`todo`, `in_progress`, `done`)
- V1 -> V2 summary endpoint with publish readiness score
- Project context endpoint for complete workflow state
- Session-based login/logout (`creator` or `editor`)
- Role-protected dashboard routes (`/creator-dashboard`, `/editor-dashboard`)
- Editor-to-creator connection flow via Creator ID
- Project-level access control on API + uploaded media
- Role restrictions:
  - creator: create projects, upload `raw`
  - editor: upload `v1`/`v2`, update checklist status
- Voice-note upload + transcription pipeline
- Auto-attach voice transcript into:
  - `briefInputs` when context is `brief`
  - `comments` when context is `feedback`
- CSRF protection for mutating API routes
- Basic in-memory API rate limiting
- Persisted audit logs for sensitive mutating actions
- Observability baseline:
  - `X-Request-Id` on responses
  - lightweight in-memory request telemetry
  - enriched `/api/health` payload (uptime, storage backend, counters)

## API surface (MVP)
- `GET /api/auth/me`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET/POST /api/connections`
- `GET /api/projects`
- `POST /api/projects`
- `PATCH /api/projects/:id/assignment`
- `GET /api/projects/:id/context`
- `GET /api/projects/:id/audit-logs`
- `POST /api/projects/:id/upload`
- `POST/GET /api/projects/:id/voice-notes`
- `POST/GET /api/projects/:id/brief-inputs`
- `POST /api/projects/:id/ai/brief`
- `GET /api/projects/:id/brief/latest`
- `POST/GET /api/projects/:id/comments`
- `POST /api/projects/:id/ai/checklist`
- `GET /api/projects/:id/checklist`
- `PATCH /api/checklist/:id`
- `POST /api/projects/:id/ai/version-summary`

## Run locally
```bash
npm run dev
```

Then open `http://localhost:3000/login`.

## Environment
Copy `.env.example` to `.env` and set values as needed.

- `OPENAI_API_KEY` (optional): enables real model generation for brief/checklist/summary endpoints.
- `OPENAI_MODEL` (optional): defaults to `gpt-4.1-mini`.
- `OPENAI_STT_MODEL` (optional): defaults to `gpt-4o-mini-transcribe`.
- `RATE_LIMIT_MAX` and `RATE_LIMIT_AUTH_MAX` tune in-memory API throttling.
- `DATA_BACKEND` controls state persistence (`sqlite` default, `json` optional).
- `OBJECT_STORE_BACKEND` controls upload persistence (`local` currently supported).
- `ENABLE_REQUEST_LOGS=1` enables JSON request logs to stdout.
- If no API key is present or provider call fails, endpoints automatically fall back to heuristic logic.

## Security smoke test
```bash
npm run test:security
```

## Workflow smoke test
```bash
npm run test:workflow
```

## Storage
- State store: `sqlite` by default at `data/app_state.db` (auto-imports from `data/db.json` on first run)
- Optional state backend: `json` at `data/db.json` via `DATA_BACKEND=json`
- Object store: local filesystem at `uploads/` (via object-store adapter)

## Next phase
- Add managed DB/object-storage adapters behind the same interfaces
- Add production security hardening (distributed rate limits, session policy, audit logs)
- Add automated test coverage and CI pipeline
