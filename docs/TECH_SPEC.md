# Technical Spec (MVP)

## Stack
- Frontend: Vanilla HTML/CSS/JS (mobile-first)
- Backend: Node.js HTTP server (`server.mjs`)
- DB: Local JSON file (`data/db.json`) for MVP velocity
- File storage: Local filesystem (`uploads/`)
- AI services:
  - Speech-to-text for voice notes
  - LLM for brief extraction, feedback summarization, version diff summary

## Current Implementation Status
- Implemented:
  - Project CRUD (create/list)
  - Versioned asset upload (`raw`, `v1`, `v2`)
  - Browser playback of uploaded videos
  - Brief input persistence (`text`, `voice`, `url`)
  - AI brief generation with persisted brief objects
  - Timestamped comments persistence
  - AI checklist generation + checklist status transitions
  - V1 -> V2 summary endpoint with readiness scoring
  - Project context endpoint for full state hydration
  - Serialized DB mutation queue to avoid lost updates on concurrent writes
  - Session auth endpoints (`/api/auth/login`, `/api/auth/me`, `/api/auth/logout`)
  - Project-level access control enforcement on API and uploaded media routes
  - Role-based action constraints:
    - creator creates projects and uploads `raw`
    - editor uploads `v1`/`v2` and updates checklist item status
  - CSRF token enforcement on mutating API routes
  - In-memory request rate limiting (global API + auth login bucket)
  - Voice-note upload + transcript pipeline:
    - `POST/GET /api/projects/:id/voice-notes`
    - optional OpenAI STT (`/v1/audio/transcriptions`)
    - fallback transcript generation
    - transcript auto-attached to brief inputs/comments
  - Optional OpenAI provider integration (`/v1/responses`) for:
    - structured brief generation
    - revision checklist generation
    - version summary generation
  - Automatic heuristic fallback when `OPENAI_API_KEY` is not configured or provider output fails validation
- Pending:
  - Cloud DB/object storage migration
  - Security hardening (audit trail, stronger CSRF/session policy, distributed rate limiting)

## Core Entities
- User (creator/editor)
- Project
- Asset (video/audio docs with version labels)
- Brief input + structured brief
- Timestamp comment
- Checklist item
- AI run log

## Primary Workflows
1. Creator creates project and uploads raw video.
2. Creator submits brief inputs (voice/text/url).
3. AI outputs structured editing brief.
4. Editor uploads V1 draft.
5. Creator gives timestamped feedback.
6. AI generates prioritized actionable checklist.
7. Editor addresses checklist and uploads V2.
8. AI summarizes V1 -> V2 improvements and readiness.

## AI Quality Rules
- AI output must be schema-constrained JSON.
- All AI-generated tasks should include rationale + priority.
- Feedback aggregation must deduplicate overlaps across text/voice/timestamps.
