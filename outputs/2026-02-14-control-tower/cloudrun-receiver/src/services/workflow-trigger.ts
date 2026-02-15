import { ExecutionsClient } from "@google-cloud/workflows-executions";
import { env } from "../config/env.js";
import { createLogger } from "../config/logger.js";

const log = createLogger("service:workflow-trigger");

const client = new ExecutionsClient();

export interface WorkflowInput {
  event_id: string;
  correlation_id: string;
  event_type: string;
  lead_id?: string;
  payload: Record<string, unknown>;
  source?: string;
}

/**
 * Trigger Google Cloud Workflow execution.
 * Returns the execution ID for tracking.
 */
export async function triggerWorkflow(input: WorkflowInput): Promise<string> {
  const workflowPath = client.workflowPath(
    env.GCP_PROJECT_ID,
    env.GCP_REGION,
    env.WORKFLOW_NAME
  );

  log.info("Triggering workflow execution", {
    correlation_id: input.correlation_id,
    event_type: input.event_type,
    workflow: env.WORKFLOW_NAME,
  });

  try {
    const [execution] = await client.createExecution({
      parent: workflowPath,
      execution: {
        argument: JSON.stringify(input),
        callLogLevel: "LOG_ALL_CALLS",
      },
    });

    const executionId = execution.name!;

    log.info("Workflow execution started", {
      correlation_id: input.correlation_id,
      event_type: input.event_type,
      execution_id: executionId,
    });

    return executionId;
  } catch (err) {
    log.error("Failed to trigger workflow", {
      correlation_id: input.correlation_id,
      event_type: input.event_type,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
