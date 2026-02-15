import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendSlackMessage } from "../connectors/slack/client.js";

const log = createChildLogger("service:market-intelligence");

// ─── Types ──────────────────────────────────────────

export interface ProspectInput {
  name: string;
  type: "architect" | "incorporadora" | "designer" | "builder";
  company: string | null;
  phone: string | null;
  email: string | null;
  instagram: string | null;
  region: string;
  tier: "high_potential" | "build_relationship" | "nurture";
  rationale: string;
  entry_strategy: string | null;
  estimated_annual_value: number;
}

export interface ConnectionLog {
  prospect_id: string;
  channel: "whatsapp" | "email" | "instagram_dm" | "phone" | "visit" | "event";
  description: string;
  outcome: "positive" | "neutral" | "negative" | "no_response";
}

// ─── Prospect Management ────────────────────────────

/**
 * Add a new prospect to the intelligence pipeline.
 */
export async function addProspect(input: ProspectInput): Promise<string> {
  const result = await db
    .insertInto("prospects")
    .values({
      name: input.name,
      type: input.type,
      company: input.company,
      phone: input.phone,
      email: input.email,
      instagram: input.instagram,
      region: input.region,
      tier: input.tier,
      rationale: input.rationale,
      entry_strategy: input.entry_strategy,
      estimated_annual_value: input.estimated_annual_value,
      status: "identified",
      relationship_score: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  log.info({ id: result.id, name: input.name, type: input.type }, "Prospect added");
  return result.id;
}

/**
 * Log a connection attempt/interaction with a prospect.
 */
export async function logConnection(input: ConnectionLog): Promise<void> {
  await db
    .insertInto("prospect_connections")
    .values({
      prospect_id: input.prospect_id,
      channel: input.channel,
      description: input.description,
      outcome: input.outcome,
    })
    .execute();

  // Update relationship score based on outcome
  const scoreIncrement =
    input.outcome === "positive" ? 15 :
    input.outcome === "neutral" ? 5 :
    input.outcome === "no_response" ? 0 : -5;

  await db
    .updateTable("prospects")
    .set({
      relationship_score: sql`LEAST(100, GREATEST(0, relationship_score + ${sql.lit(scoreIncrement)}))` as any,
      last_contact_at: new Date(),
      status:
        input.outcome === "positive" ? "engaged" : undefined as any,
    })
    .where("id", "=", input.prospect_id)
    .execute();

  log.info(
    { prospectId: input.prospect_id, channel: input.channel, outcome: input.outcome },
    "Connection logged"
  );
}

/**
 * Convert a prospect to a lead (when they become a real opportunity).
 */
export async function convertProspectToLead(
  prospectId: string,
  funnel: "architects" | "end_client" | "developers"
): Promise<string | null> {
  const prospect = await db
    .selectFrom("prospects")
    .selectAll()
    .where("id", "=", prospectId)
    .executeTakeFirst();

  if (!prospect || !prospect.phone) {
    log.warn({ prospectId }, "Cannot convert prospect without phone");
    return null;
  }

  // Normalize phone
  let phoneNorm = prospect.phone.replace(/\D/g, "");
  if (phoneNorm.length === 11) phoneNorm = "55" + phoneNorm;
  else if (phoneNorm.length === 10)
    phoneNorm = "55" + phoneNorm.slice(0, 2) + "9" + phoneNorm.slice(2);

  // Create lead
  const lead = await db
    .insertInto("leads")
    .values({
      source: "referral" as const,
      funnel,
      stage: "triagem" as const,
      name: prospect.name,
      phone: prospect.phone,
      phone_normalized: phoneNorm,
      email: prospect.email,
      client_type:
        prospect.type === "architect" ? "architect" as const :
        prospect.type === "incorporadora" ? "developer" as const :
        "contractor" as const,
      location: prospect.region,
      score: 0,
    })
    .returning("id")
    .executeTakeFirst();

  if (lead) {
    await db
      .updateTable("prospects")
      .set({ status: "converted", converted_lead_id: lead.id })
      .where("id", "=", prospectId)
      .execute();

    log.info({ prospectId, leadId: lead.id }, "Prospect converted to lead");
    return lead.id;
  }

  return null;
}

// ─── Analytics ──────────────────────────────────────

/**
 * Get prospect pipeline by region and tier.
 */
export async function getProspectPipeline(): Promise<{
  by_region: Array<{ region: string; count: number; value: number }>;
  by_tier: Array<{ tier: string; count: number; value: number }>;
  by_status: Array<{ status: string; count: number }>;
  total_estimated_value: number;
}> {
  const byRegion = await db
    .selectFrom("prospects")
    .select([
      "region",
      db.fn.count("id").as("count"),
      db.fn.coalesce(db.fn.sum("estimated_annual_value"), sql.lit(0)).as("value"),
    ])
    .where("status", "not in", ["converted", "disqualified"])
    .groupBy("region")
    .orderBy(db.fn.count("id"), "desc")
    .execute();

  const byTier = await db
    .selectFrom("prospects")
    .select([
      "tier",
      db.fn.count("id").as("count"),
      db.fn.coalesce(db.fn.sum("estimated_annual_value"), sql.lit(0)).as("value"),
    ])
    .where("status", "not in", ["converted", "disqualified"])
    .groupBy("tier")
    .execute();

  const byStatus = await db
    .selectFrom("prospects")
    .select(["status", db.fn.count("id").as("count")])
    .groupBy("status")
    .execute();

  const totalValue = byRegion.reduce((sum, r) => sum + Number(r.value), 0);

  return {
    by_region: byRegion.map((r) => ({
      region: r.region,
      count: Number(r.count),
      value: Number(r.value),
    })),
    by_tier: byTier.map((t) => ({
      tier: t.tier,
      count: Number(t.count),
      value: Number(t.value),
    })),
    by_status: byStatus.map((s) => ({
      status: s.status,
      count: Number(s.count),
    })),
    total_estimated_value: totalValue,
  };
}

/**
 * Get prospects that need follow-up (no contact in N days).
 */
export async function getStaleProspects(
  daysSinceContact: number = 14
): Promise<Array<{ id: string; name: string; type: string; region: string; days_stale: number }>> {
  const threshold = new Date(
    Date.now() - daysSinceContact * 86_400_000
  );

  const stale = await db
    .selectFrom("prospects")
    .select([
      "id",
      "name",
      "type",
      "region",
      sql<number>`EXTRACT(EPOCH FROM (NOW() - COALESCE(last_contact_at, created_at))) / 86400`.as("days_stale"),
    ])
    .where("status", "in", ["identified", "contacted", "engaged"])
    .where(
      sql`COALESCE(last_contact_at, created_at)`,
      "<",
      threshold
    )
    .orderBy("estimated_annual_value", "desc")
    .execute();

  if (stale.length > 0) {
    log.info({ count: stale.length }, "Stale prospects found");
  }

  return stale.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    region: s.region,
    days_stale: Math.round(s.days_stale),
  }));
}

