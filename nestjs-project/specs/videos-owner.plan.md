---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-owner.e2e-spec.ts
---

# GET /videos/:id and DELETE /videos/:id Test Plan

## Application Overview

`GET /videos/:id` lets the owner follow the video status lifecycle (`draft → processing → ready | failed`) with the extracted metadata and a presigned `thumbnail_url` once a thumbnail exists. `DELETE /videos/:id` aborts an unfinished upload: only `draft` videos can be deleted, which aborts the S3 multipart upload and removes the record. Non-owners get the same `404` as a missing video.

## Test Scenarios

### 1. GET /videos/:id

**Setup:** `beforeEach` cleans the test DB and clears `ThrottlerStorageService.storage`; app bootstrapped from `AppModule` with `main.ts` globals; env overrides: `S3_PUBLIC_ENDPOINT=http://minio:9000`, `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`, `QUEUE_PREFIX=test-<random>`; two confirmed users (owner and other) logged in.

#### 1.1. owner-sees-draft-status

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Owner creates a draft via POST /videos
  2. GET /videos/<id> with the owner's token
    - expect: status `200`
    - expect: body has `id`, `public_id`, `title`, `status: "draft"`, `original_filename`, `content_type`, `created_at`, `updated_at`
    - expect: `size_bytes`, `duration_seconds`, `width`, `height`, `video_codec`, `processing_error` are `null`
    - expect: `thumbnail_url` is `null`

#### 1.2. non-owner-gets-not-found

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Owner creates a draft
  2. GET /videos/<id> with the other user's token
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 1.3. rejects-non-uuid-id

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. GET /videos/not-a-uuid with the owner's token
    - expect: status `400`
    - expect: body `error: "VALIDATION_ERROR"`

### 2. DELETE /videos/:id

**Setup:** same as group 1.

#### 2.1. deletes-draft-and-aborts-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Owner creates a draft with 3 parts and keeps the URL of part 1
  2. DELETE /videos/<id> with the owner's token
    - expect: status `204`
  3. GET /videos/<id> with the owner's token
    - expect: status `404` with `error: "VIDEO_NOT_FOUND"`
  4. PUT 5 MiB to the kept URL of part 1
    - expect: storage responds with an error (`NoSuchUpload`, status `404`)

#### 2.2. rejects-delete-outside-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. Owner creates a draft and its `status` is set to `'processing'` directly in the DB
  2. DELETE /videos/<id> with the owner's token
    - expect: status `409`
    - expect: body `error: "INVALID_VIDEO_STATUS"`
  3. Query the video row
    - expect: row still exists with `status = 'processing'`
