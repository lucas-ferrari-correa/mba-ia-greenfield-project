import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing/video-processing.constants';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoProcessingResponseDto } from './dto/video-status-response.dto';
import {
  PresignedPartDto,
  UploadStateResponseDto,
  VideoDraftResponseDto,
} from './dto/upload-session.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId, PUBLIC_ID_PATTERN } from './public-id.util';
import { originalKey, PUBLIC_ID_MAX_ATTEMPTS } from './videos.constants';
import {
  InvalidUploadPartsException,
  InvalidVideoStatusException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';
const INVALID_PARTS_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

/** Strips characters that would break or inject into a quoted header value. */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/["\\\r\n]/g, '').trim();
  return cleaned || 'video';
}

function isInvalidPartsError(err: unknown): boolean {
  return err instanceof Error && INVALID_PARTS_ERRORS.has(err.name);
}

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err.driverError as {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes('public_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<VideoDraftResponseDto> {
    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = originalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );
    let video: Video;
    try {
      video = await this.insertWithUniquePublicId({
        id,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.Draft,
        original_filename: dto.file_name,
        content_type: dto.content_type,
        declared_size_bytes: String(dto.size_bytes),
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (err) {
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const partCount = this.partCount(dto.size_bytes);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      upload: {
        part_size: this.config.uploadPartSizeBytes,
        part_count: partCount,
        parts: await this.presignParts(storageKey, uploadId, partNumbers),
        expires_at: this.uploadUrlsExpireAt(),
      },
    };
  }

  async getUploadState(
    userId: string,
    id: string,
  ): Promise<UploadStateResponseDto> {
    const video = await this.findOwned(userId, id);
    if (video.status !== VideoStatus.Draft || !video.upload_id) {
      throw new InvalidVideoStatusException();
    }

    const uploaded = await this.storageService.listParts(
      video.storage_key,
      video.upload_id,
    );
    const uploadedNumbers = new Set(uploaded.map((part) => part.partNumber));
    const partCount = this.partCount(Number(video.declared_size_bytes));
    const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter(
      (partNumber) => !uploadedNumbers.has(partNumber),
    );

    return {
      part_size: this.config.uploadPartSizeBytes,
      part_count: partCount,
      uploaded_parts: uploaded.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size: part.size,
      })),
      parts: await this.presignParts(
        video.storage_key,
        video.upload_id,
        missing,
      ),
      expires_at: this.uploadUrlsExpireAt(),
    };
  }

  async completeUpload(
    userId: string,
    id: string,
    dto: CompleteUploadDto,
  ): Promise<VideoProcessingResponseDto> {
    const video = await this.findOwned(userId, id);

    if (video.status === VideoStatus.Processing) {
      // Idempotent retry: same jobId never creates a duplicate job.
      await this.enqueueProcessing(video.id);
      return { id: video.id, status: video.status };
    }
    if (video.status !== VideoStatus.Draft || !video.upload_id) {
      throw new InvalidVideoStatusException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (err) {
      if (isInvalidPartsError(err)) throw new InvalidUploadPartsException();
      throw err;
    }

    const actualSize = await this.storageService.headObject(video.storage_key);
    if (actualSize > this.config.maxSizeBytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.update(video.id, {
        status: VideoStatus.Failed,
        upload_id: null,
        processing_error: `Uploaded object has ${actualSize} bytes, above the ${this.config.maxSizeBytes}-byte limit`,
      });
      throw new VideoTooLargeException();
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.Processing,
      upload_id: null,
      size_bytes: String(actualSize),
    });
    await this.enqueueProcessing(video.id);
    return { id: video.id, status: VideoStatus.Processing };
  }

  async getOwned(userId: string, id: string): Promise<VideoResponseDto> {
    const video = await this.findOwned(userId, id);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      content_type: video.content_type,
      size_bytes: video.size_bytes === null ? null : Number(video.size_bytes),
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      thumbnail_url: video.thumbnail_key
        ? await this.storageService.presignGetObject(video.thumbnail_key, {
            audience: 'public',
            ttlSeconds: this.config.downloadUrlTtlSeconds,
          })
        : null,
      processing_error: video.processing_error,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }

  async abort(userId: string, id: string): Promise<void> {
    const video = await this.findOwned(userId, id);
    if (video.status !== VideoStatus.Draft) {
      throw new InvalidVideoStatusException();
    }
    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }
    await this.videoRepository.delete(video.id);
  }

  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      audience: 'public',
      ttlSeconds: this.config.streamUrlTtlSeconds,
    });
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      audience: 'public',
      ttlSeconds: this.config.downloadUrlTtlSeconds,
      contentDisposition: `attachment; filename="${sanitizeFilename(video.original_filename)}"`,
    });
  }

  /** Public lookup: anything but a `ready` video is reported as not found. */
  async findReadyByPublicId(publicId: string): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video || video.status !== VideoStatus.Ready) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findOwned(userId: string, id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async insertWithUniquePublicId(data: Partial<Video>): Promise<Video> {
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err) || attempt === PUBLIC_ID_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
    throw new Error('Unreachable: public id retries exhausted');
  }

  private async enqueueProcessing(videoId: string): Promise<void> {
    await this.processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
    );
  }

  private partCount(sizeBytes: number): number {
    return Math.ceil(sizeBytes / this.config.uploadPartSizeBytes);
  }

  private presignParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPartDto[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
          this.config.uploadUrlTtlSeconds,
        ),
      })),
    );
  }

  private uploadUrlsExpireAt(): string {
    return new Date(
      Date.now() + this.config.uploadUrlTtlSeconds * 1000,
    ).toISOString();
  }
}
