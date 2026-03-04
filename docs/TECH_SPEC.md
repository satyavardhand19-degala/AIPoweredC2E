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
- Pending:
  - Real AI provider integration
  - Voice-file upload -> STT pipeline
  - Auth and access control
  - Cloud DB/object storage migration

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
