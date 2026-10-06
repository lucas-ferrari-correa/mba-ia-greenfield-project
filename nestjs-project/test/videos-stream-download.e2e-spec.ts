import { readFileSync, statSync } from 'fs';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  generateVideoFixtures,
  VideoFixtures,
} from './fixtures/generate-video-fixtures';
import {
  bootstrapVideosApp,
  createConfirmedUser,
  createDraftVideo,
  DraftBody,
  uploadBuffer,
  VideosE2eContext,
} from './helpers/videos-e2e.setup';

interface ErrorBody {
  error: string;
}

describe('videos-stream-download', () => {
  let ctx: VideosE2eContext;
  let fixtures: VideoFixtures;
  let token: string;

  beforeAll(async () => {
    fixtures = generateVideoFixtures();
    ctx = await bootstrapVideosApp();
  }, 60000);

  afterAll(async () => {
    await ctx.app.close();
    fixtures.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    ({ token } = await createConfirmedUser(ctx));
  });

  const server = () => ctx.app.getHttpServer();

  /** Real upload of the MP4 fixture (single part), then marked ready in the DB. */
  async function readyVideo(fileName = 'clip.mp4'): Promise<DraftBody> {
    const bytes = readFileSync(fixtures.mp4);
    const draft = await createDraftVideo(ctx, token, {
      file_name: fileName,
      size_bytes: statSync(fixtures.mp4).size,
    });
    const etag = await uploadBuffer(draft.upload.parts[0].url, bytes);
    await request(server())
      .post(`/videos/${draft.id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(202);
    await ctx.dataSource
      .getRepository(Video)
      .update(draft.id, { status: VideoStatus.Ready });
    return draft;
  }

  // 1. Streaming

  test('ready-video-redirects-to-presigned-url', async () => {
    const video = await readyVideo();

    const res = await request(server()).get(
      `/videos/${video.public_id}/stream`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.host).toBe('minio:9000');
    expect(location.pathname).toContain(`videos/${video.id}/original`);
  });

  test('presigned-url-serves-partial-content', async () => {
    const video = await readyVideo();
    const res = await request(server()).get(
      `/videos/${video.public_id}/stream`,
    );

    const media = await fetch(res.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(media.status).toBe(206);
    expect((await media.arrayBuffer()).byteLength).toBe(1024);
    expect(media.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
  });

  test('non-ready-video-is-not-found-even-for-owner', async () => {
    const video = await readyVideo();

    for (const status of [
      VideoStatus.Draft,
      VideoStatus.Processing,
      VideoStatus.Failed,
    ]) {
      await ctx.dataSource.getRepository(Video).update(video.id, { status });

      const res = await request(server())
        .get(`/videos/${video.public_id}/stream`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    }
  });

  test('malformed-public-id-is-not-found', async () => {
    const res = await request(server()).get('/videos/abc/stream');

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  // 2. Download

  test('download-forces-attachment-with-original-name', async () => {
    const video = await readyVideo('my clip.mp4');

    const res = await request(server()).get(
      `/videos/${video.public_id}/download`,
    );
    expect(res.status).toBe(302);

    const media = await fetch(res.headers.location);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-disposition')).toBe(
      'attachment; filename="my clip.mp4"',
    );
  });
});
