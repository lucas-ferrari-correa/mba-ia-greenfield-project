---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-06T07:48:25-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-06T07:34:38-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-06T07:33:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-05T18:27:37-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of up to 10GB directly to object storage without passing bytes through the API — with automatic draft pre-registration, background processing (duration/metadata extraction and thumbnail generation from a frame) by a queue-driven video worker, a unique short URL per video, and streaming plus download — backed by object storage, a processing queue and a worker running in Docker Compose.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; used in owner routes (`GET /videos/:id`, `POST /videos/:id/upload/complete`, `DELETE /videos/:id`) and as storage key prefix (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`) |
| public_id | varchar(11) | unique, not null | 11-char base62 short ID generated with `node:crypto`; insert retried on unique violation (per `phase-03-videos/TD-11`); used in public routes (`GET /videos/:publicId/stream`, `GET /videos/:publicId/download`) |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Owning channel; owner = `channels.user_id` |
| title | varchar(100) | not null | Required in `POST /videos` body, persisted on the draft record (per `phase-03-videos/TD-02`) |
| status | enum `video_status` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Processing lifecycle `draft → processing → ready \| failed` (per `phase-03-videos/TD-13`); oversized upload goes `draft → failed` in `upload/complete` (per `phase-03-videos/TD-02` revision) |
| original_filename | varchar(255) | not null | File name declared at `POST /videos`; used in the download `Content-Disposition` (per `phase-03-videos/TD-12`) |
| content_type | varchar(50) | not null | One of `video/mp4`, `video/webm` (per `phase-03-videos/TD-12`) |
| declared_size_bytes | bigint | not null | Size declared at `POST /videos`; drives part count (per `phase-03-videos/TD-02`) |
| storage_key | varchar(255) | not null | `videos/{id}/original` (per `phase-03-videos/TD-04`) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; set on initiate, cleared after `CompleteMultipartUpload` or abort |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, set by the worker (per `phase-03-videos/TD-04`, `phase-03-videos/TD-10`) |
| duration_seconds | double precision | nullable | From ffprobe (per `phase-03-videos/TD-08` revision) |
| width | integer | nullable | From ffprobe video stream (per `phase-03-videos/TD-08` revision) |
| height | integer | nullable | From ffprobe video stream (per `phase-03-videos/TD-08` revision) |
| video_codec | varchar(50) | nullable | From ffprobe video stream `codec_name` (per `phase-03-videos/TD-08` revision) |
| size_bytes | bigint | nullable | Actual object size from `HeadObject` at `upload/complete` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08` revisions) |
| metadata | jsonb | nullable | Raw ffprobe JSON (`-show_format -show_streams`) (per `phase-03-videos/TD-08` revision) |
| processing_error | text | nullable | Set when status becomes `failed` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-13`) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, via `channel_id`); Channel → Video (one-to-many)
**Indexes:** `(public_id)` — unique, `(channel_id)` — FK lookup
**Notes:** TypeORM maps `bigint` to `string` in TypeScript — `declared_size_bytes` and `size_bytes` are typed `string` in the entity and converted explicitly where compared against the size limit.

#### Object storage layout (per `phase-03-videos/TD-04`)

| Object | Key | Writer | Readers |
|--------|-----|--------|---------|
| Original video | `videos/{id}/original` | Client via presigned multipart `UploadPart` URLs (per `phase-03-videos/TD-02`) | Worker via internal presigned GET (per `phase-03-videos/TD-09`); clients via public presigned GET (stream/download, per `phase-03-videos/TD-12`) |
| Thumbnail | `videos/{id}/thumbnail.jpg` | Worker (`PutObject`) | Owner via `thumbnail_url` in `GET /videos/:id` — public presigned GET, TTL `VIDEO_DOWNLOAD_URL_TTL_SECONDS` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`) |

Single private bucket; no anonymous bucket policy. Bucket created by a one-shot init service in Compose (per `phase-03-videos/TD-04`, `phase-03-videos/TD-14`).

### API Contracts

All request/response bodies use snake_case keys, matching the existing API (e.g., `refresh_token` in phase 02). Owner routes require `Authorization: Bearer <access_token>` (global `JwtAuthGuard`); public routes are marked `@Public()`.

**Rate limiting:** the global `ThrottlerGuard` (registered as `APP_GUARD` in `auth.module.ts`, `ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])`, per `phase-02-auth/TD-08`) applies to every route. `VideosController` overrides it at class level with `@Throttle({ default: { limit: 120, ttl: 60000 } })` — same per-controller override precedent as `@SkipThrottle()` on `app.controller.ts`. Every endpoint below may therefore also return `429 Too Many Requests` (see Error Catalog).

#### POST /videos (SI-03.4)

