import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendSlackMessage } from "../connectors/slack/client.js";

const log = createChildLogger("service:cac-calculator");

// ─── Types ──────────────────────────────────────────

export interface CacResult {
  period: string;
  total_marketing_spend: number;
  total_sales_spend: number;
  total_spend: number;
  new_customers: number;
  cac: number;
  revenue_from_new: number;
  ltv_estimate: number;
  ltv_cac_ratio: number;
}

export interface CacBySource {
  source: string;
  spend: number;
  leads: number;
  customers: number;
  cac: number;
  cost_per_lead: number;
  conversion_rate: number;
}

export interface ExecutiveScoreboard {
  // Revenue
  mtd_revenue: number;
  mtd_revenue_target: number;
  mtd_revenue_pct: number;
  ytd_revenue: number;

  // Pipeline
  pipeline_value: number;
  pipeline_weighted: number;
  active_deals: number;
  avg_deal_size: number;

  // Conversion
  lead_to_close_rate: number;
  avg_sales_cycle_days: number;

  // Operations
  active_projects: number;
  projects_on_time_pct: number;
  avg_quality_score: number;

  // Financial
  gross_margin_pct: number;
  cac: number;
  ltv_cac_ratio: number;

  // Growth
  mom_revenue_growth: number;
  mom_lead_growth: number;
}

// ─── CAC Calculation ────────────────────────────────

/**
 * Calculate CAC (Customer Acquisition Cost) for a given month.
 * CAC = (Marketing Spend + Sales Spend) / New Customers
 */
export async function calculateMonthlyCac(
  year: number,
  month: number
): Promise<CacResult> {
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month, 0);
  const period = `${year}-${String(month).padStart(2, "0")}`;

  // Marketing spend: payable transactions categorized as marketing
  const marketingSpend = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
    ])
    .where("type", "=", "payable")
    .where("category", "in", ["marketing", "ads", "advertising"])
    .where("issued_at", ">=", periodStart)
    .where("issued_at", "<=", periodEnd)
    .where("status", "!=", "cancelled")
    .executeTakeFirst();

  // Sales spend: payable transactions categorized as sales
  const salesSpend = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
    ])
    .where("type", "=", "payable")
    .where("category", "in", ["sales", "commission", "comissao"])
    .where("issued_at", ">=", periodStart)
    .where("issued_at", "<=", periodEnd)
    .where("status", "!=", "cancelled")
    .executeTakeFirst();

  // New customers (leads that reached 'fechado' this month)
  const newCustomers = await db
    .selectFrom("leads")
    .select([
      db.fn.count("id").as("count"),
      db.fn.coalesce(db.fn.sum("estimated_ticket"), sql.lit(0)).as("revenue"),
    ])
    .where("stage", "=", "fechado")
    .where("closed_at", ">=", periodStart)
    .where("closed_at", "<=", periodEnd)
    .executeTakeFirst();

  const totalMarketing = Number(marketingSpend?.total ?? 0);
  const totalSales = Number(salesSpend?.total ?? 0);
  const totalSpend = totalMarketing + totalSales;
  const customers = Number(newCustomers?.count ?? 0);
  const revenueFromNew = Number(newCustomers?.revenue ?? 0);
  const cac = customers > 0 ? Math.round(totalSpend / customers) : 0;

  // LTV estimate (avg revenue per customer * avg projects per customer)
  // Simplified: use avg ticket of closed deals
  const avgTicket = await db
    .selectFrom("leads")
    .select([
      db.fn.coalesce(db.fn.avg("estimated_ticket"), sql.lit(0)).as("avg"),
    ])
    .where("stage", "=", "fechado")
    .where("estimated_ticket", "is not", null)
    .executeTakeFirst();

  const ltvEstimate = Number(avgTicket?.avg ?? 0) * 1.3; // 30% repeat factor
  const ltvCacRatio = cac > 0 ? Math.round((ltvEstimate / cac) * 10) / 10 : 0;

  log.info({ period, cac, customers, totalSpend, ltvCacRatio }, "CAC calculated");

  return {
    period,
    total_marketing_spend: totalMarketing,
    total_sales_spend: totalSales,
    total_spend: totalSpend,
    new_customers: customers,
    cac,
    revenue_from_new: revenueFromNew,
    ltv_estimate: Math.round(ltvEstimate),
    ltv_cac_ratio: ltvCacRatio,
  };
}

