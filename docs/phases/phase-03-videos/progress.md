# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/12 completed

### SI-03.1 — Infra: Dependências e namespaces de configuração (storage, fila, vídeo)
- **Status:** completed
- **Tests:** 10 passing (`src/config/env.validation.integration-spec.ts`)
- **Observations:**
  - `npm install` gravou ranges com caret (`^6.3.11`, `^12.0.0`, `^5.11.1`, `^3.1146.0`) no `package.json`, como as dependências da fase 02; as versões exatas ficam travadas no `package-lock.json`.
  - `.env` local (ignorado pelo git) recebeu as mesmas novas chaves do `.env.example` para que app e testes continuem subindo.

### SI-03.2 — Infra: Redis, MinIO, inicialização do bucket e FFmpeg no Docker
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verificados manualmente; suíte existente verde (150 unit/integration, 52 e2e)
- **Observations:**
  - Healthcheck do `minio` usa `mc ready local` (via `MC_HOST_local`) porque a imagem `coollabsio/minio` não traz `curl`; `/minio/health/live` segue sendo o endpoint que o `mc ready` consulta.
  - CORS: `MINIO_API_CORS_ALLOW_ORIGIN=*`; verificado que a resposta expõe `Etag` em `Access-Control-Expose-Headers` e que o preflight `PUT` é aceito.
  - Redis sem porta publicada no host: a 6379 do host já está ocupada por outro container e nenhum consumidor fora da rede do Compose precisa dela.

### SI-03.3 — Módulo de storage (S3/MinIO)
- **Status:** completed
- **Tests:** 8 passing (`src/storage/storage.service.integration-spec.ts`, `src/storage/storage.module.spec.ts`); suíte unit/integration completa verde (158)
- **Observations:**
  - Os dois `S3Client` usam `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`: desde o SDK 3.729 o cliente calcula CRC32 por padrão em `UploadPart`, o que não cabe em URLs assinadas cujo corpo é enviado pelo cliente (doc AWS SDK, issue 6810).
  - Clientes injetados por tokens (`S3_CLIENT`, `S3_SIGNING_CLIENT`) em `storage.constants.ts`; objetos de teste vão para o prefixo `test/<uuid>/` e são removidos no `afterAll`.

### SI-03.4 — Entidade Video, migration e gerador de public_id
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos e GET /videos/:id/upload (rascunho + upload multipart)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + enfileiramento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint GET /videos/:id e DELETE /videos/:id (status do dono e abort)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Wrapper FFmpeg (ffprobe + thumbnail) e fixtures de vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video worker: entrypoint, processor e serviço no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/:publicId/stream e GET /videos/:publicId/download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Teste e2e do fluxo completo de vídeo (fila, worker e MinIO reais)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — OpenAPI e documentação de IA (CLAUDE.md) da fase de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
