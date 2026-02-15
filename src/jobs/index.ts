import { createChildLogger } from "../config/logger.js";
import { registerSlaCheckWorker, scheduleSlaChecks } from "./sla-check.job.js";
import { registerFollowUpWorker, scheduleFollowUpChecks } from "./follow-up.job.js";
import { registerFollowUpSequenceWorker, scheduleFollowUpSequences } from "./follow-up-sequence.job.js";
import { registerPipelineAgentWorker, schedulePipelineAgentJobs } from "./pipeline-agent.job.js";
import { registerObrasMonitorWorker, scheduleObrasMonitorJobs } from "./obras-monitor.job.js";
import { registerFinanceWorker, scheduleFinanceJobs } from "./finance.job.js";
import { registerIntelligenceWorker, scheduleIntelligenceJobs } from "./intelligence.job.js";

const log = createChildLogger("jobs");

export function registerWorkers(): void {
  log.info("Registering BullMQ workers...");

  // Phase 1 workers
  registerSlaCheckWorker();
  registerFollowUpWorker();

  // Phase 2 workers
  registerFollowUpSequenceWorker();
  registerPipelineAgentWorker();

  // Phase 3 workers
  registerObrasMonitorWorker();

  // Phase 4 workers
  registerFinanceWorker();

  // Phase 5 workers
  registerIntelligenceWorker();

  // Schedule recurring jobs
  scheduleSlaChecks();
  scheduleFollowUpChecks();
  scheduleFollowUpSequences();
  schedulePipelineAgentJobs();
  scheduleObrasMonitorJobs();
  scheduleFinanceJobs();
  scheduleIntelligenceJobs();

  log.info("All workers registered");
}
