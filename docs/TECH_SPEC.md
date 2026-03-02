# Technical Spec (MVP)

## Stack
- Frontend: Next.js + TypeScript + Tailwind
- Backend: Next.js API routes
- DB: PostgreSQL + Prisma
- File storage: S3-compatible object storage
- AI services:
  - Speech-to-text for voice notes
  - LLM for brief extraction, feedback summarization, version diff summary

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
