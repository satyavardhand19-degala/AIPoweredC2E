# Creator-Editor AI Workflow

This project is a lightweight web app for short-form video teams. A creator and an editor can collaborate inside one workspace instead of passing briefs, drafts, and feedback across chat apps and shared drives.

The app covers the full MVP flow:

1. A creator and editor create accounts.
2. The editor connects to a creator using a Creator ID.
3. The creator creates a project and uploads the `raw` video.
4. The creator adds brief inputs as text, URL, or voice note.
5. AI turns those inputs into a structured editing brief.
6. The editor uploads `v1`, the creator leaves timestamped feedback, and AI turns that into a checklist.
7. The editor uploads `v2`, and AI generates a summary with a publish-readiness score.

## Main Features

- Role-based product flow with separate creator and editor dashboards
- Session authentication with CSRF protection
- Creator ID / Editor ID connection model
- Project workspaces with role-aware access control
- Versioned media uploads: `raw`, `v1`, `v2`
- Voice note upload and transcription support
- AI brief generation, revision checklist generation, and version summary generation
- Audit logs, request metrics, health endpoints, and rate limiting
- Pluggable backends for state storage, object storage, sessions, and rate limiting

## Tech Stack

- Frontend: vanilla HTML, CSS, and JavaScript in [`public/`](/mnt/d/projects_files/bulidathon/public)
- API server: Node.js HTTP server in [`server.mjs`](/mnt/d/projects_files/bulidathon/server.mjs)
- Background worker: BullMQ-based worker in [`worker.mjs`](/mnt/d/projects_files/bulidathon/worker.mjs)
- State persistence: SQLite by default, optional JSON or PostgreSQL
- File storage: local filesystem by default, optional S3-compatible object storage
- Queue/session/rate limiting scale-out: optional Redis

## Project Layout

```text
.
|-- server.mjs                 # Main HTTP server and API routes
|-- worker.mjs                 # Async AI job worker
|-- lib/                       # Storage, queue, session, and rate limit adapters
|-- public/                    # Login, register, and dashboard UI
|-- test/                      # Node test suite
|-- scripts/                   # Smoke tests, backups, env checks
|-- docs/                      # Scope, tech spec, readiness notes
|-- Dockerfile
|-- docker-compose.yml
|-- k8s/
`-- .env.example
```

## How the App Works

### Roles

- `creator`: creates projects, uploads `raw`, submits briefs, gives feedback
- `editor`: connects to creators, uploads `v1` and `v2`, works through checklist items

### Key Screens

- `/register`: sign up as creator or editor
- `/login`: sign in
- `/creator-dashboard`: creator workspace
- `/editor-dashboard`: editor workspace

### Important API Areas

- Auth: `/api/auth/register`, `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`
- Connections: `/api/connections`
- Projects: `/api/projects`, `/api/projects/:id/context`
- Uploads: `/api/projects/:id/upload`
- Brief inputs and AI brief: `/api/projects/:id/brief-inputs`, `/api/projects/:id/ai/brief`
- Feedback and checklist: `/api/projects/:id/comments`, `/api/projects/:id/ai/checklist`, `/api/checklist/:id`
- Final summary: `/api/projects/:id/ai/version-summary`
- Operations: `/api/health`, `/api/metrics`

## Local Development

### Requirements

- Node.js 24 or another recent Node version with native `fetch`, `FormData`, and `node:test`
- npm

### Install

```bash
npm install
```

### Configure

Copy the example environment file and update values as needed:

```bash
cp .env.example .env
```

For local development, the defaults are enough in most cases:

- `DATA_BACKEND=sqlite`
- `OBJECT_STORE_BACKEND=local`
- `RATE_LIMIT_BACKEND=in-process`
- `SESSION_BACKEND=in-process`
- `ENABLE_ASYNC_JOBS=0`

AI keys are optional. If no provider key is configured, the app falls back to deterministic heuristic responses for the AI endpoints.

### Run the Server

```bash
npm run dev
```

Open `http://127.0.0.1:3000/login`.

## Running with Async Jobs

