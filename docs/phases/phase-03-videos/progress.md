# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 11/12 completed

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
- **Status:** completed
- **Tests:** 9 passing (`video.entity.integration-spec.ts`, `public-id.util.spec.ts`, `migrations.integration-spec.ts`); suíte unit/integration completa verde (165)
- **Observations:**
  - Ação 2 (`OneToMany(() => Video)` em `Channel`) não aplicada, com aprovação do usuário: o lado inverso obrigaria incluir `Video` nos entity arrays explícitos de 11 testes existentes (auth, users, channels, migrations); nenhum SI da fase usa `channel.videos`. A relação fica apenas `ManyToOne` Video → Channel.
  - Migration gerada pelo CLI (`migration:generate`), com `enumName: 'video_status'` na entidade para o tipo bater com o Data Model.
  - O teste de migrations agora reverte a última migration (`CreateVideos`) e verifica a remoção da tabela `videos` e do tipo `video_status`.

### SI-03.5 — Endpoint POST /videos e GET /videos/:id/upload (rascunho + upload multipart)
- **Status:** completed
- **Tests:** 45 passing nos arquivos do SI (unit/integration/módulo de `src/videos` e `src/channels`) + 6 e2e de `test/videos-create.e2e-spec.ts` (spec `videos-create.plan.md`); suítes completas verdes (178 unit/integration, 58 e2e)
- **Observations:**
  - Anotações `@nestjs/swagger` aplicadas já no `VideosController` e nos DTOs de resposta (`dto/upload-session.dto.ts`), seguindo `.claude/rules/nestjs-controllers.md` (endpoint sem OpenAPI é incompleto); o SI-03.12 fica com o export do `openapi.json` e o CLAUDE.md.
  - `test/helpers/videos-e2e.setup.ts` (planejado no SI-03.11) criado agora, porque os e2e gerados pelos specs dos SIs de endpoint precisam do mesmo bootstrap (overrides de env, `QUEUE_PREFIX` isolado, limpeza do throttler, usuário confirmado).
  - `createDraft` aborta o multipart se o insert do rascunho falhar, para não deixar upload órfão no bucket.
  - Correção fora do escopo do SI, em commit próprio (`8c41191`): `npm run test:e2e` não tinha `--runInBand` (o `nestjs-project/CLAUDE.md` já dizia que tinha); com 4 suítes no mesmo banco, auth e videos apagavam os dados umas das outras.

### SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + enfileiramento)
- **Status:** completed
- **Tests:** 30 passing em `src/videos` (unit/integration/módulo) + 5 e2e de `test/videos-upload-complete.e2e-spec.ts` (spec `videos-upload-complete.plan.md`); suítes completas verdes
- **Observations:**
  - `@nestjs/bullmq` fixado em `11.0.5` em vez de `12.0.0` (aprovado pelo usuário; commit `2cbf211`): a 12.0.0 e a `@nestjs/bull-shared@12.0.0` são ESM-only e não carregam no projeto CommonJS sob ts-jest. Registrado como revisão da TD-01 no doc de decisões, no `context.md` (só a linha de versão) e no `library-refs.md`; `sources_mtime` de `library-refs.md`, `context.md` e `validation.md` atualizados.
  - Fila, nome do job, payload e opções ficam em `src/video-processing/video-processing.constants.ts`, compartilhado entre API (produtor) e worker (SI-03.9).
  - Testes de integração e e2e usam `QUEUE_PREFIX` isolado e fazem `obliterate` da fila no `afterAll`, para não deixar chaves no Redis compartilhado.
  - Um `prettier --write src` reformatou sem querer os templates `.hbs` de e-mail; revertido antes do commit.
  - O commit do SI (`3aa62cd`) foi feito com a suíte unit/integration vermelha por erro de encadeamento de comandos (commit não condicionado ao resultado). Causa: `migrations.integration-spec.ts` (alterado no SI-03.4) derrubava tabelas com `Promise.all`; com a nova FK `videos → channels`, os `DROP ... CASCADE` concorrentes davam deadlock intermitente e deixavam o banco pela metade. Corrigido em commit seguinte (DROPs sequenciais); suíte verde em 3 execuções seguidas (190) e e2e verde (63).

### SI-03.7 — Endpoint GET /videos/:id e DELETE /videos/:id (status do dono e abort)
- **Status:** completed
- **Tests:** 40 passing em `src/videos` (unit/integration/módulo) + 5 e2e de `test/videos-owner.e2e-spec.ts` (spec `videos-owner.plan.md`); suítes completas verdes
- **Observations:**
  - Mapeamento de resposta como `VideosService.getOwned` + `dto/video-response.dto.ts` (com `@ApiProperty`), em vez de função de mapeamento no próprio DTO; `findOwned` (SI-03.5) reaproveitado para o 404 de não-dono.

