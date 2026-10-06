---
libs:
  "bullmq":
    version: "6.3.11"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "@nestjs/bullmq":
    version: "11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "ioredis":
    version: "5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "@aws-sdk/client-s3":
    version: "3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "redis (Docker image)":
    version: "redis:8.10.2"
    context7_id: "/taskforcesh/bullmq (going-to-production guide)"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "minio + mc (Docker image)":
    version: "coollabsio/minio:RELEASE.2025-10-15T17-29-55Z"
    context7_id: "/minio/docs"
    fetched_at: "2026-10-06T07:34:07-03:00"
  "ffmpeg / ffprobe (apt)":
    version: "7:5.1.9-0+deb12u1"
    context7_id: "—"
    fetched_at: "2026-10-06T07:34:07-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-06T09:33:38-03:00"
---

# phase-03-videos — Library References

Pins confirmed on 2026-10-06 against the npm registry (`npm view`) and context7 docs; Docker images confirmed by real `docker pull`. Installed project baseline: NestJS `^11.0.1`, TypeScript `^5.7.3`, CommonJS output (`module: nodenext`, no `"type": "module"`), Node 22 locally / `node:25.6.0-slim` (Debian 12 bookworm) dev image.

### bullmq

- **Version:** `6.3.11` — source TDs: `phase-03-videos/TD-01`, `phase-03-videos/TD-13`.
- **v6 breaking change (changelog):** `ioredis` is **no longer a direct dependency** — it is an optional peer and must be installed explicitly (see `ioredis` below). The `Connection` constructor parameter was replaced by `BackendFactory`; `Queue#client` / `Worker#blockingClient` were removed (use `getBackend()` if the raw client is ever needed).
- **Connection:** `connection: { host, port }` options are forwarded to ioredis (`ConnectionOptions = IORedis.RedisOptions | IORedis.Redis | ...`). Workers force `maxRetriesPerRequest: null` (required; do not override).
- **Enqueue (TD-06):** `queue.add(name, data, { jobId, attempts: 3, backoff: { type: 'exponential', delay } })`. Same `jobId` → duplicate add is ignored (idempotent enqueue). Caveat from docs: if `removeOnComplete`/`removeOnFail` removes the job, a new job with the same id can be added again.
- **Non-retryable failures (TD-13):** `throw new UnrecoverableError(msg)` moves the job straight to failed, ignoring `attempts`.
- **Retention:** default keeps completed/failed jobs forever — set `removeOnComplete` / `removeOnFail` (`{ age, count }`) explicitly.
- **Redis requirement:** `maxmemory-policy` **must** be `noeviction` (BullMQ warns at runtime otherwise); AOF persistence recommended (going-to-production guide).

### @nestjs/bullmq

- **Version:** `11.0.5` — CommonJS build; peers `bullmq ^3 || ^4 || ^5 || ^6`, `@nestjs/core|common ^10 || ^11` (compatible with the installed Nest 11). Depends on `@nestjs/bull-shared` 11.0.5.
- **Why not 12.0.0:** `@nestjs/bullmq@12.0.0` and `@nestjs/bull-shared@12.0.0` are ESM-only (`"type": "module"`); the CommonJS project's ts-jest suites fail with `SyntaxError: Unexpected token 'export'` (see TD-01 revision of 2026-10-06). The API surface used here (`BullModule.forRootAsync`, `registerQueue`, `@InjectQueue`, `@Processor`/`WorkerHost`) is the same in 11.0.5.
- **Root config:** `BullModule.forRootAsync({ imports, inject, useFactory: (cfg) => ({ connection: { host, port } }) })` — global shared config; fits the inherited `registerAs` + `ConfigType` pattern (phase-01-configuracao-base/TD-01, TD-03).
- **Queue:** `BullModule.registerQueue({ name })` (or `registerQueueAsync`); inject with `@InjectQueue(name) queue: Queue`.
- **Consumer (worker app):** `@Processor(name, { concurrency })` on a class extending `WorkerHost` implementing `async process(job: Job)`. Worker events via `@OnWorkerEvent('failed' | 'completed')`. `this.worker` is only available after `onModuleInit`.
- **Testing:** module compilation tests must include `BullModule.registerQueue(...)` wiring (testing-guide-nestjs-project § Worth testing).

