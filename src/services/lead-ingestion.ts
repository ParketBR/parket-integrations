import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { normalizePhone } from "../connectors/whatsapp/client.js";
import { notifyNewLead } from "../connectors/whatsapp/client.js";
import {
  createPerson,
  findPersonByPhone,
  createDeal,
} from "../connectors/pipedrive/client.js";
import { scoreLead } from "./lead-scoring.js";
import { startSla } from "./sla-monitor.js";
import type { NewLead, Lead } from "../db/schemas/types.js";

const log = createChildLogger("service:lead-ingestion");

export interface RawLeadInput {
  name: string;
  email?: string;
  phone: string;
  source: NewLead["source"];

  // Optional qualification
  client_type?: NewLead["client_type"];
  project_type?: NewLead["project_type"];
  project_stage?: NewLead["project_stage"];
  location?: string;
  estimated_deadline?: string;
  estimated_ticket?: number;

  // Tracking
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;

  // External reference
  external_id?: string;
}

export interface IngestionResult {
  lead: Lead;
  isNew: boolean;
  pipedriveDealId?: number;
}

/**
 * Main ingestion pipeline:
 * 1. Normalize phone
 * 2. Dedup check
 * 3. Score
 * 4. Insert or merge
 * 5. Sync to Pipedrive
 * 6. Start SLA timer
 * 7. Notify SDR via WhatsApp
 */
export async function ingestLead(
  input: RawLeadInput
): Promise<IngestionResult> {
  const phoneNormalized = normalizePhone(input.phone);
  log.info({ name: input.name, phone: phoneNormalized, source: input.source }, "Ingesting lead");

  // ── Dedup ──
  const existing = await db
    .selectFrom("leads")
    .selectAll()
    .where("phone_normalized", "=", phoneNormalized)
    .executeTakeFirst();

  if (existing) {
    log.info({ leadId: existing.id }, "Duplicate lead found, merging data");
    return await mergeLead(existing, input);
  }

  // ── Determine funnel ──
  const funnel = inferFunnel(input.client_type);

  // ── Score ──
  const score = scoreLead(input);

  // ── Insert ──
  const [lead] = await db
    .insertInto("leads")
    .values({
      external_id: input.external_id ?? null,
      source: input.source,
      funnel,
      stage: "triagem",
      name: input.name,
      email: input.email ?? null,
      phone: input.phone,
      phone_normalized: phoneNormalized,
      client_type: input.client_type ?? null,
      project_type: input.project_type ?? null,
      project_stage: input.project_stage ?? null,
      location: input.location ?? null,
      estimated_deadline: input.estimated_deadline ?? null,
      estimated_ticket: input.estimated_ticket ?? null,
      score,
      utm_source: input.utm_source ?? null,
      utm_medium: input.utm_medium ?? null,
      utm_campaign: input.utm_campaign ?? null,
      utm_content: input.utm_content ?? null,
      pipedrive_deal_id: null,
      pipedrive_person_id: null,
      qualified_at: null,
      closed_at: null,
    })
    .returningAll()
    .execute();

  // ── Log activity ──
  await db
    .insertInto("activities")
    .values({
      lead_id: lead.id,
      type: "sla_start",
      description: `Lead received from ${input.source}`,
      metadata: { source: input.source, utm_campaign: input.utm_campaign },
    })
    .execute();

  // ── Sync to Pipedrive (async-safe) ──
  let pipedriveDealId: number | undefined;
  try {
    pipedriveDealId = await syncToPipedrive(lead);
  } catch (err) {
    log.error({ err, leadId: lead.id }, "Pipedrive sync failed, will retry via job");
  }

  // ── Start SLA timer ──
  try {
    await startSla(lead.id, "response_5min");
  } catch (err) {
    log.error({ err, leadId: lead.id }, "SLA start failed");
  }

  // ── Notify SDR ──
  try {
    await notifyNewLead({
      name: lead.name,
      phone: lead.phone,
      source: lead.source,
      project_type: lead.project_type,
      location: lead.location,
    });
  } catch (err) {
    log.error({ err, leadId: lead.id }, "WhatsApp notification failed");
  }

  log.info({ leadId: lead.id, score }, "Lead ingested successfully");

  return { lead, isNew: true, pipedriveDealId };
}

/**
 * Merge new data into existing lead (dedup merge)
 */
async function mergeLead(
  existing: Lead,
  input: RawLeadInput
): Promise<IngestionResult> {
  const updates: Record<string, unknown> = { updated_at: new Date() };

  // Merge fields that were null
  if (!existing.email && input.email) updates.email = input.email;
  if (!existing.client_type && input.client_type) updates.client_type = input.client_type;
  if (!existing.project_type && input.project_type) updates.project_type = input.project_type;
  if (!existing.project_stage && input.project_stage) updates.project_stage = input.project_stage;
  if (!existing.location && input.location) updates.location = input.location;
  if (!existing.estimated_ticket && input.estimated_ticket)
    updates.estimated_ticket = input.estimated_ticket;

  if (Object.keys(updates).length > 1) {
    await db
      .updateTable("leads")
      .set(updates)
      .where("id", "=", existing.id)
      .execute();
  }

  await db
    .insertInto("activities")
    .values({
      lead_id: existing.id,
      type: "note",
      description: `Duplicate contact from ${input.source}, data merged`,
      metadata: { source: input.source, merged_fields: Object.keys(updates) },
    })
    .execute();

  const updated = await db
    .selectFrom("leads")
    .selectAll()
    .where("id", "=", existing.id)
    .executeTakeFirstOrThrow();

  return { lead: updated, isNew: false };
}

/**
 * Create person + deal in Pipedrive
 */
async function syncToPipedrive(lead: Lead): Promise<number> {
  // Check if person exists
  let person = await findPersonByPhone(lead.phone_normalized);

  if (!person) {
    person = await createPerson({
      name: lead.name,
      email: lead.email ?? undefined,
      phone: lead.phone,
    });
  }

  // Create deal
  const deal = await createDeal({
    title: `${lead.name} — ${lead.source}`,
    person_id: person.id,
    value: lead.estimated_ticket ?? undefined,
  });

  // Update lead with Pipedrive IDs
  await db
    .updateTable("leads")
    .set({
      pipedrive_person_id: person.id,
      pipedrive_deal_id: deal.id,
    })
    .where("id", "=", lead.id)
    .execute();

  log.info({ leadId: lead.id, dealId: deal.id }, "Synced to Pipedrive");
  return deal.id;
}

function inferFunnel(
  clientType?: string | null
): "architects" | "end_client" | "developers" {
  switch (clientType) {
    case "architect":
      return "architects";
    case "developer":
    case "contractor":
      return "developers";
    default:
      return "end_client";
  }
}
