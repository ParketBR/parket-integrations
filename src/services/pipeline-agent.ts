import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";
import { sendSlackMessage } from "../connectors/slack/client.js";

const log = createChildLogger("service:pipeline-agent");

// ─── Stale Deals ───────────────────────────────────

interface StaleDeal {
  id: string;
  name: string;
  phone: string;
  stage: string;
  funnel: string;
  estimated_ticket: number | null;
  days_stale: number;
}

/**
 * Find deals without activity for more than N days.
 * Returns list of stale deals and sends alerts.
 */
export async function detectStaleDeals(
  thresholdDays: number = 5
): Promise<StaleDeal[]> {
  const threshold = new Date(Date.now() - thresholdDays * 86_400_000);

  const staleDeals = await db
    .selectFrom("leads")
    .leftJoin("activities", (join) =>
      join
        .onRef("activities.lead_id", "=", "leads.id")
        .on("activities.created_at", ">", threshold)
    )
    .select([
      "leads.id",
      "leads.name",
      "leads.phone",
      "leads.stage",
      "leads.funnel",
      "leads.estimated_ticket",
      db.raw<number>(
        `EXTRACT(EPOCH FROM (NOW() - leads.updated_at)) / 86400`
      ).as("days_stale"),
    ])
    .where("leads.stage", "not in", ["fechado", "perdido"])
    .where("leads.updated_at", "<", threshold)
    .where("activities.id", "is", null)
    .orderBy("leads.estimated_ticket", "desc")
    .execute();

  if (staleDeals.length === 0) {
    log.info("No stale deals found");
    return [];
  }

  log.warn({ count: staleDeals.length }, "Stale deals detected");

  // Build alert message
  const alertLines = staleDeals.slice(0, 10).map((d, i) => {
    const ticket = d.estimated_ticket
      ? `R$ ${Number(d.estimated_ticket).toLocaleString("pt-BR")}`
      : "sem valor";
    return `${i + 1}. *${d.name}* — ${d.stage} (${Math.round(d.days_stale)}d parado) — ${ticket}`;
  });

  const totalValue = staleDeals.reduce(
    (sum, d) => sum + (Number(d.estimated_ticket) || 0),
    0
  );

  const message = [
    `*ALERTA: ${staleDeals.length} deals parados*`,
    `Valor em risco: R$ ${totalValue.toLocaleString("pt-BR")}`,
    ``,
    ...alertLines,
    staleDeals.length > 10 ? `\n... e mais ${staleDeals.length - 10}` : "",
    ``,
    `Acao: revisar e definir proximo passo para cada deal.`,
  ]
    .filter(Boolean)
    .join("\n");

  // Send to WhatsApp SDR group
  const sdrGroup = process.env.WHATSAPP_SDR_GROUP;
  if (sdrGroup) {
    try {
      await sendGroupMessage(sdrGroup, message);
    } catch (err) {
      log.error({ err }, "Failed to send stale deals WhatsApp alert");
    }
  }

  // Send to Slack
  try {
    await sendSlackMessage({
      text: `Pipeline Alert: ${staleDeals.length} stale deals (R$ ${totalValue.toLocaleString("pt-BR")} at risk)`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `${staleDeals.length} Deals Parados` },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: alertLines.join("\n"),
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Valor em risco:*\nR$ ${totalValue.toLocaleString("pt-BR")}` },
            { type: "mrkdwn", text: `*Threshold:*\n${thresholdDays} dias sem atividade` },
          ],
        },
      ],
    });
  } catch (err) {
    log.error({ err }, "Failed to send stale deals Slack alert");
  }

  return staleDeals as StaleDeal[];
}

// ─── Weekly Forecast ───────────────────────────────

interface ForecastEntry {
  funnel: string;
  stage: string;
  deal_count: number;
  total_value: number;
  weighted_value: number;
}

const STAGE_PROBABILITIES: Record<string, number> = {
  triagem: 0.05,
  qualificado: 0.15,
  reuniao: 0.30,
  proposta: 0.50,
  negociacao: 0.75,
};

/**
 * Generate weekly forecast with weighted pipeline values.
 * Saves snapshot to DB and sends summary.
 */
export async function generateWeeklyForecast(): Promise<{
  entries: ForecastEntry[];
  totalWeighted: number;
}> {
  const entries = await db
    .selectFrom("leads")
    .select([
      "funnel",
      "stage",
      db.fn.count("id").as("deal_count"),
      db.fn.coalesce(db.fn.sum("estimated_ticket"), db.val(0)).as("total_value"),
    ])
    .where("stage", "not in", ["fechado", "perdido"])
    .groupBy(["funnel", "stage"])
    .execute();

  const forecast: ForecastEntry[] = entries.map((e) => ({
    funnel: e.funnel,
    stage: e.stage,
    deal_count: Number(e.deal_count),
    total_value: Number(e.total_value),
    weighted_value:
      Number(e.total_value) * (STAGE_PROBABILITIES[e.stage] ?? 0.1),
  }));

  const totalWeighted = forecast.reduce((sum, f) => sum + f.weighted_value, 0);
  const totalRaw = forecast.reduce((sum, f) => sum + f.total_value, 0);
  const totalDeals = forecast.reduce((sum, f) => sum + f.deal_count, 0);

  // Save snapshots
  const snapshotDate = new Date();
  for (const entry of forecast) {
    await db
      .insertInto("pipeline_snapshots")
      .values({
        snapshot_date: snapshotDate,
        funnel: entry.funnel,
        stage: entry.stage,
        deal_count: entry.deal_count,
        total_value: entry.total_value,
        avg_age_days: 0,
        conversion_rate: null,
      })
      .onConflict((oc) =>
        oc.columns(["snapshot_date", "funnel", "stage"]).doUpdateSet({
          deal_count: entry.deal_count,
          total_value: entry.total_value,
        })
      )
      .execute();
  }

  // Build report
  const funnelSummary = Object.entries(
    forecast.reduce(
      (acc, f) => {
        if (!acc[f.funnel]) acc[f.funnel] = { deals: 0, raw: 0, weighted: 0 };
        acc[f.funnel].deals += f.deal_count;
        acc[f.funnel].raw += f.total_value;
        acc[f.funnel].weighted += f.weighted_value;
        return acc;
      },
      {} as Record<string, { deals: number; raw: number; weighted: number }>
    )
  )
    .map(
      ([funnel, data]) =>
        `*${funnel}*: ${data.deals} deals | R$ ${data.raw.toLocaleString("pt-BR")} (ponderado: R$ ${data.weighted.toLocaleString("pt-BR")})`
    )
    .join("\n");

  const message = [
    `*FORECAST SEMANAL PARKET*`,
    `Data: ${snapshotDate.toLocaleDateString("pt-BR")}`,
    ``,
    `Pipeline Total: ${totalDeals} deals`,
    `Valor Bruto: R$ ${totalRaw.toLocaleString("pt-BR")}`,
    `Valor Ponderado: R$ ${totalWeighted.toLocaleString("pt-BR")}`,
    ``,
    funnelSummary,
  ].join("\n");

  // Send alerts
  const sdrGroup = process.env.WHATSAPP_SDR_GROUP;
  if (sdrGroup) {
    try {
      await sendGroupMessage(sdrGroup, message);
    } catch (err) {
      log.error({ err }, "Failed to send forecast WhatsApp");
    }
  }

  try {
    await sendSlackMessage({
      text: `Forecast Semanal: R$ ${totalWeighted.toLocaleString("pt-BR")} ponderado (${totalDeals} deals)`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Forecast Semanal Parket" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Pipeline Total:*\n${totalDeals} deals` },
            { type: "mrkdwn", text: `*Valor Bruto:*\nR$ ${totalRaw.toLocaleString("pt-BR")}` },
            { type: "mrkdwn", text: `*Valor Ponderado:*\nR$ ${totalWeighted.toLocaleString("pt-BR")}` },
          ],
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: funnelSummary },
        },
      ],
    });
  } catch (err) {
    log.error({ err }, "Failed to send forecast Slack");
  }

  log.info(
    { totalDeals, totalRaw, totalWeighted },
    "Weekly forecast generated"
  );

  return { entries: forecast, totalWeighted };
}
