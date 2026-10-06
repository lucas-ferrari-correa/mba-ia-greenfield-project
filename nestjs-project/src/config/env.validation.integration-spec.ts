import { envValidationSchema } from './env.validation';
import videoConfig from './video.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({}) as {
      value: Record<string, string>;
      error?: Error;
    };
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video keys', () => {
  it('should reject a missing S3_ACCESS_KEY_ID', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_ACCESS_KEY_ID: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
  });

  it('should reject a missing S3_SECRET_ACCESS_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_SECRET_ACCESS_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('should apply Compose-service defaults for storage and queue hosts', () => {
    const { value, error } = validate({}) as {
      value: Record<string, unknown>;
      error?: Error;
    };
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('bull');
    expect(value.S3_BUCKET).toBe('streamtube-videos');
  });

  it('should reject a non-positive VIDEO_MAX_SIZE_BYTES', () => {
    const { error } = validate({ VIDEO_MAX_SIZE_BYTES: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_MAX_SIZE_BYTES');
  });

  it('should reject a non-integer VIDEO_UPLOAD_PART_SIZE_BYTES', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });
});

describe('videoConfig — defaults', () => {
  const keys = [
    'VIDEO_MAX_SIZE_BYTES',
    'VIDEO_UPLOAD_PART_SIZE_BYTES',
    'VIDEO_UPLOAD_URL_TTL_SECONDS',
    'VIDEO_STREAM_URL_TTL_SECONDS',
    'VIDEO_DOWNLOAD_URL_TTL_SECONDS',
    'VIDEO_WORKER_READ_URL_TTL_SECONDS',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('should default to a 10 GiB limit, 100 MiB parts and the planned TTLs', () => {
    expect(videoConfig()).toEqual({
      maxSizeBytes: 10737418240,
      uploadPartSizeBytes: 104857600,
      uploadUrlTtlSeconds: 3600,
      streamUrlTtlSeconds: 21600,
      downloadUrlTtlSeconds: 3600,
      workerReadUrlTtlSeconds: 900,
    });
  });
});