### SI-03.8 — Wrapper FFmpeg (ffprobe + thumbnail) e fixtures de vídeo
- **Status:** completed
- **Tests:** 11 passing (`ffmpeg.service.integration-spec.ts`, `ffmpeg.service.spec.ts`); suíte unit/integration completa verde
- **Observations:**
  - Timeout testado com um servidor TCP local que aceita a conexão e nunca responde (o `ffprobe` fica preso na entrada HTTP até ser morto).
  - `test/fixtures/generate-video-fixtures.ts` também exporta `generateMp4(path, { durationSeconds, bitrate })` para o SI-03.11 gerar o MP4 de ~11 MiB com bitrate constante.

### SI-03.9 — Video worker: entrypoint, processor e serviço no Compose
- **Status:** completed
- **Tests:** 20 passing em `src/video-processing` (processor unit/integration, módulo, ffmpeg); suítes completas verdes; `video-worker` sobe no Compose e conecta ao Redis
- **Observations:**
  - Regra de falha final confirmada na doc do BullMQ (context7): `attemptsMade` começa em 0 e só incrementa na falha, então `attemptsMade + 1 >= opts.attempts` identifica a última tentativa.
  - Só erros do `probe` (`NoVideoStreamError`, `MediaProbeError`) viram `UnrecoverableError`; falhas na extração do thumbnail ou no storage seguem o retry com backoff.
  - `bullRootOptions` (`src/video-processing/queue.options.ts`) compartilhado entre `AppModule` e `WorkerModule`, garantindo o mesmo `prefix` na API e no worker.
  - Gravação do estado `ready` usa `save()` em vez de `update()`: o tipo de `update()` do TypeORM não aceita a coluna `jsonb` (`metadata`).
  - `WorkerModule` registra as entidades `Video`, `Channel` e `User` explicitamente (a cadeia de relações exige as três) em vez de `autoLoadEntities`.
  - API e worker compartilham o bind mount e o `dist/`; se o dev server da API (`start:dev`) e o worker rodarem em watch ao mesmo tempo, ambos compilam para o mesmo `dist/`.
  - Corrigido após o SI (pedido do usuário, commit próprio): com `deleteOutDir: true`, os dois `nest start --watch` apagavam o build um do outro. O worker agora compila com `tsconfig.worker.json` (estende `tsconfig.build.json`, `outDir: dist-worker`) via `nest start --path tsconfig.worker.json` — a doc do Nest CLI (context7) confirma que `--path` escolhe o tsconfig e que `deleteOutDir` remove só o `outDir` desse tsconfig. `start:worker:prod` aponta para `dist-worker/worker`; `dist-worker` no `.gitignore` e no `exclude` de `tsconfig.json`/`tsconfig.build.json`. Verificado: `docker compose down && docker compose up -d` sobe API e worker; com API em `start:dev` e worker em watch, editar `src/app.service.ts` recompila e reinicia o worker em `dist-worker/` sem apagar o `dist/` da API (que segue respondendo 200). Um `touch` feito no host não dispara o watch (eventos de arquivo do bind mount do Docker Desktop); a edição de conteúdo dentro do container dispara.

### SI-03.10 — Endpoint GET /videos/:publicId/stream e GET /videos/:publicId/download
- **Status:** completed
- **Tests:** 53 passing em `src/videos` + 5 e2e de `test/videos-stream-download.e2e-spec.ts` (spec `videos-stream-download.plan.md`); suítes completas verdes
- **Observations:**
  - Redirect via `@Redirect(undefined, 302)` retornando `{ url }`, sem acesso direto ao `Response` do Express.
  - O teste de download usa `GET` na URL assinada: a assinatura cobre o método HTTP, então um `HEAD` responde 403.

### SI-03.11 — Teste e2e do fluxo completo de vídeo (fila, worker e MinIO reais)
- **Status:** completed
- **Tests:** 2 e2e em `test/videos-flow.e2e-spec.ts` contra o `video-worker` real do Compose (upload de ~11,2 MiB em 3 partes → `ready` com metadados e thumbnail → stream `302` → `206`; arquivo sem stream de vídeo → `failed`); suítes completas verdes
- **Observations:**
  - `test/helpers/videos-e2e.setup.ts` já existia desde o SI-03.5 (ação 1 antecipada); este SI usa `bootstrapVideosApp({ QUEUE_PREFIX: undefined })` para manter o prefixo padrão e deixar o worker real consumir os jobs.
  - O MP4 de ~11 MiB é gerado no teste com `generateMp4(..., { durationSeconds: 4, bitrate: '24M' })`; `-x264-params nal-hrd=cbr` foi adicionado ao gerador para o bitrate constante atingir o tamanho alvo.
  - Objetos criados no bucket (original e thumbnail) são removidos no `afterAll`.

### SI-03.12 — OpenAPI e documentação de IA (CLAUDE.md) da fase de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
