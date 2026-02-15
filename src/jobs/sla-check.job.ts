import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { checkSlaBreaches } from "../services/sla-monitor.js";

const log = createChildLogger("job:sla-check");

const SLA_QUEUE = "sla-check";
const queue = createQueue(SLA_QUEUE);

export function registerSlaCheckWorker(): void {
  createWorker(SLA_QUEUE, async () => {
    log.info("Running SLA breach check...");
    const breached = await checkSlaBreaches();
    log.info({ breachedCount: breached }, "SLA check completed");
  });
}

/**
 * Schedule SLA checks every 2 minutes
 */
export async function scheduleSlaChecks(): Promise<void> {
  // Remove existing repeatable jobs
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    "check-sla-breaches",
    {},
    {
      repeat: { every: 2 * 60 * 1000 }, // every 2 minutes
      removeOnComplete: true,
    }
  );

  log.info("SLA check scheduled every 2 minutes");
}
