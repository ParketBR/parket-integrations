import { pool } from "../config/db.js";
import { createLogger } from "../config/logger.js";

const log = createLogger("service:event-store");

export interface EventRecord {
  id?: string;
  correlation_id: string;
  event_type: string;
  lead_id?: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  source?: string;
  workflow_execution_id?: string;
}

/**
 * Save event to Postgres.
 * Returns the event id if saved, null if duplicate (idempotent).
 */
export async function saveEvent(event: EventRecord): Promise<string | null> {
  try {
    const result = await pool.query(
      `INSERT INTO events (correlation_id, event_type, lead_id, payload, idempotency_key, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'received')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        event.correlation_id,
        event.event_type,
        event.lead_id ?? null,
        JSON.stringify(event.payload),
        event.idempotency_key,
        event.source ?? null,
      ]
    );

    if (result.rows.length === 0) {
      log.info("Duplicate event skipped (idempotent)", {
        correlation_id: event.correlation_id,
        idempotency_key: event.idempotency_key,
        event_type: event.event_type,
      });
      return null;
    }

    const eventId = result.rows[0].id;
    log.info("Event saved to store", {
      event_id: eventId,
      correlation_id: event.correlation_id,
      event_type: event.event_type,
    });
    return eventId;
  } catch (err) {
    log.error("Failed to save event", {
      correlation_id: event.correlation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Update event status after workflow execution.
 */
export async function updateEventStatus(
  eventId: string,
  status: "processing" | "processed" | "failed",
  workflowExecutionId?: string,
  error?: string
): Promise<void> {
  await pool.query(
    `UPDATE events
     SET status = $1, workflow_execution_id = $2, error = $3
     WHERE id = $4`,
    [status, workflowExecutionId ?? null, error ?? null, eventId]
  );
}
