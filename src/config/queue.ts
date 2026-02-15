import { Queue, Worker, type Job, type WorkerOptions } from "bullmq";
import IORedis from "ioredis";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("queue");

let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
    connection.on("error", (err) => log.error({ err }, "Redis connection error"));
  }
  return connection;
}

export function createQueue(name: string): Queue {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 86400 }, // 24h
      removeOnFail: { age: 604800 }, // 7d
    },
  });
}

export function createWorker<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
  opts?: Partial<WorkerOptions>
): Worker<T> {
  const worker = new Worker<T>(queueName, processor, {
    connection: getRedisConnection(),
    concurrency: 5,
    ...opts,
  });

  worker.on("completed", (job) => {
    log.info({ jobId: job.id, queue: queueName }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    log.error(
      { jobId: job?.id, queue: queueName, err },
      "Job failed"
    );
  });

  return worker;
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const res = await redis.ping();
    return res === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
    log.info("Redis connection closed");
  }
}
