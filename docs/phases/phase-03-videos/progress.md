# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/12 completed

### SI-03.1 — Infra: Dependências e namespaces de configuração (storage, fila, vídeo)
- **Status:** completed
- **Tests:** 10 passing (`src/config/env.validation.integration-spec.ts`)
- **Observations:**
  - `npm install` gravou ranges com caret (`^6.3.11`, `^12.0.0`, `^5.11.1`, `^3.1146.0`) no `package.json`, como as dependências da fase 02; as versões exatas ficam travadas no `package-lock.json`.
  - `.env` local (ignorado pelo git) recebeu as mesmas novas chaves do `.env.example` para que app e testes continuem subindo.

### SI-03.2 — Infra: Redis, MinIO, inicialização do bucket e FFmpeg no Docker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Módulo de storage (S3/MinIO)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
