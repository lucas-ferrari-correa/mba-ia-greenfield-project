import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { ProcessVideoJobData } from '../video-processing/video-processing.constants';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import {
  InvalidUploadPartsException,
  InvalidVideoStatusException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';

const MiB = 1024 * 1024;
const config = {
  maxSizeBytes: 20 * MiB,
  uploadPartSizeBytes: 5 * MiB,
  uploadUrlTtlSeconds: 3600,
  streamUrlTtlSeconds: 21600,
  downloadUrlTtlSeconds: 3600,
  workerReadUrlTtlSeconds: 900,
};

function publicIdCollision(): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (public_id)=(abc) already exists.',
    }),
  );
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const channel = Object.assign(new Channel(), {
    id: 'channel-1',
    user_id: 'owner',
  });
  return Object.assign(new Video(), {
    id: 'video-1',
    public_id: 'AAAAAAAAAAA',
    channel_id: 'channel-1',
    channel,
    title: 'Clip',
    status: VideoStatus.Draft,
    declared_size_bytes: String(11 * MiB),
    storage_key: 'videos/video-1/original',
    upload_id: 'upload-1',
    ...overrides,
  });
}

describe('VideosService', () => {
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
    abortMultipartUpload: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let channels: { findByUserId: jest.Mock };
  let service: VideosService;

  beforeEach(() => {
    repository = {
      create: jest.fn((data: Partial<Video>) => data),
      save: jest.fn((data: Partial<Video>) => Promise.resolve(data)),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://signed/part/${partNumber}`),
      ),
      listParts: jest.fn(),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue(11 * MiB),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    channels = {
      findByUserId: jest
        .fn()
        .mockResolvedValue(Object.assign(new Channel(), { id: 'channel-1' })),
    };
    service = new VideosService(
      repository as unknown as Repository<Video>,
      storage as unknown as StorageService,
      channels as unknown as ChannelsService,
      config,
      queue as unknown as Queue<ProcessVideoJobData>,
    );
  });

  describe('createDraft', () => {
    const dto = {
      title: 'Clip',
      file_name: 'clip.mp4',
      size_bytes: 11 * MiB,
      content_type: 'video/mp4' as const,
    };

    it('should reject a declared size above the limit without touching storage', async () => {
      await expect(
        service.createDraft('owner', { ...dto, size_bytes: 20 * MiB + 1 }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('should compute part_count from the part size and sign one URL per part', async () => {
      const result = await service.createDraft('owner', dto);

      expect(result.status).toBe(VideoStatus.Draft);
      expect(result.upload.part_count).toBe(3);
      expect(result.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      expect(storage.presignUploadPart).toHaveBeenCalledTimes(3);
    });

    it('should retry with a new public_id after a public_id collision', async () => {
      repository.save
        .mockRejectedValueOnce(publicIdCollision())
        .mockImplementationOnce((data: Partial<Video>) =>
          Promise.resolve(data),
        );

      await service.createDraft('owner', dto);

      expect(repository.save).toHaveBeenCalledTimes(2);
      const createdIds = (repository.create.mock.calls as [Video][]).map(
        ([data]) => data.public_id,
      );
      const [firstId, secondId] = createdIds;
      expect(firstId).not.toBe(secondId);
    });

    it('should abort the multipart upload when the draft cannot be saved', async () => {
      repository.save.mockRejectedValue(new Error('db down'));

      await expect(service.createDraft('owner', dto)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-1',
      );
    });
  });

  describe('getUploadState', () => {
    it('should hide videos owned by another user', async () => {
      repository.findOne.mockResolvedValue(makeVideo());

      await expect(
        service.getUploadState('someone-else', 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should report a missing video as not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getUploadState('owner', 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject videos that are no longer drafts', async () => {
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.Processing, upload_id: null }),
      );

      await expect(
        service.getUploadState('owner', 'video-1'),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
    });

    it('should sign URLs only for the parts not yet uploaded', async () => {
      repository.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"e1"', size: 5 * MiB },
      ]);

      const state = await service.getUploadState('owner', 'video-1');

      expect(state.uploaded_parts).toEqual([
        { part_number: 1, etag: '"e1"', size: 5 * MiB },
      ]);
      expect(state.parts.map((p) => p.part_number)).toEqual([2, 3]);
    });
  });

  describe('completeUpload', () => {
    const dto = { parts: [{ part_number: 1, etag: '"e1"' }] };

    function storageError(name: string): Error {
      return Object.assign(new Error(name), { name });
    }

    it('should complete the upload, record the size and enqueue with jobId = video id', async () => {
      repository.findOne.mockResolvedValue(makeVideo());

      const result = await service.completeUpload('owner', 'video-1', dto);

      expect(result).toEqual({ id: 'video-1', status: VideoStatus.Processing });
      expect(repository.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.Processing,
        upload_id: null,
        size_bytes: String(11 * MiB),
      });
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        expect.objectContaining({ jobId: 'video-1', attempts: 3 }),
      );
    });

    it('should re-add the job without completing again when already processing', async () => {
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.Processing, upload_id: null }),
      );

      const result = await service.completeUpload('owner', 'video-1', dto);

      expect(result.status).toBe(VideoStatus.Processing);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        expect.objectContaining({ jobId: 'video-1' }),
      );
    });

    it.each([VideoStatus.Ready, VideoStatus.Failed])(
      'should reject completion of a %s video',
      async (status) => {
        repository.findOne.mockResolvedValue(
          makeVideo({ status, upload_id: null }),
        );

        await expect(
          service.completeUpload('owner', 'video-1', dto),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      },
    );

    it.each([
      'InvalidPart',
      'InvalidPartOrder',
      'EntityTooSmall',
      'NoSuchUpload',
    ])(
      'should map storage %s to INVALID_UPLOAD_PARTS and keep the draft',
      async (name) => {
        repository.findOne.mockResolvedValue(makeVideo());
        storage.completeMultipartUpload.mockRejectedValue(storageError(name));

        await expect(
          service.completeUpload('owner', 'video-1', dto),
        ).rejects.toBeInstanceOf(InvalidUploadPartsException);
        expect(repository.update).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('should propagate unexpected storage errors', async () => {
      repository.findOne.mockResolvedValue(makeVideo());
      storage.completeMultipartUpload.mockRejectedValue(
        storageError('InternalError'),
      );

      await expect(
        service.completeUpload('owner', 'video-1', dto),
      ).rejects.toThrow('InternalError');
    });

    it('should fail the video and skip the queue when the stored object exceeds the limit', async () => {
      repository.findOne.mockResolvedValue(makeVideo());
      storage.headObject.mockResolvedValue(20 * MiB + 1);

      await expect(
        service.completeUpload('owner', 'video-1', dto),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repository.update).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          status: VideoStatus.Failed,
          upload_id: null,
          processing_error: expect.any(String) as string,
        }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
