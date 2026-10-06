---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-06T09:33:47-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-06T09:33:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-06T09:33:38-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-05T18:27:37-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of up to 10GB directly to object storage without passing bytes through the API — with automatic draft pre-registration, background processing (duration/metadata extraction and thumbnail generation from a frame) by a queue-driven video worker, a unique short URL per video, and streaming plus download — backed by object storage, a processing queue and a worker running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: Dependências e namespaces de configuração (storage, fila, vídeo)

**Description:** Instala as bibliotecas fixadas da fase e cria os namespaces `storage`, `queue` e `video` no padrão `registerAs` + Joi herdado, base de todos os SIs seguintes.

**Technical actions:**

1. Instalar no `nestjs-project` (dentro do container): `bullmq@6.3.11`, `@nestjs/bullmq@11.0.5` (12.0.0 é ESM-only — ver revisão de 2026-10-06 da `phase-03-videos/TD-01`), `ioredis@5.11.1` (peer opcional do BullMQ 6 — instalação explícita), `@aws-sdk/client-s3@3.1146.0`, `@aws-sdk/s3-request-presigner@3.1146.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (default `http://minio:9000`, chamadas reais), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`, usado só para assinar URLs entregues ao cliente), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` (default `streamtube-videos`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`, nome do serviço Compose), `REDIS_PORT` (default `6379`) e `QUEUE_PREFIX` (default `bull`, o prefixo padrão do BullMQ) (per `phase-03-videos/TD-01`)
4. Criar `src/config/video.config.ts` — `registerAs('video', ...)` lendo `VIDEO_MAX_SIZE_BYTES` (default `10737418240`), `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `104857600`), `VIDEO_UPLOAD_URL_TTL_SECONDS` (default `3600`), `VIDEO_STREAM_URL_TTL_SECONDS` (default `21600`), `VIDEO_DOWNLOAD_URL_TTL_SECONDS` (default `3600`), `VIDEO_WORKER_READ_URL_TTL_SECONDS` (default `900`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`, `phase-03-videos/TD-12`)
5. Registrar os três namespaces em `ConfigModule.forRoot({ load })` no `AppModule`; estender `src/config/env.validation.ts` (Joi: `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` obrigatórios, demais com default, inteiros positivos para `VIDEO_*`) e `.env.example` com valores compatíveis com o Compose (per `phase-01-configuracao-base/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas chaves obrigatórias rejeitadas quando ausentes; defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Iniciar a aplicação sem `S3_ACCESS_KEY_ID` falha no bootstrap com erro de validação Joi
- Iniciar a aplicação apenas com as variáveis obrigatórias resulta em `video.maxSizeBytes = 10737418240` e `video.uploadPartSizeBytes = 104857600`
- `.env.example` contém todas as novas variáveis com hosts de serviço Compose (`minio`, `redis`) — nunca `localhost` para chamadas entre containers

---

### SI-03.2 — Infra: Redis, MinIO, inicialização do bucket e FFmpeg no Docker

**Description:** Sobe a fila (Redis) e o object storage (MinIO + bucket privado) no `compose.yaml` e instala o FFmpeg na imagem de dev compartilhada por API, testes e worker.

**Technical actions:**

1. Atualizar `nestjs-project/Dockerfile.dev` — instalar `ffmpeg=7:5.1.9-0+deb12u1` via apt (fornece `ffmpeg` + `ffprobe`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
2. Adicionar serviço `redis` ao `compose.yaml` — imagem `redis:8.10.2`, `command: redis-server --maxmemory-policy noeviction --appendonly yes`, healthcheck `redis-cli ping`, volume nomeado para AOF (per `phase-03-videos/TD-01`)
3. Adicionar serviço `minio` — imagem `coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`, `command: server /data --console-address :9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` iguais a `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, portas `9000`/`9001`, healthcheck em `/minio/health/live`, volume nomeado; configurar CORS do servidor para `PUT` vindo do navegador expondo o header `ETag` (mecanismo da release fixada verificado na implementação, conforme `library-refs.md`) (per `phase-03-videos/TD-14`, `phase-03-videos/TD-04`)
4. Adicionar serviço one-shot `minio-init` — mesma imagem, `entrypoint` com `mc alias set local http://minio:9000 ... && mc mb --ignore-existing local/$S3_BUCKET` (bucket privado, sem `mc anonymous set`), `depends_on: minio (service_healthy)` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-14`)
5. Fazer `nestjs-api` depender de `redis` (`service_healthy`), `minio` (`service_healthy`) e `minio-init` (`service_completed_successfully`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — variáveis `S3_*`/`REDIS_*` usadas pelo Compose

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `minio` em estado `healthy` e `minio-init` encerra com código 0
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`
- `docker compose exec minio mc ls local/` (após alias) lista o bucket `streamtube-videos`; rodar `minio-init` de novo não falha (idempotente)
- `docker compose exec nestjs-api ffprobe -version` retorna a versão 5.1.9 do pacote Debian

---

### SI-03.3 — Módulo de storage (S3/MinIO)

**Description:** Cria o `StorageModule` com o `StorageService`, única porta de acesso ao object storage para API e worker, com cliente interno para chamadas reais e cliente público apenas para assinar URLs.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — providers de dois `S3Client` (`forcePathStyle: true`, credenciais do namespace `storage`): cliente interno em `S3_ENDPOINT` e cliente de assinatura em `S3_PUBLIC_ENDPOINT`; exporta `StorageService` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)
2. Criar `src/storage/storage.service.ts` — multipart: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, ttl)` (cliente público), `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`)
3. Em `StorageService` — objetos: `headObject(key)` (retorna `ContentLength`), `putObject(key, body, contentType)`, `deleteObject(key)` (per `phase-03-videos/TD-02` revision, `phase-03-videos/TD-10`)
4. Em `StorageService` — leitura assinada: `presignGetObject(key, { ttlSeconds, audience: 'public' | 'internal', contentDisposition? })` — `public` assina com o endpoint público (stream/download/thumbnail), `internal` com `S3_ENDPOINT` (entrada do FFmpeg no worker); `contentDisposition` vira `ResponseContentDisposition` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`, `phase-03-videos/TD-12`)
5. Os testes de integração rodam dentro do container `nestjs-api`, onde `localhost:9000` não alcança o MinIO: o setup do teste sobrescreve `S3_PUBLIC_ENDPOINT=http://minio:9000` para que as URLs assinadas sejam acessíveis a partir do container

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart de 2 partes de 5 MiB via `PUT` nas URLs assinadas → complete → `headObject` com o tamanho somado; `listParts` após 1 parte; `abortMultipartUpload` invalida o upload | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Integration (MinIO real): `presignGetObject` responde `206` a `Range: bytes=0-99` e aplica `Content-Disposition` quando informado; `putObject`/`deleteObject` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo (DI dos dois clientes) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (namespace `storage`), SI-03.2 (MinIO e bucket no Compose)

