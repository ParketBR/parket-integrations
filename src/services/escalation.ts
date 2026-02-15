import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";
import { sendSlackAlert } from "../connectors/slack/client.js";

const log = createChildLogger("service:escalation");

/**
 * Escalation chain:
 * 1. WhatsApp group (immediate)
 * 2. Slack alert (if not resolved in 15 min)
 * 3. Critical Slack + WhatsApp to ops group (if not resolved in 30 min)
 */

interface EscalationContext {
  leadId: string;
  leadName: string;
  slaType: string;
  minutesSinceBreach: number;
}

/**
 * Run escalation check on all breached SLAs.
 * Called periodically — escalates based on time since breach.
 */
export async function runEscalationCheck(): Promise<number> {
  const breachedSlas = await db
    .selectFrom("sla_events")
    .innerJoin("leads", "leads.id", "sla_events.lead_id")
    .select([
      "sla_events.id as sla_id",
      "sla_events.lead_id",
      "sla_events.sla_type",
      "sla_events.deadline_at",
      "sla_events.notified",
      "sla_events.metadata" as never, // will use raw
      "leads.name as lead_name",
      "leads.phone as lead_phone",
      "leads.estimated_ticket",
    ])
    .where("sla_events.breached", "=", true)
    .where("sla_events.completed_at", "is", null)
    .execute();

  let escalated = 0;

  for (const sla of breachedSlas) {
    const minutesSinceBreach = Math.floor(
      (Date.now() - new Date(sla.deadline_at).getTime()) / 60_000
    );

    const context: EscalationContext = {
      leadId: sla.lead_id,
      leadName: sla.lead_name,
      slaType: sla.sla_type,
      minutesSinceBreach,
    };

    // Check existing escalation activities for this SLA
    const escalationActivities = await db
      .selectFrom("activities")
      .select("type")
      .where("lead_id", "=", sla.lead_id)
      .where("type", "in", ["escalation_slack", "escalation_critical"] as never[])
      .where("metadata", "@>", JSON.stringify({ sla_id: sla.sla_id }) as never)
      .execute();

    const hasSlackEscalation = escalationActivities.some(
      (a) => a.type === "escalation_slack"
    );
    const hasCriticalEscalation = escalationActivities.some(
      (a) => a.type === "escalation_critical"
    );

    try {
      // Level 2: Slack (after 15 min)
      if (minutesSinceBreach >= 15 && !hasSlackEscalation) {
        await escalateToSlack(context);
        await logEscalation(sla.lead_id, sla.sla_id, "escalation_slack");
        escalated++;
      }

      // Level 3: Critical (after 30 min)
      if (minutesSinceBreach >= 30 && !hasCriticalEscalation) {
        await escalateToCritical(context, sla.estimated_ticket);
        await logEscalation(sla.lead_id, sla.sla_id, "escalation_critical");
        escalated++;
      }
    } catch (err) {
      log.error({ err, slaId: sla.sla_id }, "Escalation failed");
    }
  }

  if (escalated > 0) {
    log.info({ escalated }, "Escalations processed");
  }

  return escalated;
}

async function escalateToSlack(ctx: EscalationContext): Promise<void> {
  await sendSlackAlert(
    "warning",
    `SLA Breach — ${ctx.slaType}`,
    `*Lead:* ${ctx.leadName}\n*SLA:* ${ctx.slaType}\n*Tempo desde breach:* ${ctx.minutesSinceBreach} min\n\nNecessita atencao imediata.`
  );

  log.info({ leadId: ctx.leadId, slaType: ctx.slaType }, "Escalated to Slack");
}

async function escalateToCritical(
  ctx: EscalationContext,
  estimatedTicket: number | null
): Promise<void> {
  const ticketInfo = estimatedTicket
    ? `R$ ${Number(estimatedTicket).toLocaleString("pt-BR")}`
    : "sem valor estimado";

  // Critical Slack alert
  await sendSlackAlert(
    "critical",
    `CRITICO: SLA ${ctx.slaType} — ${ctx.leadName}`,
    `*Lead:* ${ctx.leadName}\n*SLA:* ${ctx.slaType}\n*Tempo:* ${ctx.minutesSinceBreach} min sem resolucao\n*Valor:* ${ticketInfo}\n\n*ACAO IMEDIATA NECESSARIA*`
  );

  // Also WhatsApp to ops group
  const opsGroup = process.env.WHATSAPP_OPS_GROUP;
  if (opsGroup) {
    await sendGroupMessage(
      opsGroup,
      `*ESCALACAO CRITICA*\n\nLead: ${ctx.leadName}\nSLA: ${ctx.slaType}\nTempo: ${ctx.minutesSinceBreach} min\nValor: ${ticketInfo}\n\nResolucao urgente necessaria!`
    );
  }

  log.warn({ leadId: ctx.leadId, slaType: ctx.slaType }, "CRITICAL escalation sent");
}

async function logEscalation(
  leadId: string,
  slaId: string,
  type: string
): Promise<void> {
  await db
    .insertInto("activities")
    .values({
      lead_id: leadId,
      type: type as never,
      description: `Escalation: ${type}`,
      metadata: { sla_id: slaId, escalated_at: new Date().toISOString() },
    })
    .execute();
}
