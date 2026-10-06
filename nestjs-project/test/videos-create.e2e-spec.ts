import request from 'supertest';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Channel } from '../src/channels/entities/channel.entity';
import {
  bootstrapVideosApp,
  createConfirmedUser,
  MiB,
  uploadPart,
  VideosE2eContext,
} from './helpers/videos-e2e.setup';

interface DraftBody {
  id: string;
  public_id: string;
  title: string;
  status: string;
  upload: {
    part_size: number;
    part_count: number;
    parts: { part_number: number; url: string }[];
    expires_at: string;
  };
}

interface UploadStateBody {
  part_count: number;
  uploaded_parts: { part_number: number; etag: string; size: number }[];
  parts: { part_number: number; url: string }[];
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const validBody = {
  title: 'My video',
  file_name: 'clip.mp4',
  size_bytes: 11 * MiB,
  content_type: 'video/mp4',
};

describe('videos-create', () => {
  let ctx: VideosE2eContext;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    ({ token, userId } = await createConfirmedUser(ctx));
  });

  const server = () => ctx.app.getHttpServer();

  async function createDraft(authToken = token): Promise<DraftBody> {
    const res = await request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${authToken}`)
      .send(validBody)
      .expect(201);
    return res.body as DraftBody;
  }

  // 1. POST /videos

  test('creates-draft-and-returns-part-urls', async () => {
    const res = await request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody);

    expect(res.status).toBe(201);
    const draft = res.body as DraftBody;
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(draft.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
    expect(draft.title).toBe('My video');
    expect(draft.status).toBe('draft');
    expect(draft.upload.part_size).toBe(5 * MiB);
    expect(draft.upload.part_count).toBe(3);
    expect(draft.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    for (const part of draft.upload.parts) {
      expect(new URL(part.url).host).toBe('minio:9000');
    }
    expect(new Date(draft.upload.expires_at).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    const channel = await ctx.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: userId });
    expect(row.status).toBe(VideoStatus.Draft);
    expect(row.upload_id).not.toBeNull();
    expect(row.storage_key).toBe(`videos/${draft.id}/original`);
    expect(row.channel_id).toBe(channel.id);
  });

  test('rejects-size-above-limit', async () => {
    const res = await request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, size_bytes: 10737418241 });

    expect(res.status).toBe(413);
    expect(res.body as ErrorBody).toMatchObject({
      statusCode: 413,
      error: 'VIDEO_TOO_LARGE',
    });
    expect(await ctx.dataSource.getRepository(Video).count()).toBe(0);
  });

  test('rejects-unsupported-content-type', async () => {
    const res = await request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, content_type: 'video/x-matroska' });

    expect(res.status).toBe(400);
    const body = res.body as ErrorBody;
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(body.message)).toContain('content_type');
  });

  test('requires-authentication', async () => {
    const res = await request(server()).post('/videos').send(validBody);

    expect(res.status).toBe(401);
  });

  // 2. GET /videos/:id/upload

  test('hides-video-from-non-owner', async () => {
    const draft = await createDraft();
    const other = await createConfirmedUser(ctx);

    const res = await request(server())
      .get(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${other.token}`);

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  test('resumes-after-partial-upload', async () => {
    const draft = await createDraft();
    const etag = await uploadPart(draft.upload.parts[0].url, 5 * MiB);
    expect(etag).toBeTruthy();

    const res = await request(server())
      .get(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const state = res.body as UploadStateBody;
    expect(state.uploaded_parts).toEqual([
      { part_number: 1, etag, size: 5 * MiB },
    ]);
    expect(state.parts.map((p) => p.part_number)).toEqual([2, 3]);
    expect(state.part_count).toBe(3);
  });
});
