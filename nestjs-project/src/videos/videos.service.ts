import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  PresignedPartDto,
  UploadStateResponseDto,
  VideoDraftResponseDto,
} from './dto/upload-session.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { originalKey, PUBLIC_ID_MAX_ATTEMPTS } from './videos.constants';
import {
  InvalidVideoStatusException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';

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
