import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/** Shared BullMQ root options: API (producer) and worker must use the same prefix. */
export function bullRootOptions(queue: ConfigType<typeof queueConfig>) {
  return {
    connection: { host: queue.redisHost, port: queue.redisPort },
    prefix: queue.prefix,
  };
}