/**
 * Generate weekly intelligence report.
 */
export async function generateIntelligenceReport(): Promise<string> {
  const pipeline = await getProspectPipeline();
  const stale = await getStaleProspects(14);

  const recentConnections = await db
    .selectFrom("prospect_connections")
    .select([db.fn.count("id").as("count")])
    .where("created_at", ">=", new Date(Date.now() - 7 * 86_400_000))
    .executeTakeFirst();

  const conversions = await db
    .selectFrom("prospects")
    .select([db.fn.count("id").as("count")])
    .where("status", "=", "converted")
    .where("updated_at", ">=", new Date(Date.now() - 30 * 86_400_000))
    .executeTakeFirst();

  const report = [
    `*INTELIGENCIA DE MERCADO — Semanal*`,
    ``,
    `*Pipeline de Prospects:*`,
    ...pipeline.by_tier.map(
      (t) => `  ${t.tier}: ${t.count} prospects (R$ ${Number(t.value).toLocaleString("pt-BR")}/ano)`
    ),
    `  Total estimado: R$ ${pipeline.total_estimated_value.toLocaleString("pt-BR")}/ano`,
    ``,
    `*Conexoes esta semana:* ${recentConnections?.count ?? 0}`,
    `*Conversoes (30d):* ${conversions?.count ?? 0}`,
    ``,
    stale.length > 0
      ? `*${stale.length} prospects sem contato ha +14 dias:*\n${stale.slice(0, 5).map((s) => `  - ${s.name} (${s.region}) — ${s.days_stale}d`).join("\n")}`
      : `Todos os prospects com contato recente.`,
  ].join("\n");

  try {
    await sendSlackMessage({ text: report });
  } catch (err) {
    log.error({ err }, "Failed to send intelligence report");
  }

  return report;
}
