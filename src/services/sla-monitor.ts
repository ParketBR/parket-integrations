import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";
import type { SlaEventTable } from "../db/schemas/types.js";

const log = createChildLogger("service:sla-monitor");

type SlaType = SlaEventTable["sla_type"];

const SLA_DURATIONS: Record<SlaType, number> = {
  response_5min: 5 * 60 * 1000,
  qualification_15min: 15 * 60 * 1000,
  meeting_48h: 48 * 60 * 60 * 1000,
  proposal_72h: 72 * 60 * 60 * 1000,
  handoff_24h: 24 * 60 * 60 * 1000,
};

const SLA_LABELS: Record<SlaType, string> = {
  response_5min: "Resposta (5 min)",
  qualification_15min: "Qualificacao (15 min)",
  meeting_48h: "Reuniao (48h)",
  proposal_72h: "Proposta (72h)",
  handoff_24h: "Handoff Obras (24h)",
};

/**
 * Start an SLA timer for a lead
 */
export async function startSla(
  leadId: string,
  slaType: SlaType
): Promise<void> {
  const now = new Date();
  const deadline = new Date(now.getTime() + SLA_DURATIONS[slaType]);

  await db
    .insertInto("sla_events")
    .values({
      lead_id: leadId,
      sla_type: slaType,
      started_at: now,
      deadline_at: deadline,
      completed_at: null,
    })
    .execute();

  log.info({ leadId, slaType, deadline: deadline.toISOString() }, "SLA started");
}

/**
 * Complete an SLA (called when the action is done)
 */
export async function completeSla(
  leadId: string,
  slaType: SlaType
): Promise<void> {
  const now = new Date();

  const result = await db
    .updateTable("sla_events")
    .set({ completed_at: now })
    .where("lead_id", "=", leadId)
    .where("sla_type", "=", slaType)
    .where("completed_at", "is", null)
    .executeTakeFirst();

  log.info({ leadId, slaType, updatedRows: result.numUpdatedRows }, "SLA completed");
}

/**
 * Check all open SLAs and flag breaches.
 * Called periodically by a cron job.
 */
export async function checkSlaBreaches(): Promise<number> {
  const now = new Date();

  // Find open SLAs past deadline
  const breached = await db
    .selectFrom("sla_events")
    .innerJoin("leads", "leads.id", "sla_events.lead_id")
    .select([
      "sla_events.id",
      "sla_events.lead_id",
      "sla_events.sla_type",
      "sla_events.deadline_at",
      "sla_events.notified",
      "leads.name as lead_name",
      "leads.phone as lead_phone",
    ])
    .where("sla_events.completed_at", "is", null)
    .where("sla_events.breached", "=", false)
    .where("sla_events.deadline_at", "<", now)
    .execute();

  if (breached.length === 0) return 0;

  log.warn({ count: breached.length }, "SLA breaches detected");

  for (const sla of breached) {
    // Mark as breached
    await db
      .updateTable("sla_events")
      .set({ breached: true })
      .where("id", "=", sla.id)
      .execute();

    // Log activity
    await db
      .insertInto("activities")
      .values({
        lead_id: sla.lead_id,
        type: "sla_breach",
        description: `SLA breached: ${SLA_LABELS[sla.sla_type as SlaType]}`,
        metadata: { sla_type: sla.sla_type, deadline: sla.deadline_at },
      })
      .execute();

    // Notify if not yet notified
    if (!sla.notified) {
      try {
        const groupId = process.env.WHATSAPP_SDR_GROUP;
        if (groupId) {
          await sendGroupMessage(
            groupId,
            `*SLA ESTOURADO*\n\nLead: ${sla.lead_name}\nTel: ${sla.lead_phone}\nSLA: ${SLA_LABELS[sla.sla_type as SlaType]}\nDeadline: ${new Date(sla.deadline_at).toLocaleString("pt-BR")}\n\nAcao imediata necessaria!`
          );
        }
        await db
          .updateTable("sla_events")
          .set({ notified: true })
          .where("id", "=", sla.id)
          .execute();
      } catch (err) {
        log.error({ err, slaId: sla.id }, "Failed to send SLA breach notification");
      }
    }
  }

  return breached.length;
}