**Acceptance criteria:**

- Um objeto enviado em 2 partes via URLs assinadas e completado tem `ContentLength` igual à soma das partes
- Uma URL assinada com `audience: 'public'` usa o host de `S3_PUBLIC_ENDPOINT`; com `audience: 'internal'`, o host de `S3_ENDPOINT`
- `GET` em URL assinada com `Range: bytes=0-99` retorna `206` com 100 bytes
- Após `abortMultipartUpload`, `listParts` do mesmo `uploadId` falha com `NoSuchUpload`

---

### SI-03.4 — Entidade Video, migration e gerador de public_id

**Description:** Cria a tabela `videos` ligada ao canal, o enum de status e o gerador do ID público curto, persistência sobre a qual os endpoints e o worker operam.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — entidade `Video` com as colunas de `### Data Model → Video` verbatim (`public_id`, `channel_id`, `title`, `status`, `original_filename`, `content_type`, `declared_size_bytes`, `storage_key`, `upload_id`, `thumbnail_key`, `duration_seconds`, `width`, `height`, `video_codec`, `size_bytes`, `metadata`, `processing_error`, `created_at`, `updated_at`) e `ManyToOne` para `Channel` via `channel_id`; `export enum VideoStatus { Draft = 'draft', Processing = 'processing', Ready = 'ready', Failed = 'failed' }` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-08`)
2. Adicionar `OneToMany(() => Video)` em `src/channels/entities/channel.entity.ts`
3. Criar `src/database/migrations/<timestamp>-CreateVideos.ts` — cria o tipo `video_status`, a tabela `videos`, índice único em `public_id`, índice em `channel_id` e FK `channel_id → channels.id ON DELETE CASCADE`; `down` remove tabela e tipo
4. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com 11 caracteres de `[0-9A-Za-z]` via `crypto.randomInt` (sem dependência) (per `phase-03-videos/TD-11`)
5. Garantir que `src/database/data-source.ts` e o `createTestDataSource` dos testes enxerguem a nova entidade (mesmo mecanismo usado para `User`/`Channel`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, `status` default `draft`, FK para canal inexistente falha, cascade ao remover o canal, `metadata` jsonb round-trip | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: tamanho 11, apenas `[0-9A-Za-z]`, valores distintos em chamadas sucessivas | `src/videos/public-id.util.spec.ts` |
| `CreateVideos` migration | Integration: `migration:run` cria a tabela e `migration:revert` remove tabela e enum | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `migration:run` cria `videos` com o enum `video_status` (`draft`, `processing`, `ready`, `failed`); `migration:revert` remove a tabela e o tipo
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única
- Remover um canal remove seus vídeos (`ON DELETE CASCADE`)
- Um vídeo inserido sem `status` explícito fica `draft`

---

### SI-03.5 — Endpoint POST /videos e GET /videos/:id/upload (rascunho + upload multipart)

**Route:** POST /videos, GET /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (POST /videos); Owner (GET /videos/:id/upload)

**Description:** Pré-cadastra o vídeo como `draft` ao iniciar o upload e devolve as URLs assinadas das partes; permite retomar o upload listando as partes já enviadas.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` (`title`, `file_name`, `size_bytes`, `content_type` com as regras de `#### Validation Rules — videos`) e `src/videos/videos.exceptions.ts` com `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `InvalidVideoStatusException` (`INVALID_VIDEO_STATUS`, 409), `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 413), `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) estendendo `DomainException` (per `phase-02-auth/TD-07`)
2. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` — o canal do dono é resolvido pelo módulo de canais (responsabilidade única)
3. Criar `src/videos/videos.service.ts` — `createDraft(userId, dto)`: valida `size_bytes` ≤ `VIDEO_MAX_SIZE_BYTES` (`VideoTooLargeException`), gera `public_id` com retry em violação única (até 5 tentativas), salva `draft` com `storage_key = videos/{id}/original`, chama `createMultipartUpload` e assina `ceil(size_bytes / part_size)` URLs; `getUploadState(userId, id)`: dono ou `VideoNotFoundException`, só `draft` (senão `InvalidVideoStatusException`), `listParts` + URLs só das partes faltantes (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`, `phase-03-videos/TD-13`)
4. Criar `src/videos/videos.controller.ts` — `@Throttle({ default: { limit: 120, ttl: 60000 } })` na classe; `POST /videos` (201) e `GET /videos/:id/upload` com `ParseUUIDPipe`; usuário via `@CurrentUser()`; respostas em snake_case conforme `### API Contracts`
5. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule`) e registrá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: tamanho acima do limite, retry de `public_id` em colisão, cálculo de `part_count`, não-dono → `VIDEO_NOT_FOUND`, status ≠ `draft` → `INVALID_VIDEO_STATUS` (mock de repositório/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (DB + MinIO reais): `createDraft` persiste `draft` com `upload_id`; `getUploadState` devolve partes enviadas e URLs só das faltantes | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 (StorageService), SI-03.4 (entidade Video)

**Acceptance criteria:**

- `POST /videos` autenticado com corpo válido retorna `201` com `status: "draft"`, `public_id` de 11 caracteres e `upload.parts` com `part_count` URLs
- `POST /videos` com `size_bytes` acima de `VIDEO_MAX_SIZE_BYTES` retorna `413` com `error: "VIDEO_TOO_LARGE"` e nenhum vídeo é criado
- `POST /videos` com `content_type: "video/x-matroska"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- `GET /videos/:id/upload` de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id/upload` após enviar a parte 1 de 3 retorna `uploaded_parts` com a parte 1 e `parts` com as partes 2 e 3

---

### SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + enfileiramento)

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Conclui o multipart, valida o tamanho real, passa o vídeo para `processing` e publica o job `process-video` na fila, disparando o processamento automático.

**Technical actions:**

1. Configurar `BullModule.forRootAsync` no `AppModule` com `connection: { host, port }` e `prefix: QUEUE_PREFIX` do namespace `queue`, e `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule` (per `phase-03-videos/TD-01`)
2. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { part_number, etag }[]` com as regras de `#### Validation Rules — videos`
3. Implementar `VideosService.completeUpload(userId, id, dto)` — dono ou `VideoNotFoundException`; `processing` → re-adiciona o job com o mesmo `jobId` e retorna; `ready`/`failed` → `InvalidVideoStatusException`; `draft` → `completeMultipartUpload` (erros `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`/`NoSuchUpload` → `InvalidUploadPartsException`) → `headObject` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-02` revision)
4. Em `completeUpload` — tamanho real > `VIDEO_MAX_SIZE_BYTES`: `deleteObject`, status `failed` + `processing_error`, limpa `upload_id`, lança `VideoTooLargeException`, sem enfileirar; caso contrário salva `size_bytes`, limpa `upload_id`, status `processing` e `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: { age: 604800 } })` conforme `### Events/Messages` (per `phase-03-videos/TD-13`)
5. Adicionar `POST /videos/:id/upload/complete` (202, `{ id, status: "processing" }`) ao `VideosController`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos por status (`draft`/`processing`/`ready`/`failed`), mapeamento de erro de storage → `INVALID_UPLOAD_PARTS`, tamanho real acima do limite não enfileira (mocks de storage/fila) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais, `QUEUE_PREFIX` próprio `test-<random>` para que o `video-worker` do Compose não consuma o job): após upload real, job `process-video` existe na fila com `jobId` = id do vídeo; segunda chamada não duplica o job | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `BullModule.registerQueue` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.5 (rascunho e upload iniciado), SI-03.2 (Redis no Compose)

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` com as ETags corretas retorna `202` com `status: "processing"` e o vídeo tem `size_bytes` igual ao tamanho do objeto
- Chamar `complete` de novo com o vídeo em `processing` retorna `202` e a fila continua com um único job para o vídeo
- `complete` com uma ETag errada retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua `draft`
- `complete` cujo objeto final excede `VIDEO_MAX_SIZE_BYTES` retorna `413` com `error: "VIDEO_TOO_LARGE"`; o vídeo fica `failed` com `processing_error`, o objeto é removido do bucket e nenhum job é criado
- `complete` em vídeo `ready` retorna `409` com `error: "INVALID_VIDEO_STATUS"`

---

### SI-03.7 — Endpoint GET /videos/:id e DELETE /videos/:id (status do dono e abort)

**Route:** GET /videos/:id, DELETE /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-owner.plan.md`
**Authorization:** Owner

