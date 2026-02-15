import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { validateBody } from "../middleware/validate.js";
import { saveEvent, updateEventStatus } from "../services/event-store.js";
import { triggerWorkflow } from "../services/workflow-trigger.js";
import { createLogger } from "../config/logger.js";

const log = createLogger("route:events");

const eventPayloadSchema = z.object({
  event_type: z.enum([
    "lead_created",
    "message_received",
    "stage_changed",
    "proposal_sent",
    "won",
    "obra_created",
    "custom",
  ]),
  lead_id: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
  source: z.string().optional(),
  correlation_id: z.string().uuid().optional(),
  idempotency_key: z.string().optional(),
});

export const eventsRouter = Router();

eventsRouter.post(
  "/",
  validateBody(eventPayloadSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body;
    const correlationId = body.correlation_id ?? uuidv4();
    const idempotencyKey = body.idempotency_key ?? `evt:${correlationId}`;

    log.info("Event received via API", {
      correlation_id: correlationId,
      event_type: body.event_type,
      lead_id: body.lead_id,
      source: body.source,
    });

    // 1. Save event FIRST
    const eventId = await saveEvent({
      correlation_id: correlationId,
      event_type: body.event_type,
      lead_id: body.lead_id,
      payload: body.payload,
      idempotency_key: idempotencyKey,
      source: body.source,
    });

    if (!eventId) {
      res.status(200).json({
        status: "duplicate",
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
      });
      return;
    }

    // 2. Trigger workflow
    try {
      const executionId = await triggerWorkflow({
        event_id: eventId,
        correlation_id: correlationId,
        event_type: body.event_type,
        lead_id: body.lead_id,
        payload: body.payload,
        source: body.source,
      });

      await updateEventStatus(eventId, "processing", executionId);

      log.info("Event dispatched to workflow", {
        correlation_id: correlationId,
        event_id: eventId,
        event_type: body.event_type,
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

      log.error("Failed to trigger workflow for event", {
        correlation_id: correlationId,
        event_id: eventId,
        event_type: body.event_type,
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