/**
 * Calculate CAC broken down by lead source.
 */
export async function calculateCacBySource(
  year: number,
  month: number
): Promise<CacBySource[]> {
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month, 0);

  // Leads and conversions by source this month
  const sourceData = await db
    .selectFrom("leads")
    .select([
      "source",
      db.fn.count("id").as("total_leads"),
      sql<number>`COUNT(CASE WHEN stage = 'fechado' THEN id END)`.as("customers"),
    ])
    .where("created_at", ">=", periodStart)
    .where("created_at", "<=", periodEnd)
    .groupBy("source")
    .execute();

  // Spend allocation by source (from marketing_spend_allocation table or estimate)
  // Simplified: proportional to lead count
  const totalSpend = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
    ])
    .where("type", "=", "payable")
    .where("category", "in", ["marketing", "ads", "advertising"])
    .where("issued_at", ">=", periodStart)
    .where("issued_at", "<=", periodEnd)
    .where("status", "!=", "cancelled")
    .executeTakeFirst();

  const spend = Number(totalSpend?.total ?? 0);
  const totalLeads = sourceData.reduce((sum, s) => sum + Number(s.total_leads), 0);

  return sourceData.map((s) => {
    const leads = Number(s.total_leads);
    const customers = Number(s.customers);
    const sourceSpend =
      totalLeads > 0 ? Math.round((spend * leads) / totalLeads) : 0;
    const cac = customers > 0 ? Math.round(sourceSpend / customers) : 0;
    const cpl = leads > 0 ? Math.round(sourceSpend / leads) : 0;
    const convRate =
      leads > 0 ? Math.round((customers / leads) * 1000) / 10 : 0;

    return {
      source: s.source,
      spend: sourceSpend,
      leads,
      customers,
      cac,
      cost_per_lead: cpl,
      conversion_rate: convRate,
    };
  });
}

// ─── Executive Scoreboard ───────────────────────────

const STAGE_PROBABILITIES: Record<string, number> = {
  triagem: 0.05,
  qualificado: 0.15,
  reuniao: 0.30,
  proposta: 0.50,
  negociacao: 0.75,
};

/**
 * Generate the executive scoreboard — single view of all KPIs.
 */