**Description:** Permite ao dono acompanhar o ciclo de status do vídeo (com metadados e `thumbnail_url`) e abortar um upload não concluído.

**Technical actions:**

1. Implementar `VideosService.findOwned(userId, id)` — carrega o vídeo com o canal; inexistente ou de outro dono → `VideoNotFoundException` (mesma resposta, existência não revelada)
2. Criar o mapeamento de resposta `src/videos/dto/video-response.dto.ts` com os campos snake_case de `#### GET /videos/:id`; `thumbnail_url` = `presignGetObject(thumbnail_key, { audience: 'public', ttlSeconds: VIDEO_DOWNLOAD_URL_TTL_SECONDS })` ou `null` sem `thumbnail_key`; `bigint` convertido para `number` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
3. Implementar `VideosService.abort(userId, id)` — só `draft` (senão `InvalidVideoStatusException`); `abortMultipartUpload` quando `upload_id` existe; remove o registro (per `phase-03-videos/TD-13`)
4. Adicionar `GET /videos/:id` (200) e `DELETE /videos/:id` (204) ao `VideosController` com `ParseUUIDPipe`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwned` / `abort` | Unit: não-dono → `VIDEO_NOT_FOUND`; abort fora de `draft` → `INVALID_VIDEO_STATUS`; abort sem `upload_id` não chama o storage | `src/videos/videos.service.spec.ts` |
| `VideosService.findOwned` / `abort` | Integration (DB + MinIO reais): abort encerra o multipart e remove a linha; `thumbnail_url` presente apenas com `thumbnail_key` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (controller, serviço e rascunho)

**Acceptance criteria:**

- `GET /videos/:id` pelo dono retorna `200` com `status`, metadados (`null` antes do processamento) e `thumbnail_url: null` enquanto não há thumbnail
- `GET /videos/:id` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/not-a-uuid` retorna `400` com `error: "VALIDATION_ERROR"`
- `DELETE /videos/:id` de um `draft` retorna `204`; um `GET` seguinte retorna `404` e o `upload_id` não aceita mais partes
- `DELETE /videos/:id` de um vídeo em `processing` retorna `409` com `error: "INVALID_VIDEO_STATUS"`

