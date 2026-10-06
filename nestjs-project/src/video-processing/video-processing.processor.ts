import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaProbeError, NoVideoStreamError } from './ffmpeg.errors';
import { FfmpegService, thumbnailTimestamp } from './ffmpeg.service';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

export const thumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video || video.status !== VideoStatus.Processing) {
      return;
    }

    try {
      await this.extractAndStore(video);
    } catch (err) {
      // Final failure is decided here, not in the worker `failed` event: that
      // event fires on every failed attempt and is not awaited.
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (err instanceof UnrecoverableError || lastAttempt) {
        await this.videoRepository.update(video.id, {
          status: VideoStatus.Failed,
          processing_error:
            err instanceof Error ? err.message : 'Video processing failed',
        });
        this.logger.warn(`Video ${video.id} failed: ${String(err)}`);
      }
      throw err;
    }
  }

  private async extractAndStore(video: Video): Promise<void> {
    const url = await this.storageService.presignGetObject(video.storage_key, {
      audience: 'internal',
      ttlSeconds: this.config.workerReadUrlTtlSeconds,
    });

    let probe: Awaited<ReturnType<FfmpegService['probe']>>;
    try {
      probe = await this.ffmpegService.probe(url);
    } catch (err) {
      if (err instanceof NoVideoStreamError || err instanceof MediaProbeError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }

    const jpeg = await this.ffmpegService.extractThumbnail(
      url,
      thumbnailTimestamp(probe.durationSeconds),
    );
    const key = thumbnailKey(video.id);
    await this.storageService.putObject(key, jpeg, 'image/jpeg');

    // save() instead of update(): update() cannot type a jsonb column.
    await this.videoRepository.save(
      Object.assign(video, {
        status: VideoStatus.Ready,
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        metadata: probe.raw,
        thumbnail_key: key,
        processing_error: null,
      }),
    );
  }
}
