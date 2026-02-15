import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { processDueFollowUps } from "../services/follow-up-sequences.js";

const log = createChildLogger("job:follow-up-sequence");

const QUEUE_NAME = "follow-up-sequence";
const queue = createQueue(QUEUE_NAME);

export function registerFollowUpSequenceWorker(): void {
  createWorker(QUEUE_NAME, async () => {
    log.info("Processing due follow-up sequences...");
    const processed = await processDueFollowUps();
    log.info({ processed }, "Follow-up sequences processed");
  });
}

/**
 * Schedule follow-up sequence processing every 5 minutes
 */
export async function scheduleFollowUpSequences(): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    "process-sequences",
    {},
    {
      repeat: { every: 5 * 60 * 1000 }, // every 5 minutes
      removeOnComplete: true,
    }
  );

  log.info("Follow-up sequence processing scheduled every 5 minutes");
}
