import { Router, type Request, type Response } from "express";
import { createChildLogger } from "../../config/logger.js";
import { db } from "../../db/connection.js";
import { isNewWebhookEvent, markWebhookStatus } from "../../services/webhook-guard.js";
import { completeSla, startSla } from "../../services/sla-monitor.js";

const log = createChildLogger("webhook:pipedrive");

export const pipedriveWebhookRouter = Router();

/**
 * POST /webhooks/pipedrive — Receive Pipedrive deal/activity updates
 */
pipedriveWebhookRouter.post("/", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    const { meta, current, previous } = event;

    if (!meta?.action || !current) return;

    const idempotencyKey = `pd_${meta.id ?? Date.now()}_${meta.action}`;

    const isNew = await isNewWebhookEvent(
      "pipedrive",
      `${meta.object}_${meta.action}`,
      idempotencyKey,
      event
    );
    if (!isNew) return;

    // Handle deal stage changes
    if (meta.object === "deal" && meta.action === "updated") {
      const dealId = current.id;
      const newStageId = current.stage_id;
      const oldStageId = previous?.stage_id;

      if (newStageId !== oldStageId && dealId) {
        await handleDealStageChange(dealId, newStageId);
      }
    }

    // Handle activity completion (SDR responded, meeting done, etc.)
    if (meta.object === "activity" && meta.action === "updated") {
      if (current.done === true && current.deal_id) {
        await handleActivityCompleted(current.deal_id, current.type);
      }
    }

    await markWebhookStatus(idempotencyKey, "processed");
  } catch (err) {
    log.error({ err }, "Pipedrive webhook processing error");
  }
});

async function handleDealStageChange(
  dealId: number,
  _newStageId: number
): Promise<void> {
  const lead = await db
    .selectFrom("leads")
    .selectAll()
    .where("pipedrive_deal_id", "=", dealId)
    .executeTakeFirst();

  if (!lead) {
    log.warn({ dealId }, "Deal not found in local DB");
    return;
  }

  log.info({ leadId: lead.id, dealId }, "Deal stage changed in Pipedrive");

  // Log activity
  await db
    .insertInto("activities")
    .values({
      lead_id: lead.id,
      type: "stage_change",
      description: `Deal stage changed in Pipedrive`,
      metadata: { pipedrive_deal_id: dealId },
    })
    .execute();
}

async function handleActivityCompleted(
  dealId: number,
  activityType: string
): Promise<void> {
  const lead = await db
    .selectFrom("leads")
    .selectAll()
    .where("pipedrive_deal_id", "=", dealId)
    .executeTakeFirst();

  if (!lead) return;

  // Map Pipedrive activity types to SLA completions
  if (activityType === "call" || activityType === "email") {
    await completeSla(lead.id, "response_5min");
  } else if (activityType === "meeting") {
    await completeSla(lead.id, "meeting_48h");
    // Start proposal SLA
    await startSla(lead.id, "proposal_72h");
  }
}
