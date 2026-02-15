import Handlebars from "handlebars";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendTextMessage } from "../connectors/whatsapp/client.js";
import type { Lead } from "../db/schemas/types.js";

const log = createChildLogger("service:follow-up-sequences");

/**
 * Start a follow-up sequence for a lead based on their funnel.
 * Only starts if no active sequence exists for this lead.
 */
export async function startSequenceForLead(lead: Lead): Promise<void> {
  // Check for existing active sequence
  const existing = await db
    .selectFrom("follow_up_executions")
    .select("id")
    .where("lead_id", "=", lead.id)
    .where("status", "=", "active")
    .executeTakeFirst();

  if (existing) {
    log.debug({ leadId: lead.id }, "Sequence already active, skipping");
    return;
  }

  // Find the sequence for this funnel
  const sequence = await db
    .selectFrom("follow_up_sequences")
    .selectAll()
    .where("funnel", "=", lead.funnel)
    .where("active", "=", true)
    .executeTakeFirst();

  if (!sequence) {
    log.warn({ funnel: lead.funnel }, "No active sequence for funnel");
    return;
  }

  // Get first step to calculate next_run_at
  const firstStep = await db
    .selectFrom("follow_up_steps")
    .selectAll()
    .where("sequence_id", "=", sequence.id)
    .where("step_order", "=", 1)
    .executeTakeFirst();

  if (!firstStep) {
    log.warn({ sequenceId: sequence.id }, "Sequence has no steps");
    return;
  }

  const nextRunAt = new Date(Date.now() + firstStep.delay_minutes * 60_000);

  await db
    .insertInto("follow_up_executions")
    .values({
      lead_id: lead.id,
      sequence_id: sequence.id,
      current_step: 0,
      status: "active",
      next_run_at: nextRunAt,
      completed_at: null,
    })
    .execute();

  log.info(
    { leadId: lead.id, sequenceId: sequence.id, nextRunAt: nextRunAt.toISOString() },
    "Follow-up sequence started"
  );
}

/**
 * Cancel all active sequences for a lead (e.g., when they respond or advance stage).
 */
export async function cancelSequencesForLead(
  leadId: string,
  reason: "responded" | "cancelled"
): Promise<void> {
  const result = await db
    .updateTable("follow_up_executions")
    .set({ status: reason, completed_at: new Date() })
    .where("lead_id", "=", leadId)
    .where("status", "=", "active")
    .executeTakeFirst();

  log.info({ leadId, reason, updated: result.numUpdatedRows }, "Sequences cancelled");
}

/**
 * Process all due follow-up executions.
 * Called periodically by BullMQ job.
 */
export async function processDueFollowUps(): Promise<number> {
  const now = new Date();

  // Find executions due for next step
  const dueExecutions = await db
    .selectFrom("follow_up_executions")
    .innerJoin("leads", "leads.id", "follow_up_executions.lead_id")
    .select([
      "follow_up_executions.id as execution_id",
      "follow_up_executions.sequence_id",
      "follow_up_executions.current_step",
      "follow_up_executions.lead_id",
      "leads.name",
      "leads.phone_normalized",
      "leads.location",
      "leads.project_type",
      "leads.funnel",
    ])
    .where("follow_up_executions.status", "=", "active")
    .where("follow_up_executions.next_run_at", "<=", now)
    .execute();

  if (dueExecutions.length === 0) return 0;

  log.info({ count: dueExecutions.length }, "Processing due follow-ups");

  let processed = 0;

  for (const exec of dueExecutions) {
    try {
      const nextStepOrder = exec.current_step + 1;

      // Get the step to execute
      const step = await db
        .selectFrom("follow_up_steps")
        .selectAll()
        .where("sequence_id", "=", exec.sequence_id)
        .where("step_order", "=", nextStepOrder)
        .executeTakeFirst();

      if (!step) {
        // No more steps — sequence completed
        await db
          .updateTable("follow_up_executions")
          .set({ status: "completed", completed_at: now })
          .where("id", "=", exec.execution_id)
          .execute();

        log.info({ executionId: exec.execution_id }, "Sequence completed (no more steps)");
        continue;
      }

      // Render template with lead data
      const compiled = Handlebars.compile(step.template);
      const message = compiled({
        name: exec.name,
        location: exec.location,
        project_type: exec.project_type,
        funnel: exec.funnel,
      });

      // Send message
      if (step.channel === "whatsapp") {
        await sendTextMessage(exec.phone_normalized, message);
      }

      // Log activity
      await db
        .insertInto("activities")
        .values({
          lead_id: exec.lead_id,
          type: "follow_up",
          description: `Sequence step ${nextStepOrder}: ${message.substring(0, 200)}`,
          metadata: {
            sequence_id: exec.sequence_id,
            step_order: nextStepOrder,
            channel: step.channel,
            auto: true,
          },
        })
        .execute();

      // Check if there's a next step
      const nextStep = await db
        .selectFrom("follow_up_steps")
        .selectAll()
        .where("sequence_id", "=", exec.sequence_id)
        .where("step_order", "=", nextStepOrder + 1)
        .executeTakeFirst();

      if (nextStep) {
        // Schedule next step
        const nextRunAt = new Date(now.getTime() + nextStep.delay_minutes * 60_000);
        await db
          .updateTable("follow_up_executions")
          .set({ current_step: nextStepOrder, next_run_at: nextRunAt })
          .where("id", "=", exec.execution_id)
          .execute();
      } else {
        // No more steps
        await db
          .updateTable("follow_up_executions")
          .set({
            current_step: nextStepOrder,
            status: "completed",
            completed_at: now,
            next_run_at: null,
          })
          .where("id", "=", exec.execution_id)
          .execute();
      }

      processed++;
    } catch (err) {
      log.error({ err, executionId: exec.execution_id }, "Failed to process follow-up step");
    }
  }

  log.info({ processed, total: dueExecutions.length }, "Follow-ups processed");
  return processed;
}