export async function generateExecutiveScoreboard(
  monthlyRevenueTarget: number = 500_000
): Promise<ExecutiveScoreboard> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  // ── Revenue MTD ──
  const mtdRev = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
    ])
    .where("type", "=", "receivable")
    .where("status", "=", "paid")
    .where("paid_at", ">=", monthStart)
    .executeTakeFirst();

  const mtdRevenue = Number(mtdRev?.total ?? 0);

  // ── Revenue YTD ──
  const ytdRev = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
    ])
    .where("type", "=", "receivable")
    .where("status", "=", "paid")
    .where("paid_at", ">=", yearStart)
    .executeTakeFirst();

  // ── Pipeline ──
  const pipeline = await db
    .selectFrom("leads")
    .select([
      db.fn.count("id").as("deals"),
      db.fn.coalesce(db.fn.sum("estimated_ticket"), sql.lit(0)).as("value"),
      db.fn.coalesce(db.fn.avg("estimated_ticket"), sql.lit(0)).as("avg_deal"),
      "stage",
    ])
    .where("stage", "not in", ["fechado", "perdido"])
    .groupBy("stage")
    .execute();

  const activePipeline = pipeline.reduce(
    (acc, p) => {
      const val = Number(p.value);
      const prob = STAGE_PROBABILITIES[p.stage] ?? 0.1;
      acc.deals += Number(p.deals);
      acc.value += val;
      acc.weighted += val * prob;
      return acc;
    },
    { deals: 0, value: 0, weighted: 0 }
  );

  const avgDealSize = activePipeline.deals > 0
    ? Math.round(activePipeline.value / activePipeline.deals)
    : 0;

  // ── Conversion Rate ──
  const conversionData = await db
    .selectFrom("leads")
    .select([
      db.fn.count("id").as("total"),
      sql<number>`COUNT(CASE WHEN stage = 'fechado' THEN id END)`.as("closed"),
    ])
    .executeTakeFirst();

  const totalLeads = Number(conversionData?.total ?? 0);
  const closedLeads = Number(conversionData?.closed ?? 0);
  const leadToCloseRate =
    totalLeads > 0 ? Math.round((closedLeads / totalLeads) * 1000) / 10 : 0;

  // ── Avg Sales Cycle ──
  const cycleData = await db
    .selectFrom("leads")
    .select([
      sql<number>`AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400)`.as("avg_days"),
    ])
    .where("stage", "=", "fechado")
    .where("closed_at", "is not", null)
    .executeTakeFirst();

  // ── Operations ──
  const projectsData = await db
    .selectFrom("projects")
    .select([
      db.fn.count("id").as("active"),
      db.fn.coalesce(db.fn.avg("quality_score"), sql.lit(0)).as("avg_quality"),
    ])
    .where("status", "not in", ["concluido", "cancelado"])
    .executeTakeFirst();

  const onTimeData = await db
    .selectFrom("projects")
    .select([
      db.fn.count("id").as("total"),
      sql<number>`COUNT(CASE WHEN estimated_delivery_at >= NOW() OR status IN ('concluido', 'pos_obra') THEN id END)`.as("on_time"),
    ])
    .where("status", "not in", ["cancelado", "handoff"])
    .where("estimated_delivery_at", "is not", null)
    .executeTakeFirst();

  const totalProjects = Number(onTimeData?.total ?? 0);
  const onTimeProjects = Number(onTimeData?.on_time ?? 0);

  // ── Financial ──
  const costData = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total_costs"),
    ])
    .where("type", "=", "payable")
    .where("issued_at", ">=", monthStart)
    .where("status", "!=", "cancelled")
    .executeTakeFirst();

  const mtdCosts = Number(costData?.total_costs ?? 0);
  const grossMarginPct =
    mtdRevenue > 0
      ? Math.round(((mtdRevenue - mtdCosts) / mtdRevenue) * 1000) / 10
      : 0;

  // ── MoM Growth ──
  const prevMonthRev = await db
    .selectFrom("financial_transactions")
    .select([
      db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
    ])
    .where("type", "=", "receivable")
    .where("status", "=", "paid")
    .where("paid_at", ">=", prevMonthStart)
    .where("paid_at", "<=", prevMonthEnd)
    .executeTakeFirst();

  const prevRev = Number(prevMonthRev?.total ?? 0);
  const momRevenueGrowth =
    prevRev > 0
      ? Math.round(((mtdRevenue - prevRev) / prevRev) * 1000) / 10
      : 0;

  const prevMonthLeads = await db
    .selectFrom("leads")
    .select([db.fn.count("id").as("count")])
    .where("created_at", ">=", prevMonthStart)
    .where("created_at", "<=", prevMonthEnd)
    .executeTakeFirst();

  const currentMonthLeads = await db
    .selectFrom("leads")
    .select([db.fn.count("id").as("count")])
    .where("created_at", ">=", monthStart)
    .executeTakeFirst();

  const prevLeads = Number(prevMonthLeads?.count ?? 0);
  const currLeads = Number(currentMonthLeads?.count ?? 0);
  const momLeadGrowth =
    prevLeads > 0
      ? Math.round(((currLeads - prevLeads) / prevLeads) * 1000) / 10
      : 0;

  // ── CAC (simplified) ──
  const cacData = await calculateMonthlyCac(now.getFullYear(), now.getMonth() + 1);

  const scoreboard: ExecutiveScoreboard = {
    mtd_revenue: mtdRevenue,
    mtd_revenue_target: monthlyRevenueTarget,
    mtd_revenue_pct:
      monthlyRevenueTarget > 0
        ? Math.round((mtdRevenue / monthlyRevenueTarget) * 1000) / 10
        : 0,
    ytd_revenue: Number(ytdRev?.total ?? 0),

    pipeline_value: activePipeline.value,
    pipeline_weighted: Math.round(activePipeline.weighted),
    active_deals: activePipeline.deals,
    avg_deal_size: avgDealSize,

    lead_to_close_rate: leadToCloseRate,
    avg_sales_cycle_days: Math.round(Number(cycleData?.avg_days ?? 0)),

    active_projects: Number(projectsData?.active ?? 0),
    projects_on_time_pct:
      totalProjects > 0
        ? Math.round((onTimeProjects / totalProjects) * 1000) / 10
        : 100,
    avg_quality_score: Math.round(Number(projectsData?.avg_quality ?? 0) * 10) / 10,

    gross_margin_pct: grossMarginPct,
    cac: cacData.cac,
    ltv_cac_ratio: cacData.ltv_cac_ratio,

    mom_revenue_growth: momRevenueGrowth,
    mom_lead_growth: momLeadGrowth,
  };

  log.info("Executive scoreboard generated");
  return scoreboard;
}

