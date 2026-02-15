import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { validateBody } from "../middleware/validate.js";
import { saveEvent, updateEventStatus } from "../services/event-store.js";
import { triggerWorkflow } from "../services/workflow-trigger.js";
import { createLogger } from "../config/logger.js";

const log = createLogger("route:webhook-whatsapp");

const whatsappPayloadSchema = z.object({
  event: z.string().min(1),
  instance: z.string().optional(),
  data: z.object({
    key: z.object({
      remoteJid: z.string(),
      fromMe: z.boolean(),
      id: z.string(),
    }).optional(),
    pushName: z.string().optional(),
    message: z.record(z.unknown()).optional(),
    messageType: z.string().optional(),
    messageTimestamp: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  correlation_id: z.string().uuid().optional(),
});

export const whatsappRouter = Router();

whatsappRouter.post(
  "/",
  validateBody(whatsappPayloadSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body;
    const correlationId = body.correlation_id ?? uuidv4();
    const idempotencyKey = body.data?.key?.id
      ? `wa:${body.data.key.id}`
      : `wa:${correlationId}:${Date.now()}`;

    log.info("WhatsApp webhook received", {
      correlation_id: correlationId,
      event: body.event,
      remote_jid: body.data?.key?.remoteJid,
    });

    // Map WhatsApp events to Control Tower event types
    let eventType: string;
    switch (body.event) {
      case "messages.upsert":
        eventType = "message_received";
        break;
      case "connection.update":
        eventType = "connection_update";
        break;
      case "contacts.upsert":
        eventType = "contact_update";
        break;
      default:
        eventType = `whatsapp_${body.event}`;
    }

    // 1. Save event FIRST (before any action)
    const eventId = await saveEvent({
      correlation_id: correlationId,
      event_type: eventType,
      payload: body.data,
      idempotency_key: idempotencyKey,
      source: "whatsapp",
    });

    if (!eventId) {
      // Duplicate — idempotent response
      res.status(200).json({
        status: "duplicate",
        correlation_id: correlationId,
      });
      return;
    }

    // 2. Trigger workflow
    try {
      const executionId = await triggerWorkflow({
        event_id: eventId,
        correlation_id: correlationId,
        event_type: eventType,
        payload: body.data,
        source: "whatsapp",
      });

      await updateEventStatus(eventId, "processing", executionId);

      log.info("WhatsApp event processed", {
        correlation_id: correlationId,
        event_id: eventId,
        execution_id: executionId,
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

      log.error("Failed to trigger workflow for WhatsApp event", {
        correlation_id: correlationId,
        event_id: eventId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Event is saved — return 202 (we can retry workflow later)
      res.status(202).json({
        status: "event_saved_workflow_failed",
        event_id: eventId,
        correlation_id: correlationId,
      });
    }
  }
);