---

### SI-03.8 — Wrapper FFmpeg (ffprobe + thumbnail) e fixtures de vídeo

**Description:** Encapsula as chamadas a `ffprobe`/`ffmpeg` usadas pelo worker para extrair metadados e gerar o thumbnail, e cria os fixtures de vídeo gerados em tempo de teste.

**Technical actions:**

1. Criar `src/video-processing/ffmpeg.service.ts` — `probe(input)` executa `ffprobe -v error -print_format json -show_format -show_streams <input>` via `child_process.spawn` e retorna `{ durationSeconds, width, height, videoCodec, raw }` a partir do primeiro stream `codec_type = video` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-08` revision)
2. Em `FfmpegService` — `extractThumbnail(input, atSeconds)` executa `ffmpeg -ss <atSeconds> -i <input> -frames:v 1 -vf "scale='min(1280,iw)':-2" -f image2 -c:v mjpeg pipe:1` e retorna o JPEG em `Buffer`; `thumbnailTimestamp(duration)` = `duration × 0.10` ou `0` sem duração (per `phase-03-videos/TD-10`)
3. Erros tipados em `src/video-processing/ffmpeg.errors.ts`: `NoVideoStreamError` (probe sem stream de vídeo) e `MediaProbeError` (exit ≠ 0 ou JSON inválido); timeout com `kill` do processo filho
4. Criar `test/fixtures/generate-video-fixtures.ts` — gera no setup, via `ffmpeg -f lavfi`, um MP4 (`testsrc` + `sine`, poucos segundos), um WebM e um arquivo **sem stream de vídeo** (só áudio, `sine`), em diretório temporário; arquivos não são versionados
5. Entrada `input` aceita caminho local ou URL HTTP (assinada pelo `StorageService` com `audience: 'internal'`) — ffmpeg lê por `Range` (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService.probe` | Integration (ffmpeg real): MP4 gerado retorna duração/largura/altura/codec; arquivo só de áudio lança `NoVideoStreamError`; arquivo corrompido lança `MediaProbeError` | `src/video-processing/ffmpeg.service.integration-spec.ts` |
| `FfmpegService.extractThumbnail` | Integration (ffmpeg + MinIO reais): gera JPEG (magic bytes `FF D8`) a partir de URL assinada interna de um objeto no bucket | `src/video-processing/ffmpeg.service.integration-spec.ts` |
| `thumbnailTimestamp` | Unit: 10% da duração; `0` sem duração | `src/video-processing/ffmpeg.service.spec.ts` |

