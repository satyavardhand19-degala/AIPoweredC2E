# Production Readiness Snapshot

Last Updated: 2026-03-04

## Current Maturity
- Product stage: working MVP + connected workflow
- Quality stage: hackathon/demo ready
- Production stage: not yet

## What Is Production-Useful Already
1. Core product flow exists end-to-end:
- project creation
- raw/v1/v2 uploads
- preview playback
- brief input -> AI brief
- timestamp feedback -> AI checklist
- checklist state transitions
- v1->v2 summary
2. API boundaries are clean enough to keep while swapping internals.
3. AI integration is behind stable endpoints with fallback behavior.
4. Basic data-consistency protection is implemented (serialized DB mutations).
5. Basic session auth and project-level authorization are implemented.
6. Voice-note upload and baseline STT pipeline are implemented with fallback behavior.
7. Baseline CSRF protection and in-memory API rate limiting are implemented.

## Critical Gaps Before Production
1. Data and storage:
- local JSON file (`data/db.json`)
- local filesystem uploads (`uploads/`)
2. AI and media pipeline:
- no async worker queue
- STT exists but is synchronous and not worker-backed
3. Security:
- in-memory rate limiting only (not distributed)
- baseline CSRF/session hardening exists but needs stronger production policy
- no audit logging
4. Reliability/observability:
- no structured logs/metrics/tracing
- no error alerting
- no backup/restore strategy
5. Test coverage:
- no automated unit/integration/e2e suites

## Production Readiness Plan (Ordered)
1. Platform foundation:
- PostgreSQL + managed object storage
- migration scripts
2. Identity/security hardening:
- upgrade auth to production-grade identity provider
- secure cookie policy by environment + session rotation + revocation strategy
3. Async workloads:
- queue + worker for AI/media tasks
- retry + idempotency handling
4. AI media features:
- harden speech-to-text pipeline for large/long audio and retry behavior
- provider error handling and timeouts
5. Reliability:
- structured logs + health checks + monitoring dashboards
- deployment config and secrets management
6. QA and release:
- API integration tests
- core workflow e2e tests
- staging + production rollout checklist
