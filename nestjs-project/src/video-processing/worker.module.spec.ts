import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;

  afterAll(() => {
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  it('should compile with the processor, queue, storage and database wiring', async () => {
    // Isolated prefix so this module never competes for real jobs.
    process.env.QUEUE_PREFIX = `test-${randomUUID()}`;

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    await moduleRef.close();
  }, 30000);
});
