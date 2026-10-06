import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const PART_SIZE = 5 * 1024 * 1024;
const TTL = 300;

async function putPart(url: string, size: number, fill: number) {
  const response = await fetch(url, {
    method: 'PUT',
    body: Buffer.alloc(size, fill),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag as string;
}

describe('StorageService (integration — real MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  const createdKeys: string[] = [];

  const newKey = () => {
    const key = `test/${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    // Presigned URLs are consumed from inside the nestjs-api container,
    // where localhost:9000 does not reach MinIO.
    process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await moduleRef.close();
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  describe('multipart upload', () => {
    it('should assemble parts uploaded through presigned URLs', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const etag1 = await putPart(
        await storage.presignUploadPart(key, uploadId, 1, TTL),
        PART_SIZE,
        1,
      );
      const etag2 = await putPart(
        await storage.presignUploadPart(key, uploadId, 2, TTL),
        PART_SIZE,
        2,
      );

      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]);

      expect(await storage.headObject(key)).toBe(PART_SIZE * 2);
    });

    it('should list only the parts already uploaded', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const etag = await putPart(
        await storage.presignUploadPart(key, uploadId, 1, TTL),
        PART_SIZE,
        1,
      );

      const parts = await storage.listParts(key, uploadId);

      expect(parts).toEqual([{ partNumber: 1, etag, size: PART_SIZE }]);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should invalidate the upload after abort', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
        name: 'NoSuchUpload',
      });
    });
  });

  describe('presigned URLs', () => {
    it('should sign public URLs with the public endpoint host', async () => {
      process.env.S3_PUBLIC_ENDPOINT = 'http://public.example:9000';
      const signingModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      }).compile();
      const signer = signingModule.get(StorageService);
      process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

      const publicUrl = await signer.presignGetObject('any/key', {
        audience: 'public',
        ttlSeconds: TTL,
      });
      const internalUrl = await signer.presignGetObject('any/key', {
        audience: 'internal',
        ttlSeconds: TTL,
      });

      expect(new URL(publicUrl).host).toBe('public.example:9000');
      expect(new URL(internalUrl).host).toBe('minio:9000');
      await signingModule.close();
    });

    it('should serve Range requests with 206 Partial Content', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.alloc(4096, 7), 'video/mp4');
      const url = await storage.presignGetObject(key, {
        audience: 'public',
        ttlSeconds: TTL,
      });

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-99' },
      });

      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(100);
    });

    it('should apply the requested Content-Disposition', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.alloc(16, 1), 'video/mp4');
      const url = await storage.presignGetObject(key, {
        audience: 'public',
        ttlSeconds: TTL,
        contentDisposition: 'attachment; filename="clip.mp4"',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
    });
  });

  describe('objects', () => {
    it('should delete an object', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.alloc(16, 1), 'image/jpeg');

      await storage.deleteObject(key);

      await expect(storage.headObject(key)).rejects.toMatchObject({
        name: 'NotFound',
      });
    });
  });
});