**Dependencies:** SI-03.2 (FFmpeg na imagem), SI-03.3 (URLs assinadas internas)

**Acceptance criteria:**

- `probe` de um MP4 de 3 s gerado por `lavfi` retorna `durationSeconds` ≈ 3 e o codec do stream de vídeo
- `probe` de um arquivo só de áudio lança `NoVideoStreamError`
- `extractThumbnail` sobre a URL assinada de um objeto no MinIO retorna um JPEG com largura ≤ 1280
- Um `ffprobe` que excede o timeout é encerrado e lança `MediaProbeError`

---

### SI-03.9 — Video worker: entrypoint, processor e serviço no Compose

**Description:** Cria o processo separado que consome a fila `video-processing`, extrai metadados, gera o thumbnail e grava o resultado (`ready`/`failed`) no banco — o worker do diagrama de arquitetura.

**Technical actions:**

1. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` com `enableShutdownHooks()` (sem servidor HTTP); `src/video-processing/worker.module.ts` importa `ConfigModule`, `TypeOrmModule.forRootAsync` (mesma `databaseConfig`), `BullModule.forRootAsync` (mesma `connection` e `prefix: QUEUE_PREFIX`) + `registerQueue('video-processing')`, `StorageModule` e `TypeOrmModule.forFeature([Video])` — sem controllers, sem throttler (per `phase-03-videos/TD-07`)
2. Criar `src/video-processing/video-processing.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`; `process(job)` segue `### Events/Messages → Processing steps`: ignora vídeo fora de `processing`; URL interna (`VIDEO_WORKER_READ_URL_TTL_SECONDS`); `probe`; `NoVideoStreamError`/`MediaProbeError` → `UnrecoverableError`; thumbnail → `putObject(videos/{id}/thumbnail.jpg, 'image/jpeg')`; grava `duration_seconds`, `width`, `height`, `video_codec`, `metadata`, `thumbnail_key`, `status = 'ready'` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
3. Falha final decidida dentro de `process()`: no `catch`, se `UnrecoverableError` **ou** `job.attemptsMade + 1 >= job.opts.attempts`, grava `status = 'failed'` + `processing_error` e relança; senão apenas relança para o BullMQ refazer com backoff. O evento `failed` do worker não é usado para persistência (per `phase-03-videos/TD-13`)
4. Adicionar scripts `start:worker` (`nest start --entryFile worker --watch`) e `start:worker:prod` (`node dist/worker`) ao `package.json`
5. Adicionar serviço `video-worker` ao `compose.yaml` — mesmo build do `Dockerfile.dev`, volume do código, `command` executando `npm run start:worker`, `depends_on` `db` / `redis` / `minio` saudáveis e `minio-init` concluído

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: decisão de falha final — `UnrecoverableError` grava `failed`; erro transitório em tentativa intermediária só relança; erro transitório na última tentativa grava `failed` e relança (mocks de repositório/ffmpeg/storage) | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration (DB + MinIO + ffmpeg reais, job invocado diretamente): vídeo MP4 real → `ready` com metadados e `thumbnail.jpg` no bucket; arquivo sem stream de vídeo → `failed` com `processing_error`; vídeo fora de `processing` não é alterado | `src/video-processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo (DI do processor, fila e storage) | `src/video-processing/worker.module.spec.ts` |

**Dependencies:** SI-03.6 (job publicado na fila), SI-03.8 (FfmpegService)

**Acceptance criteria:**

- Com `video-worker` em execução, um job `process-video` de um MP4 válido leva o vídeo a `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `metadata` e `thumbnail_key` preenchidos
- O objeto `videos/{id}/thumbnail.jpg` existe no bucket após o processamento e é um JPEG
- Um vídeo sem stream de vídeo termina `failed` com `processing_error` após uma única tentativa (sem retry)
- Um erro transitório antes da última tentativa não altera o status; na última tentativa, o vídeo fica `failed`
- `docker compose ps` mostra `video-worker` em execução e seus logs não exibem erros de conexão com Redis, banco ou MinIO

