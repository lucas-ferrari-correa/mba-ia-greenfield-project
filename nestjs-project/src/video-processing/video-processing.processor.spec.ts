import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { NoVideoStreamError } from './ffmpeg.errors';
import { FfmpegService } from './ffmpeg.service';
import { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const config = {
  maxSizeBytes: 10737418240,
  uploadPartSizeBytes: 104857600,
  uploadUrlTtlSeconds: 3600,
  streamUrlTtlSeconds: 21600,
  downloadUrlTtlSeconds: 3600,
  workerReadUrlTtlSeconds: 900,
};

function makeJob(attemptsMade: number, attempts = 3): Job<ProcessVideoJobData> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let repository: { findOneBy: jest.Mock; update: jest.Mock; save: jest.Mock };
  let storage: { presignGetObject: jest.Mock; putObject: jest.Mock };
  let ffmpeg: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    repository = {
      findOneBy: jest.fn().mockResolvedValue(
        Object.assign(new Video(), {
          id: 'video-1',
          status: VideoStatus.Processing,
          storage_key: 'videos/video-1/original',
        }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((v: Video) => Promise.resolve(v)),
    };
    storage = {
      presignGetObject: jest.fn().mockResolvedValue('http://minio:9000/signed'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpeg = {
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 10,
        width: 640,
        height: 360,
        videoCodec: 'h264',
        raw: {},
      }),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    };
    processor = new VideoProcessingProcessor(
      repository as unknown as Repository<Video>,
      storage as unknown as StorageService,
      ffmpeg as unknown as FfmpegService,
      config,
    );
  });

  it('should mark the video ready with metadata and thumbnail', async () => {
    await processor.process(makeJob(0));

    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
      'http://minio:9000/signed',
      1,
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.Ready,
        duration_seconds: 10,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      }),
    );
  });

  it('should skip videos that are not processing', async () => {
    repository.findOneBy.mockResolvedValue(
      Object.assign(new Video(), { id: 'video-1', status: VideoStatus.Ready }),
    );

    await processor.process(makeJob(0));

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should fail immediately (no retry) when the media has no video stream', async () => {
    ffmpeg.probe.mockRejectedValue(new NoVideoStreamError());

    await expect(processor.process(makeJob(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(repository.update).toHaveBeenCalledWith('video-1', {
      status: VideoStatus.Failed,
      processing_error: 'Media has no video stream',
    });
  });

  it('should only rethrow a transient error before the last attempt', async () => {
    storage.putObject.mockRejectedValue(new Error('storage unavailable'));

    await expect(processor.process(makeJob(1))).rejects.toThrow(
      'storage unavailable',
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should mark failed and rethrow a transient error on the last attempt', async () => {
    storage.putObject.mockRejectedValue(new Error('storage unavailable'));

    await expect(processor.process(makeJob(2))).rejects.toThrow(
      'storage unavailable',
    );
    expect(repository.update).toHaveBeenCalledWith('video-1', {
      status: VideoStatus.Failed,
      processing_error: 'storage unavailable',
    });
  });
});
