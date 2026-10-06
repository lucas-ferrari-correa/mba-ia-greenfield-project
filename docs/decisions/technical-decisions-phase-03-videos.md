---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-05
scope_description: "Backend foundation for video upload and processing: message queue technology, 10GB direct-to-storage upload protocol, object storage client/layout/endpoints, processing trigger, video worker runtime, FFmpeg integration, thumbnail policy, unique public video ID, streaming/download delivery and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the `videos` module (upload handshake, status, stream/download endpoints), the object storage integration, the queue producer, the video worker (FFmpeg) and the new Compose services (object storage, queue broker, worker). All TDs below target this subproject.
- `next-frontend/` — no open decision in this document. Phase 03 capabilities in `docs/project-plan.md` are backend/infra capabilities (storage, queue, upload, processing, unique URL, streaming, download); the video UI (player, download button, upload screens) belongs to later phases (Fase 05 lists "Player de vídeo" and "Botão de download do vídeo"). Upload/stream contracts defined here are plain REST + presigned URLs, consumable by any client later.

**Inherited constraints (not reopened):** NestJS 11 + TypeORM 0.3 + PostgreSQL 17 (Fase 01); `@nestjs/config` with namespaced `registerAs` + Joi env validation (phase-01-configuracao-base/TD-01..TD-03); custom JWT guard with `@nestjs/jwt` (phase-02-auth/TD-02); `class-validator` DTOs (phase-02-auth/TD-06); domain exception filter + error envelope (phase-02-auth/TD-07); `@nestjs/swagger` for OpenAPI (openapi-docs-nestjs/TD-01); tests run against real Compose services (`db`, `mailpit`) per the existing `*.integration-spec.ts` pattern. Object storage is **S3-compatible** by project definition (MinIO locally, S3 in production) — only *how* it is used is decided here.

**Installed versions checked:** `nestjs-project/package.json` (NestJS `^11.0.1`, TypeORM `^0.3.28`, TypeScript `^5.7.3`, `tsconfig` `module: nodenext` with no `"type": "module"` → CommonJS output), Node `22.x`, dev image `node:25.6.0-slim` (Debian). Candidate libs looked up (npm registry, 2026-10-05): `bullmq@6.3.11`, `@nestjs/bullmq@12.0.0` (peer: `@nestjs/core ^10||^11||^12`, `bullmq ^3..^6`), `@aws-sdk/client-s3@3.1146.0`, `minio@8.0.7`, `pg-boss@12.37.0`, `@tus/server@2.4.5`, `nanoid@6.0.2` (ESM-only), `fluent-ffmpeg@2.1.3` (**deprecated** on npm). Exact pins are fixed later by `plan-resolve` in `library-refs.md`.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) has a `Message Queue` container marked **TBD** between the API (producer) and the Video Worker (consumer). Processing a video (ffprobe + thumbnail) is slow and must not block the request that finishes the upload. The queue must support retries, failure reporting and run as a real service in Docker Compose.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue. The API registers the queue (`BullModule.registerQueue`) and adds jobs; the worker declares a `@Processor()` class extending `WorkerHost`. Built-in `attempts` + exponential `backoff`, custom `jobId` (idempotent enqueue), `UnrecoverableError` to skip retries, `failed`/`completed` events.
- **Pros:** Official NestJS integration (`@nestjs/bullmq`, compatible with Nest 11). Retries/backoff/idempotency are job options, not custom code. Small infra cost (one `redis` container). Redis can later back other needs (e.g., throttler storage) without new infra.
- **Cons:** Adds Redis as a new stateful dependency. Redis must run with `maxmemory-policy noeviction` (BullMQ warns otherwise) and ideally AOF persistence. Jobs are Node/BullMQ-specific (not a language-neutral broker).

### Option B: RabbitMQ (AMQP)
- Dedicated message broker; API publishes to an exchange/queue, worker consumes with ack/nack. NestJS integration via `@nestjs/microservices` RMQ transport or community libs.
- **Pros:** Language-neutral protocol (a worker in another language could consume). Mature routing (exchanges, DLX). Strong delivery semantics with manual ack.
- **Cons:** Heavier container and more concepts (exchanges, bindings, DLX) for a single job type. Retries with backoff require DLX/TTL plumbing or plugins — not built-in. No job state/progress model; status tracking falls entirely on the DB.

