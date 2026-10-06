import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { User } from '../../src/users/entities/user.entity';

export const MiB = 1024 * 1024;

export interface VideosE2eContext {
  app: INestApplication<App>;
  moduleFixture: TestingModule;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}

/**
 * Boots the full AppModule like main.ts does. Env overrides must be applied
 * before compile because config namespaces read process.env at init time.
 *
 * - S3_PUBLIC_ENDPOINT=http://minio:9000 so presigned URLs are reachable
 *   from inside the nestjs-api container.
 * - VIDEO_UPLOAD_PART_SIZE_BYTES=5 MiB (S3 minimum part size) for small
 *   real multipart uploads.
 * - QUEUE_PREFIX=test-<random> by default so the Compose video-worker never
 *   consumes jobs created by these suites; pass `{ QUEUE_PREFIX: undefined }`
 *   to keep the default prefix and let the real worker process them.
 */
export async function bootstrapVideosApp(
  env: Record<string, string | undefined> = {},
): Promise<VideosE2eContext> {
  const overrides: Record<string, string | undefined> = {
    S3_PUBLIC_ENDPOINT: 'http://minio:9000',
    VIDEO_UPLOAD_PART_SIZE_BYTES: String(5 * MiB),
    QUEUE_PREFIX: `test-${randomUUID()}`,
    ...env,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    moduleFixture,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

let userCounter = 0;

/** Registers a user, confirms it directly in the DB and returns its access token. */
export async function createConfirmedUser(
  ctx: VideosE2eContext,
): Promise<{ token: string; userId: string; email: string }> {
  const email = `videos_e2e_${Date.now()}_${++userCounter}@example.com`;
  const password = 'password123';
  const server = ctx.app.getHttpServer();

  await request(server)
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await ctx.dataSource
    .getRepository(User)
    .update({ email }, { is_confirmed: true });
  const login = await request(server)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const user = await ctx.dataSource
    .getRepository(User)
    .findOneByOrFail({ email });

  return {
    token: (login.body as { access_token: string }).access_token,
    userId: user.id,
    email,
  };
}

/** PUTs `size` bytes to a presigned part URL and returns the ETag. */
export async function uploadPart(
  url: string,
  size: number,
  fill = 1,
): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: Buffer.alloc(size, fill),
  });
  if (response.status !== 200) {
    throw new Error(
      `Part upload failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response.headers.get('etag') as string;
}