Pre-registers the video as `draft` and initiates the S3 multipart upload (per `phase-03-videos/TD-02`, `phase-03-videos/TD-13`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — 1–100 characters
- file_name: string, required — 1–255 characters
- size_bytes: integer, required — ≥ 1; must be ≤ `VIDEO_MAX_SIZE_BYTES` (default `10737418240`, per `phase-03-videos/TD-02`)
- content_type: string, required — one of `video/mp4`, `video/webm` (per `phase-03-videos/TD-12`)

**Response 201:**
- id: string (uuid)
- public_id: string (11-char base62)
- title: string
- status: `"draft"`
- upload: object
  - part_size: number — bytes per part (`VIDEO_UPLOAD_PART_SIZE_BYTES`, default `104857600` = 100 MiB)
  - part_count: number — `ceil(size_bytes / part_size)`
  - parts: array of `{ part_number: number, url: string }` — presigned `UploadPart` URLs signed with the public endpoint (per `phase-03-videos/TD-05`), one per part
  - expires_at: string (ISO-8601) — URLs expire after `VIDEO_UPLOAD_URL_TTL_SECONDS` (default `3600`, per `phase-03-videos/TD-02`)

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (missing/invalid field, `content_type` outside the allowlist)
- 401 Unauthorized: missing or invalid access token
- 413 VIDEO_TOO_LARGE: `size_bytes` exceeds `VIDEO_MAX_SIZE_BYTES`

---

#### GET /videos/:id/upload (SI-03.4)

Resume support: returns parts already stored (S3 `ListParts`) and fresh presigned URLs for the missing ones (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid)

**Response 200:**
- part_size: number
- part_count: number
- uploaded_parts: array of `{ part_number: number, etag: string, size: number }`
- parts: array of `{ part_number: number, url: string }` — only parts not yet uploaded
- expires_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `id` is not a UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another user's channel
- 409 INVALID_VIDEO_STATUS: video is not `draft`

---

#### POST /videos/:id/upload/complete (SI-03.5)

Completes the multipart upload, checks the actual size, moves the video to `processing` and enqueues the processing job (per `phase-03-videos/TD-06`, `phase-03-videos/TD-02` revision).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Path parameters:**
- id: string (uuid)

**Request body:**
- parts: array, required, 1–10000 items — each `{ part_number: integer ≥ 1, etag: string (non-empty) }`

**Response 202:**
- id: string (uuid)
- status: `"processing"`

**Behavior:**
- `draft` → `CompleteMultipartUpload` → `HeadObject`; if `ContentLength` > `VIDEO_MAX_SIZE_BYTES`: delete the object, set `failed` + `processing_error`, respond 413 `VIDEO_TOO_LARGE`, never enqueue. Otherwise persist `size_bytes`, clear `upload_id`, set `processing`, enqueue `process-video` with `jobId = id`.
- `processing` → idempotent: re-add the job with the same `jobId` (no duplicate) and respond 202.
- `ready` / `failed` → 409 `INVALID_VIDEO_STATUS`.

**Error responses:**
- 400 VALIDATION_ERROR: invalid body or `id` not a UUID
- 400 INVALID_UPLOAD_PARTS: storage rejects the part list (missing part, wrong ETag, part too small)
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 INVALID_VIDEO_STATUS
- 413 VIDEO_TOO_LARGE: actual stored size exceeds the limit (video is now `failed`)

---

#### GET /videos/:id (SI-03.6)

Owner status endpoint (per `phase-03-videos/TD-12` revision, `phase-03-videos/TD-11` revision).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid)

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- original_filename: string
- content_type: string
- size_bytes: number | null
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- thumbnail_url: string | null — presigned `GetObject` URL for `thumbnail_key`, signed with the public endpoint (per `phase-03-videos/TD-05`), TTL `VIDEO_DOWNLOAD_URL_TTL_SECONDS` (default `3600`); `null` while `thumbnail_key` is not set
- processing_error: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `id` is not a UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another user's channel

---

#### DELETE /videos/:id (SI-03.6)

Owner-initiated abort of an unfinished upload (per `phase-03-videos/TD-13`).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid)

**Response 204:** No content. Calls `AbortMultipartUpload` (when `upload_id` is set) and removes the video record.

**Error responses:**
- 400 VALIDATION_ERROR: `id` is not a UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 INVALID_VIDEO_STATUS: video is not `draft` (other statuses are not deletable through this path in Phase 03)

---

#### GET /videos/:publicId/stream (SI-03.9)

Public streaming entry point (per `phase-03-videos/TD-12`).

**Path parameters:**
- publicId: string — 11-char base62