### Option C: pg-boss on the existing PostgreSQL
- Job queue implemented with PostgreSQL tables (`SKIP LOCKED`). No new service; jobs live in the same DB.
- **Pros:** Zero new infrastructure; reuses `db`. Enqueue can share the same DB transaction as the status update (true transactional enqueue).
- **Cons:** No official NestJS module. Queue load lands on the primary DB (polling). Diverges from the architecture diagram, which models the queue as a separate container; weaker fit for the "fila subindo no Compose" expectation.

**Recommendation:** **Option A (BullMQ + Redis)** — the only option where retries with backoff, idempotent job IDs and an official Nest 11 module come out of the box; the cost is one `redis` container configured with `noeviction` + AOF. pg-boss's transactional enqueue is attractive, but the idempotent `jobId` + retryable "complete upload" endpoint (TD-06) covers the same consistency gap without loading the primary DB.

**Decision:** A (BullMQ on Redis)

---

## TD-02: Large-File Upload Protocol (up to 10GB without passing through the API)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must not hold the request/connection or buffer bytes for a 10GB file. `docs/project-plan.md` §4 also asks that the upload "permita retomar em caso de falha de conexão". A single presigned `PUT`/`POST` is not viable: S3 single-request uploads are limited to 5GB. This TD defines the REST handshake any client will use (frontend consumption is deferred).

**Options:**

### Option A: S3 Multipart Upload with presigned part URLs (API orchestrates, client uploads directly to storage)
- `POST /videos` (body: `title`, file name, size, content type) creates the draft + `CreateMultipartUpload`, returns `uploadId`, part size and part count; the client asks for presigned `UploadPart` URLs, `PUT`s each part straight to storage and collects ETags; `POST /videos/:id/upload/complete` sends `{partNumber, etag}[]` and the API calls `CompleteMultipartUpload`. Resume = API lists already-uploaded parts (`ListParts`) and re-signs the missing ones.
- **Pros:** Zero video bytes through the API (only small JSON calls). Native S3 protocol — identical on MinIO and AWS S3. Resumable and parallelizable by part. Up to 10,000 parts / 5TB objects.
- **Cons:** Client orchestrates the parts (more client logic). API cannot enforce size per byte while uploading — must validate declared size at initiate and actual size at complete (HeadObject) and reject/delete if above the limit. Browser upload requires storage CORS exposing `ETag`.

### Option B: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- A tus endpoint receives `PATCH` chunks and forwards them to S3 via multipart behind the scenes; clients use `tus-js-client`.
- **Pros:** Standard resumable protocol with mature clients; resume logic is built into the client lib.
- **Cons:** Every byte flows through a Node process (API or a dedicated tus container) — bandwidth/CPU cost on our side and contrary to "sem passar o arquivo pela API". Extra service + library surface, and a protocol that S3 itself does not speak.

### Option C: Streamed multipart/form-data through the API (pipe to S3)
- API receives `multipart/form-data` and pipes the stream to S3 (`@aws-sdk/lib-storage` `Upload`) without buffering to disk.
- **Pros:** Simplest client (`<form>`/single `fetch`). Server fully controls size/type validation while streaming.
- **Cons:** A 10GB request holds an API connection for the whole transfer; no resume on network failure; API bandwidth becomes the bottleneck. This is the pattern the phase explicitly must avoid.

**Recommendation:** **Option A (S3 Multipart with presigned part URLs)** — it is the only option where the API never carries video bytes while still supporting resume, and it works unchanged on MinIO (dev) and S3 (prod). Suggested policy values (to be confirmed): max size `10 GiB` (`10737418240` bytes, env-configurable), fixed part size `100 MiB` (≈103 parts for 10GiB, well inside the 10,000-part limit and the 5MiB minimum part size), presigned part URL TTL `1h` (re-requestable on resume), content-type allowlist validated at initiate (see TD-12 for why). `POST /videos` requires a `title` in the request body (persisted on the draft record), together with file name, size and content type. Size is checked twice: declared at `POST /videos`, actual via `HeadObject` after `CompleteMultipartUpload`.

