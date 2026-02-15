import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { detectStaleDeals, generateWeeklyForecast } from "../services/pipeline-agent.js";
import { runEscalationCheck } from "../services/escalation.js";

const log = createChildLogger("job:pipeline-agent");

const QUEUE_NAME = "pipeline-agent";
const queue = createQueue(QUEUE_NAME);

interface PipelineJobPayload {
  type: "stale_deals" | "weekly_forecast" | "escalation_check";
}

export function registerPipelineAgentWorker(): void {
  createWorker<PipelineJobPayload>(QUEUE_NAME, async (job) => {
    switch (job.data.type) {
      case "stale_deals":
        log.info("Checking for stale deals...");
        const stale = await detectStaleDeals(5);
        log.info({ count: stale.length }, "Stale deals check completed");
        break;

      case "weekly_forecast":
        log.info("Generating weekly forecast...");
        const forecast = await generateWeeklyForecast();
        log.info(
          { totalWeighted: forecast.totalWeighted },
          "Weekly forecast generated"
        );
        break;

      case "escalation_check":
        log.info("Running escalation check...");
        const escalated = await runEscalationCheck();
        log.info({ escalated }, "Escalation check completed");
        break;
    }
  });
}

/**
 * Schedule all pipeline agent jobs
 */
export async function schedulePipelineAgentJobs(): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Stale deals check — every 6 hours
  await queue.add(
    "stale-deals",
    { type: "stale_deals" },
    {
      repeat: { every: 6 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  // Weekly forecast — every Monday at 9am (using cron)
  await queue.add(
    "weekly-forecast",
    { type: "weekly_forecast" },
    {
      repeat: { pattern: "0 9 * * 1" }, // Monday 9:00
      removeOnComplete: true,
    }
  );

  // Escalation check — every 5 minutes
  await queue.add(
    "escalation-check",
    { type: "escalation_check" },
    {
      repeat: { every: 5 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  log.info("Pipeline agent jobs scheduled");
}