**Response 302:**
- Location: presigned `GetObject` URL for `videos/{id}/original`, signed with the public endpoint (per `phase-03-videos/TD-05`), TTL `VIDEO_STREAM_URL_TTL_SECONDS` (default `21600` = 6h). Storage serves `Range` requests with `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `public_id`, or status is not `ready` (same response for everyone, owner included)

---

#### GET /videos/:publicId/download (SI-03.9)

Public download entry point (per `phase-03-videos/TD-12`).

**Path parameters:**
- publicId: string — 11-char base62

**Response 302:**
- Location: presigned `GetObject` URL with `ResponseContentDisposition: attachment; filename="<original_filename>"`, TTL `VIDEO_DOWNLOAD_URL_TTL_SECONDS` (default `3600` = 1h).

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `public_id`, or status is not `ready`

---

#### Validation Rules — videos

- `title`: required, string, trimmed length 1–100
- `file_name`: required, string, length 1–255
- `size_bytes`: required, integer ≥ 1 (upper bound checked in the service against `VIDEO_MAX_SIZE_BYTES` → `VIDEO_TOO_LARGE`)
- `content_type`: required, one of `video/mp4`, `video/webm`
- `parts`: required array, 1–10000 items; `part_number` integer 1–10000; `etag` non-empty string
- `:id`: UUID (`ParseUUIDPipe`)
- `:publicId`: must match `^[0-9A-Za-z]{11}$`; anything else → 404 `VIDEO_NOT_FOUND`

---

### Authorization Matrix

Base rule from `phase-03-videos/TD-12` revision: stream/download are public and respond only for `ready`; owner endpoints require authentication and ownership (video's `channel.user_id` = token `sub`). A non-owner on an owner endpoint receives the same 404 as a missing video (existence is not revealed).

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos | ✗ (401) | ✓ | — | Video is created in the caller's own channel |
| GET /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ | `draft` only |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ | |
| GET /videos/:id | ✗ (401) | ✗ (404) | ✓ | Any status |
| DELETE /videos/:id | ✗ (401) | ✗ (404) | ✓ | `draft` only |
| GET /videos/:publicId/stream | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) | `@Public()`; non-`ready` → 404 for all |
| GET /videos/:publicId/download | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) | `@Public()`; non-`ready` → 404 for all |

**Note — rate limiting:** all rows above are additionally subject to the class-level `@Throttle({ default: { limit: 120, ttl: 60000 } })` on `VideosController` (overrides the global 10 req/min `ThrottlerGuard`); exceeding it returns 429 regardless of the caller's role.

---

### Error Catalog

Error response format inherited from phase 02: `{ statusCode, error, message }`, `error` = domain code; validation errors use `VALIDATION_ERROR`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `id`/`public_id`; owner route called by a non-owner; stream/download of a video not in `ready` |
| INVALID_VIDEO_STATUS | 409 | Operation not allowed in the current video status | `GET /videos/:id/upload` or `DELETE /videos/:id` on a non-`draft` video; `upload/complete` on `ready`/`failed` |
| VIDEO_TOO_LARGE | 413 | Video exceeds the maximum allowed size | `POST /videos` with `size_bytes` > limit; `upload/complete` when the stored object exceeds the limit (video set to `failed`) |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid or incomplete | `upload/complete` when storage rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| — (`ThrottlerException`) | 429 | Too Many Requests | Any `VideosController` route above 120 requests / 60 s per tracker (class-level `@Throttle` override of the global `ThrottlerGuard`); emitted by `@nestjs/throttler`, not a domain exception |

Worker-side failures are not HTTP errors: they are persisted as `status = 'failed'` with `processing_error` (see Events/Messages).

---

### Events/Messages

#### process-video (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (idempotent enqueue), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: { age: 604800 }` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-13`)
**Producer:** `VideosService` in the API, inside `POST /videos/:id/upload/complete` after the video is set to `processing` (per `phase-03-videos/TD-06`)
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')` extending `WorkerHost`) in the `video-worker` process (per `phase-03-videos/TD-07`)
**Trigger:** successful multipart completion with actual size within the limit
**Delivery semantics:** at-least-once — processor is idempotent (re-running overwrites metadata and thumbnail) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-13`)

**Processing steps (consumer):**
1. Load the video; if it is not `processing`, finish the job without changes.
2. Presign an internal `GetObject` URL (TTL `VIDEO_WORKER_READ_URL_TTL_SECONDS`, default `900`) and run `ffprobe -v error -print_format json -show_format -show_streams <url>` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`).
3. No video stream, or ffprobe cannot read the file → throw `UnrecoverableError` (no retries) (per `phase-03-videos/TD-13`).
4. Thumbnail: `ffmpeg -ss <duration × 0.10, or 0 when no duration> -i <url> -frames:v 1` scaled to max width 1280 px, JPEG, `PutObject` to `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-10`).
5. Persist `duration_seconds`, `width`, `height`, `video_codec`, `metadata`, `thumbnail_key`, set `ready`.

**Final failure (decided inside `process()`):** the processor wraps steps 2–5 in `try/catch`. In the `catch`, if the error is an `UnrecoverableError` **or** `job.attemptsMade + 1 >= job.opts.attempts` (this is the last attempt), it persists `status = 'failed'` and `processing_error` (error message) **before** rethrowing; otherwise it rethrows without touching the video so BullMQ retries with backoff. The worker `failed` event is **not** used for persistence — it fires on every failed attempt and is not awaited. Transient errors (network, storage) are retried with backoff.

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
