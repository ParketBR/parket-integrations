import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { sendPendingNpsSurveys } from "../services/quality-tracking.js";
import { checkExpiredExperiments } from "../services/growth-experiments.js";
import { generateIntelligenceReport } from "../services/market-intelligence.js";
import { generateWeeklyDigest, runAlertRules } from "../services/weekly-digest.js";

const log = createChildLogger("job:intelligence");

const QUEUE_NAME = "intelligence";

// ─── Worker ─────────────────────────────────────────

export function registerIntelligenceWorker(): void {
  const worker = createWorker(QUEUE_NAME, async (job): Promise<void> => {
    switch (job.name) {
      case "nps-surveys": {
        log.info("Checking for pending NPS surveys");
        const sent = await sendPendingNpsSurveys();
        log.info({ sent }, "NPS surveys processed");
        break;
      }

      case "check-experiments": {
        log.info("Checking expired experiments");
        const closed = await checkExpiredExperiments();
        log.info({ closed }, "Experiments checked");
        break;
      }

      case "intelligence-report": {
        log.info("Generating intelligence report");
        await generateIntelligenceReport();
        log.info("Intelligence report sent");
        break;
      }

      case "weekly-digest": {
        log.info("Generating weekly digest");
        await generateWeeklyDigest();
        log.info("Weekly digest sent");
        break;
      }

      case "alert-rules": {
        log.info("Running alert rules");
        const triggered = await runAlertRules();
        log.info({ count: triggered.length }, "Alert rules checked");
        break;
      }

      default:
        log.warn({ jobName: job.name }, "Unknown intelligence job");
    }
  });

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, jobName: job?.name, err }, "Intelligence job failed");
  });

  log.info("Intelligence worker registered");
}

// ─── Schedule ───────────────────────────────────────

export function scheduleIntelligenceJobs(): void {
  const queue = createQueue(QUEUE_NAME);

  // NPS surveys: daily at 10am (check completed projects)
  queue.add("nps-surveys", {}, {
    repeat: { pattern: "0 10 * * *" },
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 10 },
  });

  // Check expired experiments: daily at 9am
  queue.add("check-experiments", {}, {
    repeat: { pattern: "0 9 * * *" },
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 10 },
  });

  // Intelligence report: Wednesday at 9am
  queue.add("intelligence-report", {}, {
    repeat: { pattern: "0 9 * * 3" },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 10 },
  });

  // Weekly digest: Monday at 8am
  queue.add("weekly-digest", {}, {
    repeat: { pattern: "0 8 * * 1" },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 10 },
  });

  // Alert rules: every 30 minutes
  queue.add("alert-rules", {}, {
    repeat: { pattern: "*/30 * * * *" },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 20 },
  });

  log.info("Intelligence jobs scheduled: nps (daily 10am), experiments (daily 9am), intelligence (Wed 9am), digest (Mon 8am), alerts (30min)");
}
