import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  bootstrapVideosApp,
  createConfirmedUser,
  createDraftVideo,
  MiB,
  VideosE2eContext,
} from './helpers/videos-e2e.setup';

interface VideoBody {
  id: string;
  public_id: string;
  title: string;
  status: string;
  original_filename: string;
  content_type: string;
  size_bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  thumbnail_url: string | null;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ErrorBody {
  error: string;
}

describe('videos-owner', () => {
  let ctx: VideosE2eContext;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    ownerToken = (await createConfirmedUser(ctx)).token;
    otherToken = (await createConfirmedUser(ctx)).token;
  });

  const server = () => ctx.app.getHttpServer();

  // 1. GET /videos/:id

  test('owner-sees-draft-status', async () => {
    const draft = await createDraftVideo(ctx, ownerToken);

    const res = await request(server())
      .get(`/videos/${draft.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const body = res.body as VideoBody;
    expect(body).toMatchObject({
      id: draft.id,
      public_id: draft.public_id,
      title: 'My video',
      status: 'draft',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      processing_error: null,
      thumbnail_url: null,
    });
    expect(new Date(body.created_at).getTime()).not.toBeNaN();
    expect(new Date(body.updated_at).getTime()).not.toBeNaN();
  });

  test('non-owner-gets-not-found', async () => {
    const draft = await createDraftVideo(ctx, ownerToken);

    const res = await request(server())
      .get(`/videos/${draft.id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  test('rejects-non-uuid-id', async () => {
    const res = await request(server())
      .get('/videos/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  // 2. DELETE /videos/:id

  test('deletes-draft-and-aborts-upload', async () => {
    const draft = await createDraftVideo(ctx, ownerToken);
    const partOneUrl = draft.upload.parts[0].url;

    await request(server())
      .delete(`/videos/${draft.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);

    const res = await request(server())
      .get(`/videos/${draft.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const put = await fetch(partOneUrl, {
      method: 'PUT',
      body: Buffer.alloc(5 * MiB, 1),
    });
    expect(put.status).toBe(404);
    expect(await put.text()).toContain('NoSuchUpload');
  });

  test('rejects-delete-outside-draft', async () => {
    const draft = await createDraftVideo(ctx, ownerToken);
    await ctx.dataSource
      .getRepository(Video)
      .update(draft.id, { status: VideoStatus.Processing });

    const res = await request(server())
      .delete(`/videos/${draft.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATUS');
    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    expect(row.status).toBe(VideoStatus.Processing);
  });
});
