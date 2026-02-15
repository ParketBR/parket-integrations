import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { detectDelayedProjects } from "../services/works-management.js";
import { detectLatePurchaseOrders } from "../services/operations-tracking.js";

const log = createChildLogger("job:obras-monitor");

const QUEUE_NAME = "obras-monitor";
const queue = createQueue(QUEUE_NAME);

interface ObrasJobPayload {
  type: "delayed_projects" | "late_purchase_orders";
}

export function registerObrasMonitorWorker(): void {
  createWorker<ObrasJobPayload>(QUEUE_NAME, async (job) => {
    switch (job.data.type) {
      case "delayed_projects":
        log.info("Checking for delayed projects...");
        const delayed = await detectDelayedProjects();
        log.info({ count: delayed }, "Delayed projects check completed");
        break;

      case "late_purchase_orders":
        log.info("Checking for late purchase orders...");
        const latePOs = await detectLatePurchaseOrders();
        log.info({ count: latePOs }, "Late PO check completed");
        break;
    }
  });
}

export async function scheduleObrasMonitorJobs(): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Delayed projects check — every 8 hours
  await queue.add(
    "delayed-projects",
    { type: "delayed_projects" },
    {
      repeat: { every: 8 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  // Late PO check — every 12 hours
  await queue.add(
    "late-purchase-orders",
    { type: "late_purchase_orders" },
    {
      repeat: { every: 12 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  log.info("Obras monitor jobs scheduled");
}
