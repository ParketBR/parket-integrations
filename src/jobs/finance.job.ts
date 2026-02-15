import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { syncInvoices, syncPayments, markOverdueInvoices } from "../services/financial-sync.js";
import { detectLowMarginProjects } from "../services/margin-analysis.js";
import {
  generateExecutiveScoreboard,
  sendScoreboardAlert,
} from "../services/cac-calculator.js";

const log = createChildLogger("job:finance");

const QUEUE_NAME = "finance";

// ─── Worker ─────────────────────────────────────────

export function registerFinanceWorker(): void {
  const worker = createWorker(QUEUE_NAME, async (job): Promise<void> => {
    switch (job.name) {
      case "sync-erp": {
        const endDate = new Date().toISOString().split("T")[0];
        const startDate = new Date(Date.now() - 7 * 86_400_000)
          .toISOString()
          .split("T")[0];

        log.info({ startDate, endDate }, "Syncing ERP data");

        const invoices = await syncInvoices(startDate, endDate);
        const payments = await syncPayments(startDate, endDate);
        const overdue = await markOverdueInvoices();

        log.info({ invoices, payments, overdue }, "ERP sync completed");
        break;
      }

      case "margin-check": {
        log.info("Running margin check");
        const lowMargin = await detectLowMarginProjects(25);
        log.info({ lowMarginCount: lowMargin.length }, "Margin check completed");
        break;
      }

      case "executive-scoreboard": {
        log.info("Generating executive scoreboard");
        const data = job.data as Record<string, unknown> | undefined;
        const target = Number(data?.revenue_target ?? 500_000);
        const scoreboard = await generateExecutiveScoreboard(target);
        await sendScoreboardAlert(scoreboard);
        log.info("Executive scoreboard sent");
        break;
      }

      default:
        log.warn({ jobName: job.name }, "Unknown finance job");
    }
  });

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, jobName: job?.name, err }, "Finance job failed");
  });

  log.info("Finance worker registered");
}

// ─── Schedule ───────────────────────────────────────

export function scheduleFinanceJobs(): void {
  const queue = createQueue(QUEUE_NAME);

  // ERP sync: every 6 hours
  queue.add("sync-erp", {}, {
    repeat: { pattern: "0 */6 * * *" },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 20 },
  });

  // Margin check: daily at 8am
  queue.add("margin-check", {}, {
    repeat: { pattern: "0 8 * * *" },
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 10 },
  });

  // Executive scoreboard: Monday and Thursday at 9am
  queue.add("executive-scoreboard", {}, {
    repeat: { pattern: "0 9 * * 1,4" },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 10 },
  });

  log.info("Finance jobs scheduled: sync-erp (6h), margin-check (daily 8am), scoreboard (Mon/Thu 9am)");
}
