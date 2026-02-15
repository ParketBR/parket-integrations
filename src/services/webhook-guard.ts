import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";

const log = createChildLogger("service:webhook-guard");

/**
 * Idempotency guard for webhooks.
 * Returns true if this is a new event, false if duplicate.
 */
export async function isNewWebhookEvent(
  source: string,
  eventType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    await db
      .insertInto("webhook_logs")
      .values({
        source,
        event_type: eventType,
        payload,
        status: "received",
        idempotency_key: idempotencyKey,
        error: null,
      })
      .execute();

    return true;
  } catch (err: unknown) {
    // Unique constraint violation = duplicate
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      log.info({ source, idempotencyKey }, "Duplicate webhook event, skipping");
      return false;
    }
    throw err;
  }
}

/**
 * Mark a webhook event as processed or failed
 */
export async function markWebhookStatus(
  idempotencyKey: string,
  status: "processed" | "failed",
  error?: string
): Promise<void> {
  await db
    .updateTable("webhook_logs")
    .set({ status, error: error ?? null })
    .where("idempotency_key", "=", idempotencyKey)
    .execute();
}