**Decision:** A (S3 Multipart Upload with presigned part URLs)

---

## TD-03: Object Storage Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** API (multipart orchestration, presigning) and worker (read original, write thumbnail) need an S3 client that works against MinIO locally and AWS S3 in production, including presigning of `UploadPart`, `GetObject` and multipart control calls. Depends on TD-02.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official S3 client; any command (`UploadPartCommand`, `GetObjectCommand` with `ResponseContentDisposition`, etc.) can be presigned with `getSignedUrl(client, command, { expiresIn })`. Custom `endpoint` + `forcePathStyle: true` targets MinIO.
- **Pros:** Same code path for S3 in production (the target per project definition). First-class TypeScript types. Presigning works for every command, including multipart parts. Very large usage base.
- **Cons:** Verbose command-object API. Larger dependency footprint than minio-js (two packages, many transitive `@smithy/*` deps).

### Option B: MinIO JS SDK (`minio`)
- MinIO's S3-compatible client with a compact API (`putObject`, `presignedGetObject`, `presignedUrl(method, ..., reqParams)`).
- **Pros:** Compact, ergonomic API. Maintained by the storage vendor used in dev.
- **Cons:** Low-level multipart (initiate/list parts/complete with external part uploads) is not a first-class public flow; presigning `UploadPart` requires the generic `presignedUrl` with raw query params. Production target is AWS S3 — using the vendor SDK of the dev substitute inverts the dependency. MinIO Community is in maintenance mode (see TD-14).

**Recommendation:** **Option A (AWS SDK v3)** — the project's production storage is S3 and TD-02 depends on presigning multipart `UploadPart` and controlling `Create/Complete/Abort/ListParts`, all of which are typed first-class commands in SDK v3; MinIO is only the local S3 stand-in.

**Decision:** A (AWS SDK v3)

---

## TD-04: Bucket / Key Layout and Access Policy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Originals and thumbnails must be organized so that API and worker agree on object keys (cross-component: API writes original, worker reads it and writes thumbnail, delivery endpoints sign them), and so that public exposure is controlled. `docs/project-plan.md` §4 also flags storage growth/cost as a concern.

**Options:**

### Option A: Single private bucket, per-video prefix keyed by internal UUID
- One bucket (e.g., `streamtube-videos`) with keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Bucket has no anonymous access; every read is a presigned URL issued by the API (TD-12).
- **Pros:** One bucket to provision; all access passes through API authorization rules (needed for future visibility rules in Fase 04). Deleting a video = delete one prefix. Keys use the immutable UUID, so changing the public ID/slug never moves objects.
- **Cons:** Thumbnails get a new presigned URL per response → weaker browser/CDN caching than stable public URLs.

### Option B: Two buckets — private videos, public-read thumbnails
- `videos` bucket private (presigned access); `thumbnails` bucket with anonymous read and stable URLs.
- **Pros:** Stable, cacheable thumbnail URLs; listing pages need no signing per item.
- **Cons:** Two buckets + an anonymous-read policy to provision in dev and prod. Thumbnails of videos that should not be listed (unlisted/draft) become publicly guessable-by-URL. Two places to clean per video.

### Option C: Single bucket with public-read on everything
- **Pros:** Simplest delivery (plain URLs).
- **Cons:** Any original file is downloadable by anyone who learns the key; no way to enforce draft/failed/visibility rules. Not acceptable for user uploads.

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/…` keys)** — keeps every read behind API rules from day one (drafts in this phase, visibility in Fase 04) with the least provisioning; thumbnail caching can be revisited if listing pages (Fase 07) show it matters. Bucket creation (and CORS for browser `PUT`) is provisioned by a one-shot init service in Compose.

**Decision:** A (Single private bucket, per-video prefix keyed by internal UUID)

---

## TD-05: Presigned URL Endpoint (internal service host vs browser-reachable host)

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The project rule (CLAUDE.md, Docker Networking) is to reach services by Compose service name (`minio:9000`). But presigned URLs are consumed by the **client outside Docker**, and a SigV4 signature covers the `Host` header — a URL signed for `minio:9000` is unreachable from the browser and cannot simply be rewritten afterwards. Cross-component: env schema (Joi) + `compose.yaml` + `.env.example` + storage service code.

**Options:**

### Option A: Two endpoint settings — internal for server calls, public for signing
- `S3_ENDPOINT=http://minio:9000` is used by the S3 client that actually talks to storage (API + worker). A second S3 client configured with `S3_PUBLIC_ENDPOINT` (e.g., `http://localhost:9000` in dev, the S3/CDN host in prod) is used **only** to compute presigned URLs (signing is local, no network call).
- **Pros:** Respects the service-name rule for every container-to-container call. Works without touching the developer's machine. Maps cleanly to prod (public endpoint = S3 regional host).
- **Cons:** Two client instances and one extra env var; must make sure server-side code never uses the public client for real calls.