---

### SI-03.10 — Endpoint GET /videos/:publicId/stream e GET /videos/:publicId/download

**Route:** GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-stream-download.plan.md`
**Authorization:** Anonymous (somente vídeos `ready`)

**Description:** Entrega o vídeo por streaming (Range/206 servido pelo storage) e para download, via redirect 302 para URL assinada, sem passar bytes pela API.

**Technical actions:**

1. Implementar `VideosService.findReadyByPublicId(publicId)` — `publicId` fora de `^[0-9A-Za-z]{11}$`, inexistente ou com status ≠ `ready` → `VideoNotFoundException` para todos, inclusive o dono (per `phase-03-videos/TD-12` revision)
2. Implementar `VideosService.getStreamUrl(publicId)` — `presignGetObject(storage_key, { audience: 'public', ttlSeconds: VIDEO_STREAM_URL_TTL_SECONDS })` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`)
3. Implementar `VideosService.getDownloadUrl(publicId)` — mesma assinatura com `ttlSeconds: VIDEO_DOWNLOAD_URL_TTL_SECONDS` e `contentDisposition: attachment; filename="<original_filename>"` com o nome saneado (aspas e quebras de linha removidas) (per `phase-03-videos/TD-12`)
4. Adicionar `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` ao `VideosController` com `@Public()`, respondendo `302` com `Location` = URL assinada

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findReadyByPublicId` | Unit: formato inválido, inexistente e cada status ≠ `ready` → `VIDEO_NOT_FOUND`; saneamento do nome no `Content-Disposition` | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamUrl` / `getDownloadUrl` | Integration (DB + MinIO reais): URL de stream responde `206` a `Range: bytes=0-1023`; URL de download retorna `Content-Disposition: attachment` com o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (controller e serviço), SI-03.3 (`presignGetObject`)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready`, sem token, retorna `302` com `Location` assinada no host de `S3_PUBLIC_ENDPOINT`
- `GET` na URL de `Location` com `Range: bytes=0-1023` retorna `206` com 1024 bytes
- `GET /videos/:publicId/download` retorna `302` cuja URL responde com `Content-Disposition: attachment; filename="<original_filename>"`
- `GET /videos/:publicId/stream` de um vídeo em `draft`, `processing` ou `failed` retorna `404` com `error: "VIDEO_NOT_FOUND"`, mesmo com o token do dono
- `GET /videos/abc/stream` (formato inválido) retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.11 — Teste e2e do fluxo completo de vídeo (fila, worker e MinIO reais)

**Description:** Prova de ponta a ponta, com infraestrutura real do Compose, que um upload multipart chega a `ready` com thumbnail e é reproduzível por streaming — o entregável da fase.

**Technical actions:**

1. Criar `test/helpers/videos-e2e.setup.ts` — sobe a aplicação via `Test.createTestingModule({ imports: [AppModule] })` reproduzindo os globais de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); obtém `ThrottlerStorageService` via `moduleFixture.get(ThrottlerStorage)` e limpa `throttlerStorage.storage` no `beforeEach`, mesmo padrão de `test/auth.e2e-spec.ts`
2. No setup do e2e, sobrescrever env antes do bootstrap: `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` (5 MiB), `S3_PUBLIC_ENDPOINT=http://minio:9000` (URLs assinadas alcançáveis de dentro do container); `QUEUE_PREFIX` **não** é sobrescrito — mantém o padrão `bull` para que o `video-worker` real do Compose processe os jobs; fixtures gerados por `test/fixtures/generate-video-fixtures.ts` (SI-03.8) — MP4 `lavfi` com padding até ~11 MiB para forçar multipart real de 3 partes
3. Criar `test/videos-flow.e2e-spec.ts` — usuário cadastrado/confirmado/logado → `POST /videos` (~11 MiB) → `PUT` das 3 partes nas URLs assinadas coletando as `ETag` → `POST /videos/:id/upload/complete` → polling de `GET /videos/:id` (intervalo 1 s, timeout 60 s) até `ready`, processado pelo serviço `video-worker` real do Compose → `HeadObject` de `videos/{id}/thumbnail.jpg` no bucket → `GET /videos/:publicId/stream` retorna `302` e a `Location` com `Range` retorna `206`
4. No mesmo arquivo, cenário de falha com o worker real: arquivo sem stream de vídeo → `failed` com `processing_error`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo upload → processamento → streaming | E2E (supertest + Redis + MinIO + `video-worker` reais): 3 partes → `ready` + thumbnail no bucket + `302` + `206` | `test/videos-flow.e2e-spec.ts` |
| Falha de processamento | E2E: arquivo sem stream de vídeo termina `failed` | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.7 (status do dono), SI-03.9 (worker no Compose), SI-03.10 (stream)

