const DEFAULT_REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null // Required by BullMQ
};

export class JobQueue {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.connection = null;
    this.queue = null;
  }

  async ensureQueue() {
    if (this.queue && this.connection) {
      return;
    }
    const [{ Queue }, { default: Redis }] = await Promise.all([import('bullmq'), import('ioredis')]);
    this.connection = new Redis(this.config.redis || DEFAULT_REDIS_CONFIG);
    this.queue = new Queue(this.name, { connection: this.connection });
  }

  async add(jobName, data, options = {}) {
    await this.ensureQueue();
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
    await this.ensureQueue();
    return this.queue.getJob(jobId);
  }

  async close() {
    if (this.queue) {
      await this.queue.close();
    }
    if (this.connection) {
      await this.connection.quit();
    }
  }
}

export async function createWorker(name, processor, config = {}) {
  const [{ Worker }, { default: Redis }] = await Promise.all([import('bullmq'), import('ioredis')]);
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
