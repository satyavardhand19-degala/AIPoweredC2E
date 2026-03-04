# Creator-Editor AI Workflow (MVP)

Phase 2 workflow implementation for the hackathon problem statement.

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

## API surface (MVP)
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

## Storage
- Data: `data/db.json`
- Uploaded files: `uploads/`

## Next phase
- Replace heuristic AI placeholder logic with real LLM/STT provider calls
- Add role-based authentication and project-level access control
- Add cloud object storage and database backend for deployment