**Acceptance criteria:**

- Um vídeo de ~11 MiB enviado em 3 partes de 5 MiB direto ao MinIO chega a `ready` em até 60 s com `duration_seconds`, `width`, `height` e `video_codec` preenchidos
- Após `ready`, `videos/{id}/thumbnail.jpg` existe no bucket e `GET /videos/:id` retorna `thumbnail_url` não nulo
- `GET /videos/:publicId/stream` retorna `302` e a URL de destino responde `206` a uma requisição com `Range`
- Um arquivo sem stream de vídeo termina `failed` com `processing_error` preenchido
- As suítes e2e de vídeo rodam com `npm run test:e2e` sem respostas `429`

---

### SI-03.12 — OpenAPI e documentação de IA (CLAUDE.md) da fase de vídeos

**Description:** Documenta os novos endpoints no OpenAPI exportado e atualiza os `CLAUDE.md` com o módulo de vídeos, a fila/worker e o storage, refletindo o estado real do código.

**Technical actions:**

1. Anotar `VideosController` e DTOs com `@nestjs/swagger` (`@ApiTags('videos')`, `@ApiBearerAuth` nas rotas do dono, respostas `201`/`202`/`204`/`302`/`404`/`409`/`413`/`429`) e regenerar o `openapi.json` com `npm run openapi:export` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)
2. Atualizar `nestjs-project/CLAUDE.md` — serviços `redis`, `minio`, `minio-init`, `video-worker`; checagens de prontidão (`redis-cli ping`, `/minio/health/live`); scripts `start:worker`; overrides de env usados nos testes (`S3_PUBLIC_ENDPOINT=http://minio:9000`, `VIDEO_UPLOAD_PART_SIZE_BYTES`)
3. Atualizar o `CLAUDE.md` da raiz — seção de vídeos: módulo `src/videos/`, `src/storage/`, `src/video-processing/`, endpoints, ciclo de status, fila BullMQ (substitui o "TBD" do Message Queue) e worker FFmpeg

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | Integration: o export contém os 7 paths de `/videos` | `src/openapi-export.integration-spec.ts` |
| Swagger UI | E2E: `/api/docs-json` lista as rotas de vídeo | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.7, SI-03.9, SI-03.10 — todos os endpoints e o worker já existem