### ioredis

- **Version:** `5.11.1` — the version BullMQ `6.3.11` lists in its own `devDependencies` (tested combination). `ioredis@6.0.0` exists (2026-07-31) but is not the version BullMQ tests against; not adopted.
- **Usage:** only as BullMQ's Redis client (peer). Host is the Compose service name (`redis`), never `localhost` (CLAUDE.md Docker networking).

### @aws-sdk/client-s3

- **Version:** `3.1146.0` (engines `node >= 20`) — source TDs: `TD-02`, `TD-03`, `TD-04`, `TD-05`, `TD-06`, `TD-09`, `TD-12`, `TD-13`.
- **Client:** `new S3Client({ region, endpoint, forcePathStyle: true, credentials })`; reuse one instance per endpoint/credentials (effective-practices doc). Per TD-05: one client on `S3_ENDPOINT` (`http://minio:9000`) for real calls, a second on `S3_PUBLIC_ENDPOINT` used **only** for signing.
- **Commands used:** `CreateMultipartUploadCommand` (`Bucket`, `Key`, `ContentType` → `UploadId`), `UploadPartCommand` (presigned; `PartNumber` 1–10000 → `ETag`), `ListPartsCommand` (resume), `CompleteMultipartUploadCommand` (`MultipartUpload: { Parts: [{ PartNumber, ETag }] }`), `AbortMultipartUploadCommand` (TD-13 owner abort), `HeadObjectCommand` (actual size check, TD-02 revision), `GetObjectCommand` (`ResponseContentDisposition` for download, TD-12), `PutObjectCommand` (thumbnail), `DeleteObjectCommand` (oversized upload).
- **MinIO note:** `AbortIncompleteMultipartUpload` lifecycle action is not supported by MinIO (S3 compatibility docs) — the explicit owner abort (TD-13) is the only cleanup path in this phase.

### @aws-sdk/s3-request-presigner

- **Version:** `3.1146.0` (must match `client-s3`).
- **API:** `getSignedUrl(client, command, { expiresIn })` — `expiresIn` in seconds, default `900`. TTLs (env-configurable, TD-02/TD-09/TD-12 revisions): upload part `3600`, stream `21600`, download `3600`, worker read `900`.
- Signature covers the `Host` → sign with the public-endpoint client for browser URLs, with the internal client for the worker's FFmpeg input (TD-05, TD-09).

### redis (Docker image)

- **Image:** `redis:8.10.2` (pulled; `redis-server --version` → `v=8.10.2`).
- **Required flags:** `redis-server --maxmemory-policy noeviction --appendonly yes` (TD-01; BullMQ production guide). Healthcheck: `redis-cli ping`.

### minio + mc (Docker image)

- **Image:** `coollabsio/minio:RELEASE.2025-10-15T17-29-55Z` (pulled; `minio --version` → `RELEASE.2025-10-15T17-29-55Z`; `mc` present at `/usr/bin/mc`). Official `minio/minio` and `minio/mc` are gone from Docker Hub ("pull access denied … repository does not exist"); see TD-14 **Note**. No `latest` tags.
- **Server:** `minio server /data --console-address :9001` with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`; liveness `GET /minio/health/live`.
- **Bucket init (same image, one-shot service, TD-04):** `mc alias set local http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && mc mb --ignore-existing local/<bucket>`. Bucket stays private (no `mc anonymous set`).
- **CORS for browser `PUT` of parts:** must expose `ETag`; verify the server's CORS behavior for the pinned release during implementation (no bucket-level CORS command confirmed in the fetched docs).

### ffmpeg / ffprobe (apt)

- **Package:** `ffmpeg` `7:5.1.9-0+deb12u1` (Debian 12 bookworm candidate on `node:25.6.0-slim`, checked with `apt-cache policy ffmpeg`). Provides both `ffmpeg` and `ffprobe` (TD-07, TD-08).
- **Invocation (TD-08):** `child_process.spawn` — `ffprobe -v error -print_format json -show_format -show_streams <url>`; thumbnail `ffmpeg -ss <t> -i <url> -frames:v 1 ...` (fast input seek before `-i`, TD-10). Input is an HTTP presigned URL (TD-09) — FFmpeg's HTTP protocol issues Range requests.
- No context7 entry used (CLI binary, not a library).
