import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const MiB = 1024 * 1024;
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + MinIO)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let service: VideosService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let ownerId: string;
  let counter = 0;
  const savedEnv = {
    S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT,
    VIDEO_UPLOAD_PART_SIZE_BYTES: process.env.VIDEO_UPLOAD_PART_SIZE_BYTES,
  };

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(5 * MiB);
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
        // Isolated prefix: the Compose video-worker must not consume these jobs.
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: `test-${randomUUID()}`,
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: new ChannelsService(dataSource) },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
    await dataSource.destroy();
    process.env.S3_PUBLIC_ENDPOINT = savedEnv.S3_PUBLIC_ENDPOINT;
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES =
      savedEnv.VIDEO_UPLOAD_PART_SIZE_BYTES;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${++counter}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: `videos_svc_${counter}`,
      user_id: user.id,
    });
    ownerId = user.id;
  });

  const dto = {
    title: 'Clip',
    file_name: 'clip.mp4',
    size_bytes: 11 * MiB,
    content_type: 'video/mp4' as const,
  };

  it('should persist a draft with an open multipart upload', async () => {
    const draft = await service.createDraft(ownerId, dto);

    const row = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(row.status).toBe(VideoStatus.Draft);
    expect(row.upload_id).toBeTruthy();
    expect(row.storage_key).toBe(`videos/${draft.id}/original`);
    expect(draft.upload.part_count).toBe(3);
  });

  it('should return uploaded parts and URLs only for the missing ones', async () => {
    const draft = await service.createDraft(ownerId, dto);
    const response = await fetch(draft.upload.parts[0].url, {
      method: 'PUT',
      body: Buffer.alloc(5 * MiB, 1),
    });
    expect(response.status).toBe(200);

    const state = await service.getUploadState(ownerId, draft.id);

    expect(state.uploaded_parts).toEqual([
      {
        part_number: 1,
        etag: response.headers.get('etag'),
        size: 5 * MiB,
      },
    ]);
    expect(state.parts.map((p) => p.part_number)).toEqual([2, 3]);
  });

  async function uploadAllParts(draft: {
    upload: { parts: { part_number: number; url: string }[] };
  }) {
    const parts: { part_number: number; etag: string }[] = [];
    for (const part of draft.upload.parts) {
      const response = await fetch(part.url, {
        method: 'PUT',
        body: Buffer.alloc(part.part_number < 3 ? 5 * MiB : MiB, 1),
      });
      expect(response.status).toBe(200);
      parts.push({
        part_number: part.part_number,
        etag: response.headers.get('etag') as string,
      });
    }
    return parts;
  }

  it('should enqueue process-video with jobId = video id after completion', async () => {
    const draft = await service.createDraft(ownerId, dto);
    const parts = await uploadAllParts(draft);

    const result = await service.completeUpload(ownerId, draft.id, { parts });

    expect(result.status).toBe(VideoStatus.Processing);
    const row = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(row.size_bytes).toBe(String(11 * MiB));
    const job = await queue.getJob(draft.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: draft.id });
  });

  it('should not duplicate the job when completion is repeated', async () => {
    const draft = await service.createDraft(ownerId, dto);
    const parts = await uploadAllParts(draft);
    await service.completeUpload(ownerId, draft.id, { parts });

    await service.completeUpload(ownerId, draft.id, { parts });

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((job) => job.id === draft.id)).toHaveLength(1);
  });

  it('should abort the multipart upload and remove the draft row', async () => {
    const draft = await service.createDraft(ownerId, dto);

    await service.abort(ownerId, draft.id);

    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
    const response = await fetch(draft.upload.parts[0].url, {
      method: 'PUT',
      body: Buffer.alloc(5 * MiB, 1),
    });
    expect(response.status).toBe(404);
  });

  it('should expose thumbnail_url only once a thumbnail key is stored', async () => {
    const draft = await service.createDraft(ownerId, dto);
    expect(
      (await service.getOwned(ownerId, draft.id)).thumbnail_url,
    ).toBeNull();

    await videoRepository.update(draft.id, {
      thumbnail_key: `videos/${draft.id}/thumbnail.jpg`,
    });

    const url = (await service.getOwned(ownerId, draft.id)).thumbnail_url;
    expect(url).not.toBeNull();
    expect(new URL(url as string).pathname).toContain(
      `videos/${draft.id}/thumbnail.jpg`,
    );
  });

  it('should stream a ready video through a URL that honors Range', async () => {
    const draft = await service.createDraft(ownerId, dto);
    const parts = await uploadAllParts(draft);
    await service.completeUpload(ownerId, draft.id, { parts });
    await videoRepository.update(draft.id, { status: VideoStatus.Ready });

    const url = await service.getStreamUrl(draft.public_id);
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });

  it('should download with Content-Disposition attachment and the original name', async () => {
    const draft = await service.createDraft(ownerId, {
      ...dto,
      file_name: 'my clip.mp4',
    });
    const parts = await uploadAllParts(draft);
    await service.completeUpload(ownerId, draft.id, { parts });
    await videoRepository.update(draft.id, { status: VideoStatus.Ready });

    const url = await service.getDownloadUrl(draft.public_id);
    // Presigned for GET: the signature covers the method, so HEAD would be 403.
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="my clip.mp4"',
    );
  });
});
