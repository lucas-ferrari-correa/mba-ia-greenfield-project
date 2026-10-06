import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  generateVideoFixtures,
  VideoFixtures,
} from '../../test/fixtures/generate-video-fixtures';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { FfmpegService } from './ffmpeg.service';
import { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { getRepositoryToken } from '@nestjs/typeorm';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const jobFor = (videoId: string): Job<ProcessVideoJobData> =>
  ({
    data: { videoId },
    attemptsMade: 0,
    opts: { attempts: 3 },
  }) as unknown as Job<ProcessVideoJobData>;

describe('VideoProcessingProcessor (integration — DB + MinIO + ffmpeg)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let fixtures: VideoFixtures;
  let channelId: string;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    fixtures = generateVideoFixtures();
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
        FfmpegService,
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessingProcessor);
    storage = moduleRef.get(StorageService);
  }, 60000);

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await moduleRef.close();
    await dataSource.destroy();
    fixtures.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `worker_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Worker',
      nickname: `worker_${Date.now()}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  async function seedVideo(
    file: string,
    status = VideoStatus.Processing,
  ): Promise<Video> {
    const id = randomUUID();
    const key = `videos/${id}/original`;
    await storage.putObject(key, readFileSync(file), 'video/mp4');
    createdKeys.push(key, `videos/${id}/thumbnail.jpg`);
    return videoRepository.save({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'Clip',
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: '1',
      storage_key: key,
    });
  }

  it('should take a real MP4 to ready with metadata and a thumbnail', async () => {
    const video = await seedVideo(fixtures.mp4);

    await processor.process(jobFor(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.Ready);
    expect(row.duration_seconds).toBeCloseTo(3, 0);
    expect(row.width).toBe(640);
    expect(row.height).toBe(360);
    expect(row.video_codec).toBe('h264');
    expect(row.metadata).toHaveProperty('streams');
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(
      await storage.headObject(row.thumbnail_key as string),
    ).toBeGreaterThan(0);
  });

  it('should fail a file without a video stream with a non-retryable error', async () => {
    const video = await seedVideo(fixtures.audioOnly);

    await expect(processor.process(jobFor(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.Failed);
    expect(row.processing_error).toBeTruthy();
  });

  it('should leave videos outside processing untouched', async () => {
    const video = await seedVideo(fixtures.mp4, VideoStatus.Draft);

    await processor.process(jobFor(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.Draft);
    expect(row.thumbnail_key).toBeNull();
  });
});
