import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  bootstrapVideosApp,
  createConfirmedUser,
  createDraftVideo,
  MiB,
  uploadAllParts,
  uploadPart,
  VideosE2eContext,
} from './helpers/videos-e2e.setup';

interface ErrorBody {
  error: string;
}

const PENDING_STATES = [
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
] as const;

describe('videos-upload-complete', () => {
  let ctx: VideosE2eContext;
  let queue: Queue<ProcessVideoJobData>;
  let token: string;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
    queue = ctx.moduleFixture.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    ({ token } = await createConfirmedUser(ctx));
  });

  const complete = (
    target: VideosE2eContext,
    authToken: string,
    id: string,
    body: unknown,
  ) =>
    request(target.app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${authToken}`)
      .send(body as object);

  async function jobsFor(videoId: string) {
    const jobs = await queue.getJobs([...PENDING_STATES]);
    return jobs.filter((job) => job.data.videoId === videoId);
  }

  // 1. Completing an upload

  test('completes-and-enqueues', async () => {
    const draft = await createDraftVideo(ctx, token);
    const parts = await uploadAllParts(draft, 11 * MiB);

    const res = await complete(ctx, token, draft.id, { parts });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: draft.id, status: 'processing' });
    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    expect(row.status).toBe(VideoStatus.Processing);
    expect(row.size_bytes).toBe(String(11 * MiB));
    expect(row.upload_id).toBeNull();
    const job = await queue.getJob(draft.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: draft.id });
  });

  test('repeated-complete-is-idempotent', async () => {
    const draft = await createDraftVideo(ctx, token);
    const parts = await uploadAllParts(draft, 11 * MiB);
    await complete(ctx, token, draft.id, { parts }).expect(202);

    const res = await complete(ctx, token, draft.id, { parts });

    expect(res.status).toBe(202);
    expect((res.body as { status: string }).status).toBe('processing');
    expect(await jobsFor(draft.id)).toHaveLength(1);
  });

  test('rejects-invalid-parts', async () => {
    const draft = await createDraftVideo(ctx, token);
    const parts = await uploadAllParts(draft, 11 * MiB);
    const before = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    parts[1] = { ...parts[1], etag: '"deadbeef"' };

    const res = await complete(ctx, token, draft.id, { parts });

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_PARTS');
    const after = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    expect(after.status).toBe(VideoStatus.Draft);
    expect(after.upload_id).toBe(before.upload_id);
    expect(await jobsFor(draft.id)).toHaveLength(0);
  });

  test('oversized-object-fails-without-enqueue', async () => {
    const limited = await bootstrapVideosApp({
      VIDEO_MAX_SIZE_BYTES: String(8 * MiB),
    });
    const limitedQueue = limited.moduleFixture.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    try {
      const user = await createConfirmedUser(limited);
      const draft = await createDraftVideo(limited, user.token, {
        size_bytes: 8 * MiB,
      });
      expect(draft.upload.part_count).toBe(2);
      const parts = [
        {
          part_number: 1,
          etag: await uploadPart(draft.upload.parts[0].url, 5 * MiB),
        },
        {
          part_number: 2,
          etag: await uploadPart(draft.upload.parts[1].url, 5 * MiB),
        },
      ];

      const res = await complete(limited, user.token, draft.id, { parts });

      expect(res.status).toBe(413);
      expect((res.body as ErrorBody).error).toBe('VIDEO_TOO_LARGE');
      const row = await limited.dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(row.status).toBe(VideoStatus.Failed);
      expect(row.processing_error).not.toBeNull();
      await expect(
        limited.app.get(StorageService).headObject(row.storage_key),
      ).rejects.toMatchObject({ name: 'NotFound' });
      expect(await limitedQueue.getJob(draft.id)).toBeUndefined();
    } finally {
      await limitedQueue.obliterate({ force: true });
      await limited.app.close();
    }
  });

  test('rejects-complete-on-ready-video', async () => {
    const draft = await createDraftVideo(ctx, token);
    await ctx.dataSource
      .getRepository(Video)
      .update(draft.id, { status: VideoStatus.Ready });

    const res = await complete(ctx, token, draft.id, {
      parts: [{ part_number: 1, etag: '"abc"' }],
    });

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATUS');
  });
});
