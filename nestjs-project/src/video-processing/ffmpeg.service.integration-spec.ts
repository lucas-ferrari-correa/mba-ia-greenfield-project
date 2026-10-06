import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  generateVideoFixtures,
  VideoFixtures,
} from '../../test/fixtures/generate-video-fixtures';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { MediaProbeError, NoVideoStreamError } from './ffmpeg.errors';
import { FfmpegService, THUMBNAIL_MAX_WIDTH } from './ffmpeg.service';

describe('FfmpegService (integration — real ffmpeg + MinIO)', () => {
  let fixtures: VideoFixtures;
  let moduleRef: TestingModule;
  let storage: StorageService;
  const ffmpeg = new FfmpegService();
  const objectKey = `test/${randomUUID()}/original`;

  beforeAll(async () => {
    fixtures = generateVideoFixtures();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
    await storage.putObject(objectKey, readFileSync(fixtures.mp4), 'video/mp4');
  }, 60000);

  afterAll(async () => {
    await storage.deleteObject(objectKey);
    await moduleRef.close();
    fixtures.cleanup();
  });

  describe('probe', () => {
    it('should extract duration, dimensions and codec from an MP4', async () => {
      const result = await ffmpeg.probe(fixtures.mp4);

      expect(result.durationSeconds).toBeCloseTo(3, 0);
      expect(result.width).toBe(640);
      expect(result.height).toBe(360);
      expect(result.videoCodec).toBe('h264');
      expect(result.raw).toHaveProperty('streams');
      expect(result.raw).toHaveProperty('format');
    });

    it('should read a WebM', async () => {
      const result = await ffmpeg.probe(fixtures.webm);

      expect(result.videoCodec).toBe('vp9');
    });

    it('should read the object through an internal presigned URL', async () => {
      const url = await storage.presignGetObject(objectKey, {
        audience: 'internal',
        ttlSeconds: 300,
      });

      const result = await ffmpeg.probe(url);

      expect(result.videoCodec).toBe('h264');
      expect(result.durationSeconds).toBeCloseTo(3, 0);
    });

    it('should reject a file without a video stream', async () => {
      await expect(ffmpeg.probe(fixtures.audioOnly)).rejects.toBeInstanceOf(
        NoVideoStreamError,
      );
    });

    it('should reject a file that is not decodable media', async () => {
      await expect(ffmpeg.probe(fixtures.corrupted)).rejects.toBeInstanceOf(
        MediaProbeError,
      );
    });

    it('should kill ffprobe and fail when it exceeds the timeout', async () => {
      // A TCP server that accepts connections and never answers makes the
      // HTTP input hang forever.
      const sockets: Socket[] = [];
      const server: Server = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;

      try {
        await expect(
          ffmpeg.probe(`http://127.0.0.1:${port}/never`, { timeoutMs: 1000 }),
        ).rejects.toThrow(/timed out/);
      } finally {
        sockets.forEach((socket) => socket.destroy());
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('extractThumbnail', () => {
    it('should render a JPEG frame from an internal presigned URL', async () => {
      const url = await storage.presignGetObject(objectKey, {
        audience: 'internal',
        ttlSeconds: 300,
      });

      const jpeg = await ffmpeg.extractThumbnail(url, 0.3);

      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const jpegPath = join(fixtures.dir, 'thumb.jpg');
      writeFileSync(jpegPath, jpeg);
      const probe = await ffmpeg.probe(jpegPath);
      expect(probe.width).toBeLessThanOrEqual(THUMBNAIL_MAX_WIDTH);
    });
  });
});
