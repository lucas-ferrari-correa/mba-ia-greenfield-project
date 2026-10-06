import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

export type SignedUrlAudience = 'public' | 'internal';

export interface PresignGetOptions {
  ttlSeconds: number;
  audience: SignedUrlAudience;
  contentDisposition?: string;
}

@Injectable()
export class StorageService {
  private readonly bucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(S3_SIGNING_CLIENT) private readonly signingClient: S3Client,
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return UploadId;
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of response.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? '',
          size: part.Size ?? 0,
        });
      }
      marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<number> {
    const { ContentLength } = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return ContentLength ?? 0;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  presignGetObject(key: string, options: PresignGetOptions): Promise<string> {
    const client =
      options.audience === 'public' ? this.signingClient : this.client;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.ttlSeconds },
    );
  }
}
