import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
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
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const MiB = 1024 * 1024;
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + MinIO)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let service: VideosService;
  let videoRepository: Repository<Video>;
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
      ],
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: new ChannelsService(dataSource) },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  afterAll(async () => {
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
});
