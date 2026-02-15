import { createChildLogger } from "../config/logger.js";
import { registerSlaCheckWorker, scheduleSlaChecks } from "./sla-check.job.js";
import { registerFollowUpWorker, scheduleFollowUpChecks } from "./follow-up.job.js";
import { registerFollowUpSequenceWorker, scheduleFollowUpSequences } from "./follow-up-sequence.job.js";
import { registerPipelineAgentWorker, schedulePipelineAgentJobs } from "./pipeline-agent.job.js";

const log = createChildLogger("jobs");

export function registerWorkers(): void {
  log.info("Registering BullMQ workers...");

  // Phase 1 workers
  registerSlaCheckWorker();
  registerFollowUpWorker();

  // Phase 2 workers
  registerFollowUpSequenceWorker();
  registerPipelineAgentWorker();

  // Schedule recurring jobs
  scheduleSlaChecks();
  scheduleFollowUpChecks();
  scheduleFollowUpSequences();
  schedulePipelineAgentJobs();

  log.info("All workers registered");
}
