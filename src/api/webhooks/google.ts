import { Router, type Request, type Response } from "express";
import { createChildLogger } from "../../config/logger.js";
import {
  verifyGoogleWebhook,
  extractGoogleLeadFields,
  type GoogleLeadPayload,
} from "../../connectors/google/client.js";
import { isNewWebhookEvent, markWebhookStatus } from "../../services/webhook-guard.js";
import { ingestLead } from "../../services/lead-ingestion.js";

const log = createChildLogger("webhook:google");

export const googleWebhookRouter = Router();

/**
 * POST /webhooks/google — Receive Google Ads lead form extensions
 */
googleWebhookRouter.post("/", async (req: Request, res: Response) => {
  // Verify token
  const token = req.headers["x-google-ads-webhook-token"] as string ?? req.query.token as string;
  if (!verifyGoogleWebhook(token, process.env.GOOGLE_ADS_WEBHOOK_SECRET ?? "")) {
    log.warn("Invalid Google webhook token");
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200);

  try {
    const payload = req.body as GoogleLeadPayload;
    const idempotencyKey = `google_${payload.lead_id ?? payload.google_key}`;

    const isNew = await isNewWebhookEvent(
      "google_ads",
      "lead_form",
      idempotencyKey,
      payload as unknown as Record<string, unknown>
    );
    if (!isNew) return;

    const fields = extractGoogleLeadFields(payload.column_data ?? []);

    await ingestLead({
      name: fields.full_name ?? fields.nome ?? "Sem nome",
      email: fields.email ?? fields.user_email,
      phone: fields.phone_number ?? fields.telefone ?? "",
      source: "google_ads",
      external_id: payload.lead_id,
      utm_source: "google",
      utm_medium: "paid",
      utm_campaign: payload.campaign_id ?? undefined,
      utm_content: payload.creative_id ?? undefined,
      location: fields.city ?? fields.cidade ?? undefined,
    });

    await markWebhookStatus(idempotencyKey, "processed");
  } catch (err) {
    log.error({ err }, "Google webhook processing error");
  }
});
