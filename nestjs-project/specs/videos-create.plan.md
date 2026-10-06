---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos and GET /videos/:id/upload Test Plan

## Application Overview

`POST /videos` pre-registers a video as `draft` in the caller's channel and starts an S3 multipart upload, returning one presigned `UploadPart` URL per part so the client uploads straight to object storage (the API never carries video bytes). `GET /videos/:id/upload` lets the owner resume an interrupted upload: it lists the parts already stored and returns fresh URLs only for the missing ones.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeEach` cleans the test DB (`cleanAllTables`) and clears `ThrottlerStorageService.storage`; app bootstrapped with `Test.createTestingModule({ imports: [AppModule] })` reproducing `main.ts` globals (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env overrides before bootstrap: `S3_PUBLIC_ENDPOINT=http://minio:9000`, `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`, `QUEUE_PREFIX=test-<random>`; a confirmed user is registered and logged in to obtain an access token.

#### 1.1. creates-draft-and-returns-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. POST /videos with `Authorization: Bearer <token>` and body `{ title: "My video", file_name: "clip.mp4", size_bytes: 11534336, content_type: "video/mp4" }`
    - expect: status `201`
    - expect: body has `id` (uuid), `public_id` matching `^[0-9A-Za-z]{11}$`, `title: "My video"`, `status: "draft"`
    - expect: `upload.part_size` is `5242880`, `upload.part_count` is `3`, `upload.parts` has 3 items with `part_number` 1..3 and a `url` whose host is `minio:9000`
    - expect: `upload.expires_at` is an ISO-8601 date in the future
  2. Query the `videos` table by `id`
    - expect: row with `status = 'draft'`, `upload_id` not null, `storage_key = 'videos/<id>/original'`, `channel_id` = the user's channel

#### 1.2. rejects-size-above-limit

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. POST /videos with a valid token and `size_bytes: 10737418241` (one byte above the default `VIDEO_MAX_SIZE_BYTES`)
    - expect: status `413`
    - expect: body `{ statusCode: 413, error: "VIDEO_TOO_LARGE" }`
  2. Count rows in `videos`
    - expect: `0`

#### 1.3. rejects-unsupported-content-type

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. POST /videos with a valid token and `content_type: "video/x-matroska"`
    - expect: status `400`
    - expect: body `error: "VALIDATION_ERROR"` and `message` mentions `content_type`

#### 1.4. requires-authentication

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. POST /videos with a valid body and no `Authorization` header
    - expect: status `401`

### 2. GET /videos/:id/upload

**Setup:** same as group 1; the test uploads parts with `fetch(url, { method: 'PUT', body })` to the presigned URLs and reads the `ETag` response header.

#### 2.1. hides-video-from-non-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. User A creates a draft via POST /videos
  2. User B (second confirmed user) calls GET /videos/<id-from-A>/upload
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 2.2. resumes-after-partial-upload

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-06T11:54:22Z

**Steps:**
  1. POST /videos with `size_bytes: 11534336` (3 parts of 5 MiB)
  2. PUT 5 MiB to the URL of part 1
    - expect: storage responds `200` with an `ETag` header
  3. GET /videos/<id>/upload with the owner's token
    - expect: status `200`
    - expect: `uploaded_parts` has exactly one item with `part_number: 1`, the same `etag` and `size: 5242880`
    - expect: `parts` lists only `part_number` 2 and 3, each with a `url`
    - expect: `part_count: 3`
