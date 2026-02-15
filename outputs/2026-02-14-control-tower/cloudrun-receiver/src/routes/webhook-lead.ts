import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { validateBody } from "../middleware/validate.js";
import { saveEvent, updateEventStatus } from "../services/event-store.js";
import { triggerWorkflow } from "../services/workflow-trigger.js";
import { createLogger } from "../config/logger.js";

const log = createLogger("route:webhook-lead");

const leadPayloadSchema = z.object({
  source: z.enum([
    "meta_ads", "google_ads", "typeform", "website",
    "instagram", "whatsapp", "referral", "architect", "manual",
  ]),
  name: z.string().min(1),
  phone: z.string().min(8),
  email: z.string().email().optional(),
  funnel: z.enum(["architects", "end_client", "developers"]).default("end_client"),

  client_type: z.string().optional(),
  project_type: z.string().optional(),
  project_stage: z.string().optional(),
  location: z.string().optional(),
  estimated_ticket: z.number().optional(),

  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),

  form_id: z.string().optional(),
  lead_id: z.string().optional(),

  metadata: z.record(z.unknown()).optional(),

  correlation_id: z.string().uuid().optional(),
});

export const leadRouter = Router();

/**
 * Normalize phone to digits-only Brazilian format.
 */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return `55${digits}`;
  return digits;
}

leadRouter.post(
  "/",
  validateBody(leadPayloadSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body;
    const correlationId = body.correlation_id ?? uuidv4();
    const phoneNormalized = normalizePhone(body.phone);

    // Idempotency: source + phone + date (one lead per source per day)
    const dateKey = new Date().toISOString().split("T")[0];
    const idempotencyKey = body.lead_id
      ? `lead:${body.source}:${body.lead_id}`
      : `lead:${body.source}:${phoneNormalized}:${dateKey}`;

    log.info("Lead webhook received", {
      correlation_id: correlationId,
      source: body.source,
      phone_normalized: phoneNormalized,
      funnel: body.funnel,
    });

    const payload = {
      ...body,
      phone_normalized: phoneNormalized,
    };

    // 1. Save event FIRST
    const eventId = await saveEvent({
      correlation_id: correlationId,
      event_type: "lead_created",
      payload,
      idempotency_key: idempotencyKey,
      source: body.source,
    });

    if (!eventId) {
      res.status(200).json({
        status: "duplicate",
        correlation_id: correlationId,
        message: "Lead already received",
      });
      return;
    }

    // 2. Trigger workflow
    try {
      const executionId = await triggerWorkflow({
        event_id: eventId,
        correlation_id: correlationId,
        event_type: "lead_created",
        payload,
        source: body.source,
      });

      await updateEventStatus(eventId, "processing", executionId);

      log.info("Lead event dispatched to workflow", {
        correlation_id: correlationId,
        event_id: eventId,
        execution_id: executionId,
        phone_normalized: phoneNormalized,
      });

      res.status(200).json({
        status: "accepted",
        event_id: eventId,
        correlation_id: correlationId,
        workflow_execution_id: executionId,
      });
    } catch (err) {
      await updateEventStatus(
        eventId,
        "failed",
        undefined,
        err instanceof Error ? err.message : String(err)
      );

      log.error("Failed to trigger workflow for lead", {
        correlation_id: correlationId,
        event_id: eventId,
        error: err instanceof Error ? err.message : String(err),
      });

      res.status(202).json({
        status: "event_saved_workflow_failed",
        event_id: eventId,
        correlation_id: correlationId,
      });
    }
  }
);
