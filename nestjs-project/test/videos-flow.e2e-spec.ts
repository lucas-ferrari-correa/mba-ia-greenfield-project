import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  generateMp4,
  generateVideoFixtures,
  VideoFixtures,
} from './fixtures/generate-video-fixtures';
import {
  bootstrapVideosApp,
  createConfirmedUser,
  createDraftVideo,
  DraftBody,
  MiB,
  uploadBuffer,
  VideosE2eContext,
} from './helpers/videos-e2e.setup';

interface VideoBody {
  status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  thumbnail_url: string | null;
  processing_error: string | null;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60000;

/**
 * Full flow with real infrastructure: multipart upload straight to MinIO,
 * BullMQ on Redis and the Compose `video-worker` process. QUEUE_PREFIX keeps
 * the default so the real worker consumes the jobs.
 */
describe('videos-flow', () => {
  let ctx: VideosE2eContext;
  let storage: StorageService;
  let fixtures: VideoFixtures;
  let bigVideo: string;
  let token: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    fixtures = generateVideoFixtures();
    // ~11.2 MiB at constant bitrate → 3 parts of 5 MiB (real multipart).
    bigVideo = generateMp4(join(fixtures.dir, 'big.mp4'), {
      durationSeconds: 4,
      bitrate: '24M',
    });
    ctx = await bootstrapVideosApp({ QUEUE_PREFIX: undefined });
    storage = ctx.app.get(StorageService);
  }, 120000);

  afterAll(async () => {
    for (const id of createdIds) {
      await storage.deleteObject(`videos/${id}/original`);
      await storage.deleteObject(`videos/${id}/thumbnail.jpg`);
    }
    await ctx.app.close();
    fixtures.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    ({ token } = await createConfirmedUser(ctx));
  });

  const server = () => ctx.app.getHttpServer();

  async function uploadFile(file: string): Promise<DraftBody> {
    const bytes = readFileSync(file);
    const draft = await createDraftVideo(ctx, token, {
      size_bytes: statSync(file).size,
    });
    createdIds.push(draft.id);
    const parts: { part_number: number; etag: string }[] = [];
    for (const part of draft.upload.parts) {
      const start = (part.part_number - 1) * draft.upload.part_size;
      parts.push({
        part_number: part.part_number,
        etag: await uploadBuffer(
          part.url,
          bytes.subarray(start, start + draft.upload.part_size),
        ),
      });
    }
    await request(server())
      .post(`/videos/${draft.id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(202);
    return draft;
  }

  async function waitForStatus(
    id: string,
    expected: string[],
  ): Promise<VideoBody> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await request(server())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as VideoBody;
      if (expected.includes(body.status)) return body;
      if (Date.now() > deadline) {
        throw new Error(
          `Video ${id} still ${body.status} after ${POLL_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  test('uploads in three parts, is processed by the worker and streams with Range', async () => {
    const draft = await uploadFile(bigVideo);
    expect(draft.upload.part_count).toBe(3);
    expect(statSync(bigVideo).size).toBeGreaterThan(10 * MiB);

    const video = await waitForStatus(draft.id, ['ready', 'failed']);

    expect(video.status).toBe('ready');
    expect(video.duration_seconds).toBeCloseTo(4, 0);
    expect(video.width).toBe(640);
    expect(video.height).toBe(360);
    expect(video.video_codec).toBe('h264');
    expect(video.thumbnail_url).not.toBeNull();
    expect(
      await storage.headObject(`videos/${draft.id}/thumbnail.jpg`),
    ).toBeGreaterThan(0);

    const stream = await request(server()).get(
      `/videos/${draft.public_id}/stream`,
    );
    expect(stream.status).toBe(302);
    const media = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(media.status).toBe(206);
    expect((await media.arrayBuffer()).byteLength).toBe(1024);
  }, 120000);

  test('ends failed when the uploaded file has no video stream', async () => {
    const draft = await uploadFile(fixtures.audioOnly);

    const video = await waitForStatus(draft.id, ['ready', 'failed']);

    expect(video.status).toBe('failed');
    expect(video.processing_error).toBeTruthy();
  }, 120000);
});
