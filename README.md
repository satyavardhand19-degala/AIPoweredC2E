# Creator-Editor AI Workflow (MVP)

Phase 1 baseline implementation for the hackathon problem statement.

## What is implemented
- Project creation for creator-editor pairs
- Video upload by version (`raw`, `v1`, `v2`)
- In-browser playback of uploaded assets
- Mock AI endpoints for structured brief and revision checklist generation

## Run locally
```bash
npm run dev
```

Then open `http://localhost:3000`.

## Storage
- Data: `data/db.json`
- Uploaded files: `uploads/`

## Next phase
- Replace mock AI endpoints with real provider calls
- Add timestamp comment persistence and checklist status flow
- Add role-based authentication and project access control