### Option B: Single endpoint + host alias on the developer machine
- Sign and call with `http://minio:9000`; developers add `127.0.0.1 minio` to `/etc/hosts`.
- **Pros:** One client, one env var.
- **Cons:** Requires manual OS change on every dev machine/CI runner; brittle and undocumented-by-default.

### Option C: Proxy storage reads/writes through the API
- **Pros:** No public storage endpoint at all.
- **Cons:** Puts video bytes back through the API, contradicting TD-02 and TD-12.

**Recommendation:** **Option A (internal + public endpoints)** — it is the only option that keeps both the Docker service-name rule and direct client↔storage transfers; the extra env var is part of the same Joi/compose/`.env.example` change set.

**Decision:** A (Internal endpoint for server calls + public endpoint for signing)

---

## TD-06: Upload Completion and Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload finishes. Something must detect "upload complete", move the video to `processing` and enqueue the job exactly once. Depends on TD-01 and TD-02.

**Options:**

### Option A: Client calls the API "complete" endpoint; API completes the multipart, validates and enqueues
- `POST /videos/:id/upload/complete` → `CompleteMultipartUpload` → `HeadObject` (size check) → status `processing` → `queue.add(..., { jobId: videoId })`. Idempotent: repeating the call on a video already `processing` re-adds with the same `jobId` (no duplicate job).
- **Pros:** Single place owns the status transition and validation. Portable across MinIO and S3 (no storage-specific eventing). Easy to test end-to-end with supertest.
- **Cons:** If the client never calls "complete", the video stays `draft` (abandoned upload). DB update and enqueue are not atomic — mitigated by idempotent `jobId` + retryable endpoint.

### Option B: Storage event notification (MinIO bucket notification / S3 Event → queue or webhook)
- Storage emits `s3:ObjectCreated:CompleteMultipartUpload` to Redis/AMQP/webhook, which triggers processing.
- **Pros:** Triggers even if the client disappears after the last part (once someone completes the multipart).
- **Cons:** The multipart still must be completed by someone (client with credentials or API) — it does not remove Option A's call. Configuration differs between MinIO and AWS (S3 → SNS/SQS/EventBridge), so dev ≠ prod. Status transition happens outside the API.

### Option C: Worker polls storage/DB for finished uploads
- **Pros:** No new trigger mechanism.
- **Cons:** Latency and wasted polling; still needs someone to complete the multipart.

**Recommendation:** **Option A (API "complete" endpoint enqueues)** — completing an S3 multipart is already an explicit API call in TD-02, so the trigger lives naturally there, keeps dev/prod identical and keeps status transitions inside the videos module. Abandoned drafts are handled in TD-13.

**Decision:** A (Client calls API "complete" endpoint; API completes multipart, validates and enqueues)

---