**Acceptance criteria:**

- `openapi.json` versionado contém `POST /videos`, `GET /videos/{id}/upload`, `POST /videos/{id}/upload/complete`, `GET /videos/{id}`, `DELETE /videos/{id}`, `GET /videos/{publicId}/stream` e `GET /videos/{publicId}/download`
- Toda rota, serviço Compose e script citado nos `CLAUDE.md` existe no código e no `compose.yaml`
- O `CLAUDE.md` da raiz não descreve mais a fila como "TBD"

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

#### POST /videos (SI-03.5)

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

#### GET /videos/:id/upload (SI-03.5)

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

#### POST /videos/:id/upload/complete (SI-03.6)

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

#### GET /videos/:id (SI-03.7)

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

#### DELETE /videos/:id (SI-03.7)

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

#### GET /videos/:publicId/stream (SI-03.10)

Public streaming entry point (per `phase-03-videos/TD-12`).

**Path parameters:**
- publicId: string — 11-char base62

**Response 302:**
- Location: presigned `GetObject` URL for `videos/{id}/original`, signed with the public endpoint (per `phase-03-videos/TD-05`), TTL `VIDEO_STREAM_URL_TTL_SECONDS` (default `21600` = 6h). Storage serves `Range` requests with `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `public_id`, or status is not `ready` (same response for everyone, owner included)

---

#### GET /videos/:publicId/download (SI-03.10)

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

**Queue configuration:** `BullModule.forRootAsync` with `connection: { host: REDIS_HOST, port: REDIS_PORT }` and `prefix: QUEUE_PREFIX` (default `bull`, BullMQ's default) — API and worker must share the same prefix; integration tests that assert on queue contents use an isolated prefix (`test-<random>`) so the Compose `video-worker` does not consume their jobs.
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

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (Compose usa as variáveis S3_*/REDIS_*)
│   ├── SI-03.3 — depends on SI-03.1, SI-03.2 (namespace storage + MinIO/bucket)
│   │   ├── SI-03.5 — depends on SI-03.3, SI-03.4 (storage + entidade Video)
│   │   │   ├── SI-03.6 — depends on SI-03.5, SI-03.2 (rascunho iniciado + Redis)
│   │   │   │   └── SI-03.9 — depends on SI-03.6, SI-03.8 (job na fila + FfmpegService)
│   │   │   ├── SI-03.7 — depends on SI-03.5 (controller e serviço)
│   │   │   └── SI-03.10 — depends on SI-03.5, SI-03.3 (controller + presignGetObject)
│   │   └── SI-03.8 — depends on SI-03.2, SI-03.3 (FFmpeg na imagem + URL assinada interna)
SI-03.4 (root, independent)
└── SI-03.5 — (see above)

SI-03.11 — depends on SI-03.7, SI-03.9, SI-03.10 (fluxo completo exige status, worker e stream)
SI-03.12 — depends on SI-03.7, SI-03.9, SI-03.10 (documenta endpoints e worker existentes)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Dependências e namespaces de configuração (storage, fila, vídeo)
- [ ] SI-03.2 — Infra: Redis, MinIO, inicialização do bucket e FFmpeg no Docker
- [ ] SI-03.3 — Módulo de storage (S3/MinIO)
- [ ] SI-03.4 — Entidade Video, migration e gerador de public_id
- [ ] SI-03.5 — Endpoint POST /videos e GET /videos/:id/upload (rascunho + upload multipart)
- [ ] SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + enfileiramento)
- [ ] SI-03.7 — Endpoint GET /videos/:id e DELETE /videos/:id (status do dono e abort)
- [ ] SI-03.8 — Wrapper FFmpeg (ffprobe + thumbnail) e fixtures de vídeo
- [ ] SI-03.9 — Video worker: entrypoint, processor e serviço no Compose
- [ ] SI-03.10 — Endpoint GET /videos/:publicId/stream e GET /videos/:publicId/download
- [ ] SI-03.11 — Teste e2e do fluxo completo de vídeo (fila, worker e MinIO reais)
- [ ] SI-03.12 — OpenAPI e documentação de IA (CLAUDE.md) da fase de vídeos

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Stack sobe com `docker compose up -d` incluindo `redis`, `minio`, `minio-init` e `video-worker`
