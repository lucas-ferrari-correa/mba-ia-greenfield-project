import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: `owner_${counter}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'Clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: '11534336',
      storage_key: `videos/${id}/original`,
      ...overrides,
    };
  }

  it('should default status to draft', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.Draft);
  });

  it('should enforce a unique public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'AAAAAAAAAAA' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'AAAAAAAAAAA' })),
    ).rejects.toThrow();
  });

  it('should reject a channel_id that does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toThrow();
  });

  it('should delete videos when their channel is deleted', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('should round-trip metadata as jsonb', async () => {
    const metadata = { format: { duration: '3.0' }, streams: [{ index: 0 }] };
    const saved = await videoRepository.save(buildVideo({ metadata }));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
  });
});
