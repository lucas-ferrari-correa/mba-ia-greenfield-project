import { registerAs } from '@nestjs/config';

const toInt = (value: string | undefined, fallback: number): number =>
  value ? parseInt(value, 10) : fallback;

export default registerAs('video', () => ({
  maxSizeBytes: toInt(process.env.VIDEO_MAX_SIZE_BYTES, 10737418240),
  uploadPartSizeBytes: toInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES,
    104857600,
  ),
  uploadUrlTtlSeconds: toInt(process.env.VIDEO_UPLOAD_URL_TTL_SECONDS, 3600),
  streamUrlTtlSeconds: toInt(process.env.VIDEO_STREAM_URL_TTL_SECONDS, 21600),
  downloadUrlTtlSeconds: toInt(
    process.env.VIDEO_DOWNLOAD_URL_TTL_SECONDS,
    3600,
  ),
  workerReadUrlTtlSeconds: toInt(
    process.env.VIDEO_WORKER_READ_URL_TTL_SECONDS,
    900,
  ),
}));