/**
 * Send executive scoreboard to Slack.
 */
export async function sendScoreboardAlert(
  scoreboard: ExecutiveScoreboard
): Promise<void> {
  const fmt = (n: number) => `R$ ${n.toLocaleString("pt-BR")}`;
  const pct = (n: number) => `${n}%`;

  const revenueEmoji = scoreboard.mtd_revenue_pct >= 80 ? "🟢" : scoreboard.mtd_revenue_pct >= 50 ? "🟡" : "🔴";
  const marginEmoji = scoreboard.gross_margin_pct >= 30 ? "🟢" : scoreboard.gross_margin_pct >= 20 ? "🟡" : "🔴";

  await sendSlackMessage({
    text: `Executive Scoreboard — MTD: ${fmt(scoreboard.mtd_revenue)}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Scoreboard Executivo Parket" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Receita*\n${revenueEmoji} MTD: ${fmt(scoreboard.mtd_revenue)} / ${fmt(scoreboard.mtd_revenue_target)} (${pct(scoreboard.mtd_revenue_pct)})\nYTD: ${fmt(scoreboard.ytd_revenue)}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Pipeline:*\n${scoreboard.active_deals} deals\n${fmt(scoreboard.pipeline_weighted)} ponderado` },
          { type: "mrkdwn", text: `*Ticket Medio:*\n${fmt(scoreboard.avg_deal_size)}\nCiclo: ${scoreboard.avg_sales_cycle_days}d` },
        ],
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Conversao:*\n${pct(scoreboard.lead_to_close_rate)} lead→close` },
          { type: "mrkdwn", text: `${marginEmoji} *Margem:*\n${pct(scoreboard.gross_margin_pct)}` },
        ],
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*CAC:*\n${fmt(scoreboard.cac)}\nLTV/CAC: ${scoreboard.ltv_cac_ratio}x` },
          { type: "mrkdwn", text: `*Obras:*\n${scoreboard.active_projects} ativas\n${pct(scoreboard.projects_on_time_pct)} on-time` },
        ],
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*MoM Receita:*\n${scoreboard.mom_revenue_growth > 0 ? "📈" : "📉"} ${pct(scoreboard.mom_revenue_growth)}` },
          { type: "mrkdwn", text: `*MoM Leads:*\n${scoreboard.mom_lead_growth > 0 ? "📈" : "📉"} ${pct(scoreboard.mom_lead_growth)}` },
        ],
      },
    ],
  });

  log.info("Scoreboard sent to Slack");
}