The worker is only needed when `ENABLE_ASYNC_JOBS=1`. In that mode, Redis is required and AI tasks are processed through the queue instead of inline in the server.

Run the server:

```bash
npm run dev
```

Run the worker in another terminal:

```bash
node worker.mjs
```

## Environment Variables

### Core Server

- `PORT`, `HOST`, `NODE_ENV`
- `ENABLE_REQUEST_LOGS=1` to emit JSON request logs

### Backend Selection

- `DATA_BACKEND=sqlite|json|postgres`
- `OBJECT_STORE_BACKEND=local|s3`
- `RATE_LIMIT_BACKEND=in-process|redis`
- `SESSION_BACKEND=in-process|redis`
- `ENABLE_ASYNC_JOBS=0|1`

### PostgreSQL

Used when `DATA_BACKEND=postgres`:

- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_SSL`
- `POSTGRES_MAX_CONNECTIONS`
- or `DATABASE_URL`

### S3-Compatible Storage

Used when `OBJECT_STORE_BACKEND=s3`:

- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_ENDPOINT`

### Redis

Used when Redis-backed rate limiting, sessions, or async jobs are enabled:

- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_PASSWORD`

### AI Provider

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_STT_MODEL`

## Data and Storage Behavior

- Default local state is stored in `data/app_state.db`
- Legacy/simple JSON mode stores state in `data/db.json`
- Local uploads are stored in `uploads/`
- The server creates missing `data/` and `uploads/` directories on startup

## Testing

Run the main automated tests:

```bash
npm test
```

Security smoke test:

```bash
npm run test:security
```

Workflow smoke test:

```bash
npm run test:workflow
```

The workflow smoke test exercises the main happy path: registration, connection, project creation, uploads, AI brief generation, checklist generation, and final summary.

## Docker and Compose

### Docker

Build and run the application container:

```bash
docker build -t creator-editor-app .
docker run --rm -p 3000:3000 creator-editor-app
```

### Docker Compose

[`docker-compose.yml`](/mnt/d/projects_files/bulidathon/docker-compose.yml) starts:

- PostgreSQL
- Redis
- the API server
- the async worker

This is the easiest way to run the production-shaped stack locally.

## Kubernetes

The [`k8s/`](/mnt/d/projects_files/bulidathon/k8s) folder contains starter manifests for:

- deployment
- service
- example secrets

The deployment expects PostgreSQL, S3-compatible storage, Redis, and the worker-based async mode.

## Useful Docs

- [`docs/PROJECT_SCOPE.md`](/mnt/d/projects_files/bulidathon/docs/PROJECT_SCOPE.md): problem statement and MVP scope
- [`docs/TECH_SPEC.md`](/mnt/d/projects_files/bulidathon/docs/TECH_SPEC.md): implementation details and architecture direction
- [`docs/PRODUCTION_READINESS.md`](/mnt/d/projects_files/bulidathon/docs/PRODUCTION_READINESS.md): deployment and readiness notes
- [`docs/SESSION_STATE.md`](/mnt/d/projects_files/bulidathon/docs/SESSION_STATE.md): session-related notes
- [`docs/WORKLOG.md`](/mnt/d/projects_files/bulidathon/docs/WORKLOG.md): build history and checkpoints

## Notes for New Developers

- Start with [`server.mjs`](/mnt/d/projects_files/bulidathon/server.mjs) to understand the request lifecycle and API surface.
- Read [`public/dashboard.js`](/mnt/d/projects_files/bulidathon/public/dashboard.js) to see how the frontend calls the API and renders project context.
- Check [`lib/state_store.mjs`](/mnt/d/projects_files/bulidathon/lib/state_store.mjs), [`lib/object_store.mjs`](/mnt/d/projects_files/bulidathon/lib/object_store.mjs), and [`lib/session_store.mjs`](/mnt/d/projects_files/bulidathon/lib/session_store.mjs) for the backend abstraction points.
- Use [`scripts/env_check.mjs`](/mnt/d/projects_files/bulidathon/scripts/env_check.mjs) when switching from local defaults to Postgres, Redis, or S3.
