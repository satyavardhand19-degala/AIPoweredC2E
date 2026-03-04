# Creator-Editor AI Workflow (MVP)

Phase 3.1 workflow implementation with authentication and access control.

## What is implemented
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
- Project-level access control on API + uploaded media
- Role restrictions:
  - creator: create projects, upload `raw`
  - editor: upload `v1`/`v2`, update checklist status

## API surface (MVP)
- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id/context`
- `POST /api/projects/:id/upload`
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

Then open `http://localhost:3000`.

## Environment
Copy `.env.example` to `.env` and set values as needed.

- `OPENAI_API_KEY` (optional): enables real model generation for brief/checklist/summary endpoints.
- `OPENAI_MODEL` (optional): defaults to `gpt-4.1-mini`.
- If no API key is present or provider call fails, endpoints automatically fall back to heuristic logic.

## Storage
- Data: `data/db.json`
- Uploaded files: `uploads/`

## Next phase
- Replace heuristic AI placeholder logic with real LLM/STT provider calls
- Add voice-note file upload + speech-to-text pipeline
- Add cloud object storage and database backend for deployment
