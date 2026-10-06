---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete Test Plan

## Application Overview

`POST /videos/:id/upload/complete` finishes the S3 multipart upload, checks the real object size (API is the single owner of the size-limit check), moves the video to `processing` and enqueues the `process-video` job with `jobId = videoId`. Repeating the call while `processing` is idempotent; oversized objects are deleted and the video ends `failed` without ever reaching the queue.

## Test Scenarios

### 1. Completing an upload

**Setup:** `beforeEach` cleans the test DB and clears `ThrottlerStorageService.storage`; app bootstrapped from `AppModule` with `main.ts` globals; env overrides before bootstrap: `S3_PUBLIC_ENDPOINT=http://minio:9000`, `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`, `QUEUE_PREFIX=test-<random>` (isolated prefix so the Compose `video-worker` never consumes these jobs); the queue is inspected through `app.get(getQueueToken('video-processing'))`. Helper: create a draft via POST /videos and PUT each part to its presigned URL, collecting `ETag`s.

#### 1.1. completes-and-enqueues

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Create a draft with `size_bytes: 11534336` and upload its 3 parts
  2. POST /videos/<id>/upload/complete with `{ parts: [{ part_number, etag }, ...] }` and the owner's token
    - expect: status `202`
    - expect: body `{ id: <id>, status: "processing" }`
  3. Query the video row
    - expect: `status = 'processing'`, `size_bytes = 11534336`, `upload_id` is null
  4. `queue.getJob(<id>)`
    - expect: a job named `process-video` with `data.videoId = <id>` exists

#### 1.2. repeated-complete-is-idempotent

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Complete a fully uploaded draft (as in 1.1)
  2. POST /videos/<id>/upload/complete again with the same body
    - expect: status `202` with `status: "processing"`
  3. Count jobs in the queue whose `data.videoId = <id>`
    - expect: exactly `1`

#### 1.3. rejects-invalid-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Create a draft and upload its 3 parts
  2. POST /videos/<id>/upload/complete with the `etag` of part 2 replaced by `"\"deadbeef\""`
    - expect: status `400`
    - expect: body `error: "INVALID_UPLOAD_PARTS"`
  3. Query the video row
    - expect: `status = 'draft'` and `upload_id` unchanged
  4. Inspect the queue
    - expect: no job for `<id>`

#### 1.4. oversized-object-fails-without-enqueue

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Bootstrap this scenario's app with `VIDEO_MAX_SIZE_BYTES=8388608` (8 MiB)
  2. POST /videos with `size_bytes: 8388608` (declared within the limit → 2 parts of 5 MiB)
  3. PUT 5 MiB to part 1 and 5 MiB to part 2 (10 MiB stored, above the limit)
  4. POST /videos/<id>/upload/complete with both parts
    - expect: status `413`
    - expect: body `error: "VIDEO_TOO_LARGE"`
  5. Query the video row
    - expect: `status = 'failed'`, `processing_error` not null
  6. `HeadObject` on `videos/<id>/original`
    - expect: `NotFound`
  7. Inspect the queue
    - expect: no job for `<id>`

#### 1.5. rejects-complete-on-ready-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Create a draft and set its `status` to `'ready'` directly in the DB
  2. POST /videos/<id>/upload/complete with any valid-shaped body
    - expect: status `409`
    - expect: body `error: "INVALID_VIDEO_STATUS"`
