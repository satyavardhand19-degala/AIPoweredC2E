import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const DEFAULT_REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null // Required by BullMQ
};

export class JobQueue {
  constructor(name, config = {}) {
    this.name = name;
    this.connection = new Redis(config.redis || DEFAULT_REDIS_CONFIG);
    this.queue = new Queue(name, { connection: this.connection });
  }

  async add(jobName, data, options = {}) {
    return this.queue.add(jobName, data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      },
      ...options
    });
  }

  async getJob(jobId) {
    return this.queue.getJob(jobId);
  }

  async close() {
    await this.queue.close();
    await this.connection.quit();
  }
}

export function createWorker(name, processor, config = {}) {
  const connection = new Redis(config.redis || DEFAULT_REDIS_CONFIG);
  const worker = new Worker(name, processor, {
    connection,
    concurrency: config.concurrency || 5
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed:`, err);
  });

  return worker;
}
