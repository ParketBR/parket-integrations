import { Router, type Request, type Response } from "express";
import { createChildLogger } from "../../config/logger.js";
import { isNewWebhookEvent, markWebhookStatus } from "../../services/webhook-guard.js";
import { ingestLead } from "../../services/lead-ingestion.js";
import { db } from "../../db/connection.js";

const log = createChildLogger("webhook:whatsapp");

export const whatsappWebhookRouter = Router();

interface EvolutionMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text: string };
  };
  messageTimestamp?: number;
}

/**
 * POST /webhooks/whatsapp — Receive Evolution API events
 */
whatsappWebhookRouter.post("/", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    const eventType = event.event ?? req.headers["x-event"] ?? "unknown";

    // Only process incoming messages (not sent by us)
    if (eventType !== "messages.upsert") return;

    const data = event.data as EvolutionMessage | undefined;
    if (!data || data.key.fromMe) return;

    const messageId = data.key.id;
    const idempotencyKey = `wa_${messageId}`;

    const isNew = await isNewWebhookEvent(
      "whatsapp",
      "message_received",
      idempotencyKey,
      event
    );
    if (!isNew) return;

    // Extract phone from JID
    const jid = data.key.remoteJid;
    const phone = jid.replace("@s.whatsapp.net", "").replace("@g.us", "");

    // Ignore group messages
    if (jid.endsWith("@g.us")) {
      await markWebhookStatus(idempotencyKey, "processed");
      return;
    }

    const name = data.pushName ?? "WhatsApp Lead";
    const text =
      data.message?.conversation ??
      data.message?.extendedTextMessage?.text ??
      "";

    // Check if this phone already exists as a lead
    const existing = await db
      .selectFrom("leads")
      .select(["id"])
      .where("phone_normalized", "=", phone)
      .executeTakeFirst();

    if (existing) {
      // Log activity on existing lead
      await db
        .insertInto("activities")
        .values({
          lead_id: existing.id,
          type: "whatsapp_received",
          description: text.substring(0, 500),
          metadata: { message_id: messageId },
        })
        .execute();

      await markWebhookStatus(idempotencyKey, "processed");
      return;
    }

    // New lead from WhatsApp
    await ingestLead({
      name,
      phone,
      source: "whatsapp",
      external_id: messageId,
    });

    await markWebhookStatus(idempotencyKey, "processed");
  } catch (err) {
    log.error({ err }, "WhatsApp webhook processing error");
  }
});
