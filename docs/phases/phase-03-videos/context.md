---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-05T18:21:55-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-06T09:33:38-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-05T18:27:37-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-05T18:27:37-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-05T18:27:37-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-05T18:27:37-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-05T18:21:55-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — UI de vídeo (player, botão de download, telas de upload) fica diferida para fases posteriores (Fase 05+); contratos de upload/stream desta fase são REST + URLs pré-assinadas consumíveis por qualquer cliente.

**Sequencing notes:** > Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ on Redis) | bullmq@6.3.11, @nestjs/bullmq@11.0.5, ioredis@5.11.1, redis:8.10.2 (Docker image) |
|     └─ Last revision: 2026-10-06 — Library pins fixed; BullMQ 6 makes `ioredis` an optional peer dependency, so i… | | | | | | |
| phase-03-videos/TD-02 | phase | Backend | Large-File Upload Protocol (up to 10GB without passing thr… | decided | A (S3 Multipart Upload with presigned part URLs) | — |
|     └─ Last revision: 2026-10-06 — The API is the single owner of the actual-size check: in `POST /videos/:id/upl… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Client Library | decided | A (AWS SDK v3) | @aws-sdk/client-s3@3.1146.0, @aws-sdk/s3-request-presigner@3.1146.0 |
| phase-03-videos/TD-04 | phase | Backend | Bucket / Key Layout and Access Policy | decided | A (Single private bucket, per-video prefix keyed by internal UUID) | — |
| phase-03-videos/TD-05 | phase | Backend | Presigned URL Endpoint (internal service host vs browser-r… | decided | A (Internal endpoint for server calls + public endpoint for signing) | — |
| phase-03-videos/TD-06 | phase | Backend | Upload Completion and Processing Trigger | decided | A (Client calls API "complete" endpoint; API completes multipart, validates and enqueues) | — |
|     └─ Last revision: 2026-10-06 — Complete flow refined: `CompleteMultipartUpload` → `HeadObject` → if size abov… | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Video Worker Runtime and Deployment | decided | A (Same NestJS codebase, separate entrypoint and Compose service) | ffmpeg 7:5.1.9-0+deb12u1 (Debian bookworm apt package on `node:25.6.0-slim`) |
| phase-03-videos/TD-08 | phase | Backend | FFmpeg Integration Approach | decided | A (System binaries via apt + child_process.spawn) | ffmpeg 7:5.1.9-0+deb12u1 (provides `ffmpeg` + `ffprobe`; Debian bookworm apt) |
|     └─ Last revision: 2026-10-06 — Persisted metadata fixed: typed columns `duration_seconds`, `width`, `height`, … | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Worker Input Access to the Original File | decided | B (FFmpeg reads the object via presigned GET URL) | — |
|     └─ Last revision: 2026-10-06 — Worker input presigned GET URL TTL fixed at `15min` (env-configurable) | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | Thumbnail Frame Selection Policy | decided | B (Percentage of duration — 10%, fallback 0s, JPEG) | — |
| phase-03-videos/TD-11 | phase | Backend | Unique Public Video Identifier (URL) | decided | B (Random base62 short ID, 11 chars, via node:crypto) | — |
|     └─ Last revision: 2026-10-06 — Route identifiers fixed: owner routes use the internal UUID (`GET /videos/:id`,… | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Streaming and Download Delivery | decided | A (Presigned GET URLs served by storage, API redirects) | — |
|     └─ Last revision: 2026-10-06 — Presigned GET TTLs fixed (env-configurable): stream `6h`, download `1h` | | | | | | |
| phase-03-videos/TD-13 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (Single enum draft → processing → ready \| failed + bounded retries) | — |
|     └─ Last revision: 2026-10-06 — Size-limit check removed from the worker's deterministic errors; an oversized u… | | | | | | |
| phase-03-videos/TD-14 | phase | Repo-wide | Local S3-Compatible Storage Image (MinIO distribution) | decided | B (Community-maintained rebuild of MinIO — `coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`) | coollabsio/minio:RELEASE.2025-10-15T17-29-55Z (Docker image; bundles `mc` at `/usr/bin/mc`, used for both the server and the bucket-init service) |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-14 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-07 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-05 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-13 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-13 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-11 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05, phase-03-videos/TD-12 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the only option where retries with backoff, idempotent job IDs and an official Nest 11 module come out of the box; the cost is one `redis` container configured with `noeviction` + AOF. pg-boss's transactional enqueue is attractive, but the idempotent `jobId` + retryable "complete upload" endpoint (TD-06) covers the same consistency gap without loading the primary DB.
**Libraries:** bullmq@6.3.11, @nestjs/bullmq@11.0.5, ioredis@5.11.1, redis:8.10.2 (Docker image)

**Revisions:**
- 2026-10-06 — Library pins fixed; BullMQ 6 makes `ioredis` an optional peer dependency, so it is installed explicitly at the version BullMQ 6.3.11 tests against (5.11.1); Redis runs with `maxmemory-policy noeviction` + `appendonly yes`. Rationale: MD-1 (validation) — libraries pinned via context7 + npm registry, see `library-refs.md`.

### phase-03-videos/TD-02

**Recommendation:** it is the only option where the API never carries video bytes while still supporting resume, and it works unchanged on MinIO (dev) and S3 (prod). Policy values (confirmed 2026-10-06 — see Revisions): max size `10 GiB` (`10737418240` bytes, env-configurable), fixed part size `100 MiB` (≈103 parts for 10GiB, well inside the 10,000-part limit and the 5MiB minimum part size), presigned part URL TTL `1h` (re-requestable on resume), content-type allowlist validated at initiate (see TD-12 for why). `POST /videos` requires a `title` in the request body (persisted on the draft record), together with file name, size and content type. Size is checked twice: declared at `POST /videos`, actual via `HeadObject` after `CompleteMultipartUpload`.
**Libraries:** —

**Revisions:**
- 2026-10-06 — Policy values confirmed: max size `10 GiB` (`10737418240` bytes, env-configurable), part size `100 MiB`, presigned part URL TTL `1h` (re-requestable on resume). Rationale: AMB-3 — values were marked "to be confirmed".
- 2026-10-06 — The API is the single owner of the actual-size check: in `POST /videos/:id/upload/complete`, after `HeadObject`, if the real size exceeds the limit the API deletes the object, marks the video `failed` with `processing_error`, responds 4xx and never enqueues; the worker does not validate size. Rationale: IC-1 — TD-02 and TD-13 assigned the check to different components.

### phase-03-videos/TD-03

**Recommendation:** the project's production storage is S3 and TD-02 depends on presigning multipart `UploadPart` and controlling `Create/Complete/Abort/ListParts`, all of which are typed first-class commands in SDK v3; MinIO is only the local S3 stand-in.
**Libraries:** @aws-sdk/client-s3@3.1146.0, @aws-sdk/s3-request-presigner@3.1146.0

### phase-03-videos/TD-04

**Recommendation:** keeps every read behind API rules from day one (drafts in this phase, visibility in Fase 04) with the least provisioning; thumbnail caching can be revisited if listing pages (Fase 07) show it matters. Bucket creation (and CORS for browser `PUT`) is provisioned by a one-shot init service in Compose.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** it is the only option that keeps both the Docker service-name rule and direct client↔storage transfers; the extra env var is part of the same Joi/compose/`.env.example` change set.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** completing an S3 multipart is already an explicit API call in TD-02, so the trigger lives naturally there, keeps dev/prod identical and keeps status transitions inside the videos module. Abandoned drafts are handled in TD-13.
**Libraries:** —

**Revisions:**
- 2026-10-06 — Complete flow refined: `CompleteMultipartUpload` → `HeadObject` → if size above limit: delete object, status `failed` + `processing_error`, 4xx, no enqueue; otherwise status `processing` + enqueue (`jobId = videoId`). Route uses the internal UUID (`POST /videos/:id/upload/complete`). Rationale: IC-1 (single size-check owner = API) and AMB-1 (owner routes use UUID).

### phase-03-videos/TD-07

**Recommendation:** matches the diagram's separate container while reusing the existing TypeORM/config/test foundation, and installing FFmpeg in the shared dev image lets real ffprobe/ffmpeg integration tests run in the same container the suite already uses.
**Libraries:** ffmpeg 7:5.1.9-0+deb12u1 (Debian bookworm apt package on `node:25.6.0-slim`)

### phase-03-videos/TD-08

**Recommendation:** the only option with no unmaintained/third-party binary dependency; the wrapper is a few dozen lines and is tested for real against FFmpeg in the container (TD-07).
**Libraries:** ffmpeg 7:5.1.9-0+deb12u1 (provides `ffmpeg` + `ffprobe`; Debian bookworm apt)

**Revisions:**
- 2026-10-06 — Persisted metadata fixed: typed columns `duration_seconds`, `width`, `height`, `video_codec`, `size_bytes`, plus the raw ffprobe JSON in a `metadata jsonb` column. Rationale: AMB-5 — persisted metadata fields and storage shape were undefined.

### phase-03-videos/TD-09

**Recommendation:** the phase only needs metadata and one frame, so streaming the needed ranges avoids moving 10GB per job; transient network errors are absorbed by the job retry policy.
**Libraries:** —

**Revisions:**
- 2026-10-06 — Worker input presigned GET URL TTL fixed at `15min` (env-configurable). Rationale: AMB-4 — TTL was not fixed.

### phase-03-videos/TD-10

**Recommendation:** avoids most black intro frames at the cost of one seek; custom thumbnails in Fase 04 cover cases where the automatic frame is poor.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** short and non-enumerable as §4 asks, uniqueness guaranteed by the DB index, no ESM-only dependency; the UUID stays as internal PK and storage key (TD-04).
**Libraries:** —

**Revisions:**
- 2026-10-06 — Route identifiers fixed: owner routes use the internal UUID (`GET /videos/:id`, `POST /videos/:id/upload/complete`, `DELETE /videos/:id`); public routes use the `public_id` (`GET /videos/:publicId/stream`, `GET /videos/:publicId/download`). Rationale: AMB-1 — path identifier for owner endpoints was undefined.

### phase-03-videos/TD-12

**Recommendation:** storage already implements Range/206, so streaming and download need no bytes through the API; to mitigate the as-is codec limitation, TD-02 restricts accepted content types to browser-playable containers (`video/mp4`, `video/webm`) and the worker marks videos without a video stream as `failed`. **Access rule (input for the Authorization Matrix):** `stream` and `download` are public (anonymous, no authentication) and respond only when the video status is `ready`; for `draft`, `processing` or `failed` they respond `404` to everyone, including the owner. The owner follows the status through the authenticated `GET /videos/:id` (UUID). No optional-authentication mode is needed in the guard (a `<video src>` does not send `Authorization` anyway).
**Libraries:** —

**Revisions:**
- 2026-10-06 — Access rule simplified: stream/download public only in `ready`, `404` for everyone otherwise (owner included); owner status via authenticated `GET /videos/:id`; no optional auth. Rationale: AMB-2 + DG-1 — owner access outside `ready` had undefined responses and required an optional-auth guard mode not provided by phase-02-auth.
- 2026-10-06 — Presigned GET TTLs fixed (env-configurable): stream `6h`, download `1h`. Rationale: AMB-4 — TTL was not fixed.

### phase-03-videos/TD-13

**Recommendation:** every state has a clear writer in the chosen flow and Fase 04 can add publication orthogonally. Abandoned uploads: MinIO does **not** support the `AbortIncompleteMultipartUpload` lifecycle action (MinIO S3 compatibility docs), so Phase 03 includes an **explicit owner-initiated abort**: `DELETE /videos/:id` on a video in `draft` calls `AbortMultipartUpload` and removes the video record (only the owning channel's user; videos in other statuses are not deletable through this path in Phase 03). **Automatic cleanup of abandoned drafts is out of Phase 03 scope — recorded as deferred.**
**Libraries:** —

**Revisions:**
- 2026-10-06 — Size-limit check removed from the worker's deterministic errors; an oversized upload never reaches the queue (the API marks it `failed` in `upload/complete`, see TD-02/TD-06). Rationale: IC-1 — single owner of the size check is the API.

### phase-03-videos/TD-14

**Recommendation:** for a dev/test-only S3 stand-in, an official frozen build is the lowest-risk, zero-maintenance choice; the exact tags are fixed (and verified pullable) in `library-refs.md` during `plan-resolve`.

**Note:** Decision deliberately diverged from the Recommendation during `plan-resolve` (2026-10-06) — Option A became infeasible: `docker pull minio/minio` and `docker pull minio/mc` fail with "pull access denied … repository does not exist" (repositories removed from Docker Hub) and `quay.io/minio/minio` requires authentication. The community rebuild of the 2025-10-15 security release was pulled successfully and verified (`minio version RELEASE.2025-10-15T17-29-55Z`, `mc` present). Dev/test-only exposure; production uses AWS S3.

**Libraries:** coollabsio/minio:RELEASE.2025-10-15T17-29-55Z (Docker image; bundles `mc` at `/usr/bin/mc`, used for both the server and the bucket-init service)

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: {... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function f... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `dat... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning option... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context 03 to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
