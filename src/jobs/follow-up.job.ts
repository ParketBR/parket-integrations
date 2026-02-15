import { createQueue, createWorker } from "../config/queue.js";
import { createChildLogger } from "../config/logger.js";
import { db } from "../db/connection.js";
import { sendTextMessage } from "../connectors/whatsapp/client.js";

const log = createChildLogger("job:follow-up");

const FOLLOWUP_QUEUE = "follow-up";
const queue = createQueue(FOLLOWUP_QUEUE);

interface FollowUpPayload {
  type: "stale_leads";
}

export function registerFollowUpWorker(): void {
  createWorker<FollowUpPayload>(FOLLOWUP_QUEUE, async (job) => {
    if (job.data.type === "stale_leads") {
      await processStaleLeads();
    }
  });
}

/**
 * Schedule follow-up checks every 4 hours
 */
export async function scheduleFollowUpChecks(): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    "stale-leads-followup",
    { type: "stale_leads" },
    {
      repeat: { every: 4 * 60 * 60 * 1000 }, // every 4 hours
      removeOnComplete: true,
    }
  );

  log.info("Follow-up check scheduled every 4 hours");
}

/**
 * Find leads that haven't had activity in 24h and send follow-up
 */
async function processStaleLeads(): Promise<void> {
  const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Find leads in early stages without recent activity
  const staleLeads = await db
    .selectFrom("leads")
    .leftJoin("activities", (join) =>
      join
        .onRef("activities.lead_id", "=", "leads.id")
        .on("activities.created_at", ">", staleThreshold)
    )
    .select([
      "leads.id",
      "leads.name",
      "leads.phone",
      "leads.phone_normalized",
      "leads.stage",
      "leads.source",
    ])
    .where("leads.stage", "in", ["triagem", "qualificado", "reuniao"])
    .where("leads.created_at", "<", staleThreshold)
    .where("activities.id", "is", null)
    .execute();

  log.info({ count: staleLeads.length }, "Stale leads found");

  for (const lead of staleLeads) {
    try {
      // Send follow-up message
      await sendTextMessage(
        lead.phone_normalized,
        `Ola ${lead.name}! Aqui e a Parket. Notamos que voce demonstrou interesse em nossos pisos de madeira. Podemos ajudar com alguma duvida sobre seu projeto? Estamos a disposicao para agendar uma conversa.`
      );

      // Log activity
      await db
        .insertInto("activities")
        .values({
          lead_id: lead.id,
          type: "follow_up",
          description: "Automated 24h follow-up sent via WhatsApp",
          metadata: { auto: true },
        })
        .execute();

      log.info({ leadId: lead.id }, "Follow-up sent");
    } catch (err) {
      log.error({ err, leadId: lead.id }, "Failed to send follow-up");
    }
  }
}
