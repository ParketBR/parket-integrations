import { Router, type Request, type Response } from "express";
import { createChildLogger } from "../../config/logger.js";
import {
  verifyMetaSignature,
  fetchLeadData,
  extractLeadFields,
} from "../../connectors/meta/client.js";
import { isNewWebhookEvent, markWebhookStatus } from "../../services/webhook-guard.js";
import { ingestLead } from "../../services/lead-ingestion.js";

const log = createChildLogger("webhook:meta");

export const metaWebhookRouter = Router();

/**
 * GET /webhooks/meta — Meta verification challenge
 */
metaWebhookRouter.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    log.info("Meta webhook verified");
    res.status(200).send(challenge);
  } else {
    log.warn("Meta webhook verification failed");
    res.sendStatus(403);
  }
});

/**
 * POST /webhooks/meta — Receive lead form submissions
 */
metaWebhookRouter.post("/", async (req: Request, res: Response) => {
  // Verify signature
  const signature = req.headers["x-hub-signature-256"] as string;
  if (signature && process.env.META_APP_SECRET) {
    const body = JSON.stringify(req.body);
    if (!verifyMetaSignature(body, signature, process.env.META_APP_SECRET)) {
      log.warn("Invalid Meta webhook signature");
      res.sendStatus(403);
      return;
    }
  }

  // Respond immediately (Meta requires fast ack)
  res.sendStatus(200);

  try {
    const entries = req.body?.entry ?? [];

    for (const entry of entries) {
      const changes = entry.changes ?? [];

      for (const change of changes) {
        if (change.field !== "leadgen") continue;

        const leadgenId = change.value?.leadgen_id;
        if (!leadgenId) continue;

        const idempotencyKey = `meta_${leadgenId}`;

        // Dedup at webhook level
        const isNew = await isNewWebhookEvent(
          "meta_ads",
          "leadgen",
          idempotencyKey,
          change.value
        );
        if (!isNew) continue;

        try {
          // Fetch full lead data from Meta
          const leadData = await fetchLeadData(
            leadgenId,
            process.env.META_ACCESS_TOKEN!
          );

          const fields = extractLeadFields(leadData.field_data);

          await ingestLead({
            name: fields.full_name ?? fields.nome ?? "Sem nome",
            email: fields.email,
            phone: fields.phone_number ?? fields.telefone ?? "",
            source: "meta_ads",
            external_id: leadgenId,
            utm_source: "facebook",
            utm_medium: "paid",
            utm_campaign: leadData.campaign_id ?? undefined,
            utm_content: leadData.ad_id ?? undefined,
            location: fields.city ?? fields.cidade ?? undefined,
            project_type: mapProjectType(fields.tipo_projeto ?? fields.project_type),
          });

          await markWebhookStatus(idempotencyKey, "processed");
        } catch (err) {
          log.error({ err, leadgenId }, "Failed to process Meta lead");
          await markWebhookStatus(
            idempotencyKey,
            "failed",
            err instanceof Error ? err.message : "Unknown error"
          );
        }
      }
    }
  } catch (err) {
    log.error({ err }, "Meta webhook processing error");
  }
});

function mapProjectType(
  value?: string
): "residential" | "commercial" | "corporate" | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v.includes("resid")) return "residential";
  if (v.includes("comerc")) return "commercial";
  if (v.includes("corp")) return "corporate";
  return undefined;
}
