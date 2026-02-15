import { createChildLogger } from "../config/logger.js";
import { registerSlaCheckWorker, scheduleSlaChecks } from "./sla-check.job.js";
import { registerFollowUpWorker, scheduleFollowUpChecks } from "./follow-up.job.js";

const log = createChildLogger("jobs");

export function registerWorkers(): void {
  log.info("Registering BullMQ workers...");

  registerSlaCheckWorker();
  registerFollowUpWorker();

  // Schedule recurring jobs
  scheduleSlaChecks();
  scheduleFollowUpChecks();

  log.info("All workers registered");
}