## TD-07: Video Worker Runtime and Deployment

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The diagram shows the Video Worker as a separate container that consumes the queue and updates DB + storage. The worker needs DB access (same `videos` table), the storage client and FFmpeg binaries. Cross-component: code entrypoint + Dockerfile + `compose.yaml` + test environment (integration tests that call ffprobe must run where FFmpeg exists).

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and separate Compose service
- `nestjs-project/src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server) that imports the shared TypeORM/config/storage modules and the `@Processor` class. Compose adds `video-worker` built from the same dev image (with `ffmpeg` installed via apt) running the worker entrypoint.
- **Pros:** Reuses entities, repositories, config namespaces, Joi validation and test helpers — no duplicated `Video` entity/migration. Independent process: heavy FFmpeg work never shares the API event loop. One image with FFmpeg means integration tests in the API container can also exercise ffprobe.
- **Cons:** API and worker deploy from the same codebase (coupled release cadence). Module boundaries must keep HTTP-only modules (controllers, throttler) out of `WorkerModule`.

### Option B: Separate subproject (`video-worker/` with its own package.json)
- **Pros:** Hard isolation; worker could pick a different runtime later.
- **Cons:** Duplicates entity definitions, config and test infra (or requires a shared package/monorepo tooling that does not exist today). More setup for one job type.

### Option C: Processor inside the API process
- `@Processor` registered in the API app itself.
- **Pros:** Simplest; no new container.
- **Cons:** FFmpeg child processes and job handling compete with HTTP traffic in the same container; contradicts the separate Video Worker container in the architecture.

**Recommendation:** **Option A (same codebase, `worker.ts` entrypoint, own Compose service)** — matches the diagram's separate container while reusing the existing TypeORM/config/test foundation, and installing FFmpeg in the shared dev image lets real ffprobe/ffmpeg integration tests run in the same container the suite already uses.

**Decision:** A (Same NestJS codebase, separate entrypoint and Compose service)

---

## TD-08: FFmpeg Integration Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker extracts duration/metadata (ffprobe) and renders one frame to an image (ffmpeg). The binary source and the invocation layer affect the Docker image, tests and maintenance.

**Options:**

### Option A: System binaries (apt `ffmpeg`) invoked with `child_process.spawn`
- Thin typed wrapper: `ffprobe -v error -print_format json -show_format -show_streams <input>` parsed into a DTO; `ffmpeg -ss <t> -i <input> -frames:v 1 ...` for the thumbnail. Non-zero exit / stderr mapped to domain errors.
- **Pros:** No extra npm dependency. Full control over arguments and timeouts. ffprobe JSON output is stable and fully documented. Binary version follows the Debian image.
- **Cons:** We own the small wrapper (arg building, exit-code handling, timeout/kill). Binary must be present in every image that runs the code.

### Option B: `fluent-ffmpeg`
- Popular fluent API around the same binaries.
- **Pros:** Familiar API; `ffprobe()` helper returns parsed metadata.
- **Cons:** Marked **deprecated** on npm ("Package no longer supported") — a new dependency that is already unmaintained. Still requires system binaries.

### Option C: npm-bundled binaries (`ffmpeg-static` / `@ffprobe-installer/ffprobe`) + spawn
- **Pros:** Binaries pinned via package.json; no apt step.
- **Cons:** Large platform-specific downloads in `node_modules` (and host vs container arch mismatches with the bind-mounted `node_modules`). Third-party builds of FFmpeg.

**Recommendation:** **Option A (apt FFmpeg + `spawn` wrapper)** — the only option with no unmaintained/third-party binary dependency; the wrapper is a few dozen lines and is tested for real against FFmpeg in the container (TD-07).

**Decision:** A (System binaries via apt + child_process.spawn)

---

## TD-09: Worker Input Access to the Original File

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Originals can reach 10GB. ffprobe only needs container headers and ffmpeg needs one frame, so how the worker reads the original determines disk usage and processing time. Depends on TD-03, TD-08.

**Options:**

### Option A: Download the full object to a temp volume, process locally
- **Pros:** Simple local-file semantics; any FFmpeg operation works; no network during processing.
- **Cons:** Up to 10GB download + equal temp disk per concurrent job just to read headers and one frame. Slow and disk-heavy; requires a sized volume and cleanup.

### Option B: FFmpeg reads the object over HTTP via a short-lived presigned GET URL
- Worker presigns a `GetObject` URL (internal endpoint, TD-05) and passes it as FFmpeg input; FFmpeg uses HTTP Range requests to read only the needed bytes (headers, `moov` atom, the seeked frame).
- **Pros:** Reads a tiny fraction of the file; no temp disk for the original; job time independent of file size for typical MP4/WebM.
- **Cons:** Depends on storage network during the job (transient failures → retried by TD-13). Files with `moov` at the end cost an extra range request (still far less than full download). Exotic containers that need full scans would be slower.

**Recommendation:** **Option B (presigned URL as FFmpeg input)** — the phase only needs metadata and one frame, so streaming the needed ranges avoids moving 10GB per job; transient network errors are absorbed by the job retry policy.

**Decision:** B (FFmpeg reads the object via presigned GET URL)

---

## TD-10: Thumbnail Frame Selection Policy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** "a partir de um frame do vídeo" leaves open which frame. The first frames are often black/fade-in. Depends on TD-08/TD-09 (seek cost over HTTP).

**Options:**

### Option A: Fixed timestamp (e.g., 1s, clamped to 0 for shorter videos)
- **Pros:** Trivial; one fast input seek.
- **Cons:** 1s is frequently still a black/intro frame.

### Option B: Percentage of duration (e.g., 10%) using the ffprobe duration
- Seek `-ss = duration × 0.10` before `-i` (fast keyframe seek), output a single JPEG scaled to a max width (e.g., 1280px).
- **Pros:** Usually past intros; still a single seek; duration is already extracted first in the same job.
- **Cons:** Needs a valid duration (fallback to 0s when ffprobe reports none). Not "content-aware".

### Option C: FFmpeg `thumbnail` filter (picks the most representative frame among N)
- **Pros:** Content-aware; avoids black frames better.
- **Cons:** Decodes a batch of consecutive frames (more CPU and more bytes over HTTP); still needs a seek start point.

**Recommendation:** **Option B (10% of duration, fallback 0s, JPEG)** — avoids most black intro frames at the cost of one seek; custom thumbnails in Fase 04 cover cases where the automatic frame is poor.

**Decision:** B (Percentage of duration — 10%, fallback 0s, JPEG)

---

## TD-11: Unique Public Video Identifier (URL)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a URL that never conflicts with another video; `docs/project-plan.md` §4 asks for a "URL curta e única". The ID appears in every public route (stream/download now; watch page in Fase 05). `channels`/`users` use UUID primary keys.

**Options:**

### Option A: Expose the UUID primary key
- **Pros:** Already unique; zero extra column or logic.
- **Cons:** 36 chars — not short. Ties public URLs to the internal PK.

### Option B: Random base62 short ID (11 chars) in a unique column, generated with `node:crypto`
- Column `public_id varchar(11) UNIQUE`; generated with `crypto.randomInt`/`randomBytes` over `[0-9A-Za-z]`; insert retried on unique-violation (collision probability ≈ 1 / 62¹¹ ≈ 1 / 5.2×10¹⁹ per pair).
- **Pros:** Short, YouTube-like, non-enumerable. DB unique index is the hard guarantee; retry covers the theoretical collision. No dependency (`nanoid@6` is ESM-only, awkward in this CommonJS/ts-jest project).
- **Cons:** Extra column + index and a retry loop in the creation path.

### Option C: Sqids/Hashids encoding of a sequential integer
- **Pros:** Short, collision-free by construction.
- **Cons:** Needs a sequence alongside the UUID PK; IDs are decodable (enumeration with the alphabet). New dependency.

### Option D: Slug from title + random suffix
- **Pros:** Readable URLs.
- **Cons:** Title is editable in Fase 04 ("Edição das informações do vídeo: título…") — the slug would either change (breaking shared links) or go stale; the random suffix is still needed for uniqueness, so readability gains little over Option B.

**Recommendation:** **Option B (11-char base62 via `node:crypto`, unique column + retry)** — short and non-enumerable as §4 asks, uniqueness guaranteed by the DB index, no ESM-only dependency; the UUID stays as internal PK and storage key (TD-04).

**Decision:** B (Random base62 short ID, 11 chars, via node:crypto)

---

## TD-12: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and users must be able to download it. The diagram shows the frontend streaming **directly from Object Storage**. No transcoding capability exists in this phase (only metadata + thumbnail). Depends on TD-04, TD-05.

**Options:**

### Option A: Presigned GET URLs served by storage (HTTP Range / 206), API redirects
- `GET /videos/:publicId/stream` → API checks the video is `ready`, signs `GetObject` (public endpoint) and responds `302` to it; S3/MinIO serve `Range` requests with `206 Partial Content`, so `<video>` seeking works. `GET /videos/:publicId/download` → same, signed with `ResponseContentDisposition: attachment; filename="..."`.
- **Pros:** Zero video bytes through the API; Range/206 implemented by the storage itself; matches the diagram. Stable API URL usable as `<video src>` by anonymous users.
- **Cons:** URLs expire (TTL must exceed typical viewing session, e.g., several hours, or the player must re-request the API URL). Plays only codecs/containers the browser supports, since the original is served as-is.

### Option B: API proxies bytes with Range support
- API parses `Range`, calls `GetObject` with that range and pipes a `206` response.
- **Pros:** Full control per request (auth on every range, no expiring URLs).
- **Cons:** All playback bandwidth flows through the API — the bottleneck TD-02 avoids for uploads.

### Option C: Adaptive streaming (HLS/DASH) generated by the worker
- **Pros:** Adaptive bitrate, universal codec compatibility.
- **Cons:** Requires transcoding/segmenting (heavy CPU, multiplied storage) — not a Phase 03 capability; large scope increase.

**Recommendation:** **Option A (presigned GET + 302 from API, `Content-Disposition: attachment` for download)** — storage already implements Range/206, so streaming and download need no bytes through the API; to mitigate the as-is codec limitation, TD-02 restricts accepted content types to browser-playable containers (`video/mp4`, `video/webm`) and the worker marks videos without a video stream as `failed`. **Access rule (input for the Authorization Matrix):** `stream` and `download` are public (anonymous allowed) only when the video status is `ready`; for `draft`, `processing` or `failed` only the owner (authenticated user who owns the video's channel) may access, and any other caller (anonymous or non-owner) receives `404` (the video's existence is not revealed).

**Decision:** A (Presigned GET URLs served by storage, API redirects)

---

## TD-13: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video is pre-registered as draft when the upload starts and must reflect processing progress and failures in the DB. Fase 04 later adds "fluxo de rascunho → publicação" and visibility, so the status model must not block that. Depends on TD-01, TD-06.

**Options:**

### Option A: Single processing-lifecycle enum `draft → processing → ready | failed` + bounded retries
- `draft` (created, upload in progress), `processing` (set by the complete endpoint), `ready` (metadata + thumbnail stored), `failed` (+ `processing_error` text). Job options `attempts: 3`, exponential backoff; deterministic errors (no video stream, unreadable file, size above limit) thrown as BullMQ `UnrecoverableError` to skip retries; only the final failure sets `failed`. Processor is idempotent (re-running overwrites thumbnail/metadata). Fase 04 adds publication as an orthogonal field (e.g., visibility/`published_at`), not new values in this enum.
- **Pros:** Matches the lifecycle stated for the phase; one column to query; retries absorb transient storage/network errors (TD-09).
- **Cons:** "draft" here means "not processed yet"; Fase 04's publication "rascunho" will be a separate concept and must be named carefully to avoid confusion.

### Option B: Two columns now — `processing_status` + `publication_status`
- **Pros:** Separates the two concepts explicitly from the start.
- **Cons:** Adds a publication field whose rules belong to Fase 04 (premature schema); the phase's stated lifecycle is split across columns.

### Option C: Fine-grained enum (`draft`, `uploading`, `uploaded`, `processing`, `ready`, `failed`)
- **Pros:** More observable states.
- **Cons:** `uploading` vs `draft` and `uploaded` vs `processing` are not distinguishable by the API in the TD-02/TD-06 flow (parts go straight to storage; enqueue happens in the same request) — states without a writer.

**Recommendation:** **Option A (`draft → processing → ready | failed`, 3 attempts w/ exponential backoff, `UnrecoverableError` for deterministic failures)** — every state has a clear writer in the chosen flow and Fase 04 can add publication orthogonally. Abandoned uploads: MinIO does **not** support the `AbortIncompleteMultipartUpload` lifecycle action (MinIO S3 compatibility docs), so Phase 03 includes an **explicit owner-initiated abort**: `DELETE /videos/:id` on a video in `draft` calls `AbortMultipartUpload` and removes the video record (only the owning channel's user; videos in other statuses are not deletable through this path in Phase 03). **Automatic cleanup of abandoned drafts is out of Phase 03 scope — recorded as deferred.**

**Decision:** A (Single enum draft → processing → ready | failed + bounded retries)

---

## TD-14: Local S3-Compatible Storage Image (MinIO distribution)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO is the project's local S3 stand-in. MinIO Community Edition moved to maintenance mode and became a **source-only** distribution after the 2025-10-15 security release — no new official prebuilt Docker images. `compose.yaml` needs a reproducible image (plus `mc` for the bucket-init service). Production uses AWS S3, so this only affects dev/test.

**Options:**

### Option A: Pin the last official prebuilt `minio/minio` (and `minio/mc`) release tag
- **Pros:** Official build, S3 API unchanged; zero build step; exact tag reproducible. Dev-only exposure limits the impact of not receiving newer fixes.
- **Cons:** Frozen version — no further security updates. Tag must be verified to still be pullable.

### Option B: Community-maintained rebuild of MinIO (e.g., images built from MinIO source by third parties)
- **Pros:** Tracks newer source releases.
- **Cons:** Third-party supply chain for a core service; trust and continuity depend on that maintainer.

### Option C: Build MinIO from source in the repo (Dockerfile)
- **Pros:** Full control, latest source.
- **Cons:** Go toolchain build in the dev setup; slower `compose up`; maintenance burden for a dev-only dependency.

**Recommendation:** **Option A (pin last official MinIO release tag)** — for a dev/test-only S3 stand-in, an official frozen build is the lowest-risk, zero-maintenance choice; the exact tags are fixed (and verified pullable) in `library-refs.md` during `plan-resolve`.

**Decision:** A (Pin last official MinIO release tag)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A — BullMQ on Redis (`@nestjs/bullmq`) | A (BullMQ on Redis) |
| TD-02 | Backend | Large-File Upload Protocol | A — S3 Multipart with presigned part URLs | A (S3 Multipart Upload with presigned part URLs) |
| TD-03 | Backend | Object Storage Client Library | A — AWS SDK v3 (`client-s3` + `s3-request-presigner`) | A (AWS SDK v3) |
| TD-04 | Backend | Bucket / Key Layout and Access | A — Single private bucket, `videos/{videoId}/…` | A (Single private bucket, per-video prefix keyed by internal UUID) |
| TD-05 | Backend | Presigned URL Endpoint | A — Internal endpoint for calls + public endpoint for signing | A (Internal endpoint for server calls + public endpoint for signing) |
| TD-06 | Backend | Upload Completion & Processing Trigger | A — API "complete" endpoint enqueues (idempotent `jobId`) | A (Client calls API "complete" endpoint; API completes multipart, validates and enqueues) |
| TD-07 | Backend | Video Worker Runtime | A — Same codebase, `worker.ts` entrypoint, own Compose service | A (Same NestJS codebase, separate entrypoint and Compose service) |
| TD-08 | Backend | FFmpeg Integration | A — apt FFmpeg + `spawn` wrapper | A (System binaries via apt + child_process.spawn) |
| TD-09 | Backend | Worker Input Access | B — Presigned URL as FFmpeg input (HTTP Range) | B (FFmpeg reads the object via presigned GET URL) |
| TD-10 | Backend | Thumbnail Frame Selection | B — 10% of duration, fallback 0s, JPEG | B (Percentage of duration — 10%, fallback 0s, JPEG) |
| TD-11 | Backend | Unique Public Video Identifier | B — 11-char base62 via `node:crypto` + unique index | B (Random base62 short ID, 11 chars, via node:crypto) |
| TD-12 | Backend | Streaming and Download Delivery | A — Presigned GET + 302 (Range/206 by storage) | A (Presigned GET URLs served by storage, API redirects) |
| TD-13 | Backend | Status Lifecycle & Failure Handling | A — `draft → processing → ready \| failed`, 3 attempts | A (Single enum draft → processing → ready \| failed + bounded retries) |
| TD-14 | Repo-wide | Local S3-Compatible Storage Image | A — Pin last official MinIO release tag | A (Pin last official MinIO release tag) |
