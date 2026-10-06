---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-06T07:48:25-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-06T07:33:32-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Oversized upload: API rejects at complete (TD-02) vs worker fails it (TD-13)"
    resolved_by: "phase-03-videos/TD-02, phase-03-videos/TD-06, phase-03-videos/TD-13 (revisions)"
  - id: AMB-1
    status: resolved
    summary: "Identifier in owner endpoints undefined (`:id` UUID vs public_id)"
    resolved_by: "phase-03-videos/TD-11 (revision)"
  - id: AMB-2
    status: resolved
    summary: "Owner stream/download response for draft/failed (no playable object)"
    resolved_by: "phase-03-videos/TD-12 (revision)"
  - id: AMB-3
    status: resolved
    summary: "TD-02 upload policy values still marked 'to be confirmed'"
    resolved_by: "phase-03-videos/TD-02 (revision)"
  - id: AMB-4
    status: resolved
    summary: "Presigned GET TTL for stream/download not fixed (TD-12)"
    resolved_by: "phase-03-videos/TD-12, phase-03-videos/TD-09 (revisions)"
  - id: AMB-5
    status: resolved
    summary: "Which video metadata fields are extracted and persisted is undefined"
    resolved_by: "phase-03-videos/TD-08 (revision)"
  - id: MD-1
    status: resolved
    summary: "No library/image pins for new libs (BullMQ, AWS SDK, Redis, MinIO)"
    resolved_by: "phase-03-videos/TD-01, TD-03, TD-07, TD-08, TD-14 (Libraries) + library-refs.md"
  - id: DG-1
    status: resolved
    summary: "TD-12 needs optional auth on public routes; inherited guard lacks it"
    resolved_by: "phase-03-videos/TD-12 (revision)"
  - id: IC-2
    status: resolved
    summary: "TD-14 Detail recommends Option A but Decision is B; divergence Note missing"
    resolved_by: "clarification — TD-14 **Note:** carried into context.md Decisions Detail"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI Inventory deferred — check not applicable.)_

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-02, TD-06, TD-13 — revisions)_ — Oversized upload: single owner is the API. In `upload/complete`, after `HeadObject`, if the real size exceeds the limit: delete object, video `failed` + `processing_error`, 4xx, never enqueued; worker no longer validates size ("size above limit" removed from TD-13).
- **AMB-1** _(resolved_by phase-03-videos/TD-11 — revision)_ — Owner routes (`GET /videos/:id`, `POST /videos/:id/upload/complete`, `DELETE /videos/:id`) use the UUID; public routes (`GET /videos/:publicId/stream|download`) use `public_id`.
- **AMB-2** _(resolved_by phase-03-videos/TD-12 — revision)_ — Stream/download public and respond only in `ready`; `draft|processing|failed` → `404` for everyone, owner included. Owner follows status via authenticated `GET /videos/:id`.
- **AMB-3** _(resolved_by phase-03-videos/TD-02 — revision)_ — Policy values confirmed: max `10 GiB` (`10737418240` bytes, env), part `100 MiB`, upload part URL TTL `1h` (re-requestable on resume). "to be confirmed" removed.
- **AMB-4** _(resolved_by phase-03-videos/TD-12, TD-09 — revisions)_ — Env-configurable TTLs: stream `6h`, download `1h`, worker read `15min`.
- **AMB-5** _(resolved_by phase-03-videos/TD-08 — revision)_ — Columns `duration_seconds`, `width`, `height`, `video_codec`, `size_bytes`; raw ffprobe JSON in `metadata jsonb`.
- **MD-1** _(resolved_by phase-03-videos/TD-01, TD-03, TD-07, TD-08, TD-14 Libraries + library-refs.md)_ — Reclassified on user confirmation: not a missing strategic decision but missing version pins (the libraries were already chosen by decided TDs), so resolved in this stage instead of the phase-mode `/research` abort. Pins via context7 + npm registry; images verified by real `docker pull`. TD-14 changed A → B (with **Note**): `minio/minio` and `minio/mc` no longer exist on Docker Hub; `coollabsio/minio:RELEASE.2025-10-15T17-29-55Z` (bundles `mc`) adopted. Redis `8.10.2` with `maxmemory-policy noeviction`.
- **DG-1** _(resolved_by phase-03-videos/TD-12 — revision)_ — Optional authentication no longer needed: with AMB-2's rule, stream/download are plain public routes; the inherited phase-02 guard is unchanged.
- **IC-2** _(resolved_by clarification — TD-14 Note carried into Decisions Detail)_ — TD-14 Detail showed the Option A Recommendation while the Decision is B. Resolved with option (a): the TD-14 `**Note:**` (official `minio/minio`/`minio/mc` removed from Docker Hub; `coollabsio/minio:RELEASE.2025-10-15T17-29-55Z` adopted, dev/test only) was carried into the `## Decisions Detail` block of context.md, matching the phase-02 precedent (TD-02/TD-09). Decisions doc unchanged.
