import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

function createS3Client(
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    // SDK >= 3.729 computes CRC32 checksums by default; presigned part URLs
    // must not carry them, since the client uploads the bytes directly.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createS3Client(config, config.endpoint),
    },
    {
      provide: S3_SIGNING_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createS3Client(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
