import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendSlackMessage } from "../connectors/slack/client.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";

const log = createChildLogger("service:margin-analysis");

// ─── Types ──────────────────────────────────────────

export interface ProjectMargin {
  project_id: string;
  project_name: string;
  client_name: string;
  contract_value: number;
  total_revenue: number;
  total_costs: number;
  gross_margin: number;
  margin_pct: number;
  material_cost: number;
  labor_cost: number;
  overhead_cost: number;
}

export interface CashFlowEntry {
  period: string;
  receivable_total: number;
  receivable_received: number;
  payable_total: number;
  payable_paid: number;
  net_flow: number;
  cumulative: number;
}

export interface MonthlyPnL {
  month: string;
  gross_revenue: number;
  taxes: number;
  net_revenue: number;
  material_costs: number;
  labor_costs: number;
  overhead: number;
  total_costs: number;
  gross_profit: number;
  gross_margin_pct: number;
}

// ─── Margin Analysis ────────────────────────────────

/**
 * Calculate margin per project.
 * Revenue = sum of receivable transactions linked to project.
 * Costs = sum of payable transactions + purchase orders.
 */
export async function calculateProjectMargins(): Promise<ProjectMargin[]> {
  const projects = await db
    .selectFrom("projects")
    .select([
      "id",
      "name",
      "client_name",
      "contract_value",
    ])
    .where("status", "not in", ["cancelado", "handoff"])
    .execute();

  const margins: ProjectMargin[] = [];

  for (const project of projects) {
    // Revenue from financial_transactions (receivable)
    const revenue = await db
      .selectFrom("financial_transactions")
      .select([
        db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
      ])
      .where("project_id", "=", project.id)
      .where("type", "=", "receivable")
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    // Costs from financial_transactions (payable)
    const costs = await db
      .selectFrom("financial_transactions")
      .select([
        db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
        sql<number>`COALESCE(SUM(CASE WHEN category = 'material' THEN net_value ELSE 0 END), 0)`.as("material"),
        sql<number>`COALESCE(SUM(CASE WHEN category = 'labor' THEN net_value ELSE 0 END), 0)`.as("labor"),
      ])
      .where("project_id", "=", project.id)
      .where("type", "=", "payable")
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    // Additional costs from purchase orders
    const poCosts = await db
      .selectFrom("purchase_orders")
      .select([
        db.fn.coalesce(db.fn.sum("total_value"), sql.lit(0)).as("total"),
      ])
      .where("project_id", "=", project.id)
      .where("status", "not in", ["cancelled", "draft"])
      .executeTakeFirst();

    const totalRevenue = Number(revenue?.total ?? 0);
    const totalCosts = Number(costs?.total ?? 0) + Number(poCosts?.total ?? 0);
    const materialCost = Number(costs?.material ?? 0) + Number(poCosts?.total ?? 0);
    const laborCost = Number(costs?.labor ?? 0);
    const overheadCost = totalCosts - materialCost - laborCost;
    const grossMargin = totalRevenue - totalCosts;
    const marginPct = totalRevenue > 0 ? (grossMargin / totalRevenue) * 100 : 0;

    margins.push({
      project_id: project.id,
      project_name: project.name,
      client_name: project.client_name,
      contract_value: Number(project.contract_value),
      total_revenue: totalRevenue,
      total_costs: totalCosts,
      gross_margin: grossMargin,
      margin_pct: Math.round(marginPct * 10) / 10,
      material_cost: materialCost,
      labor_cost: laborCost,
      overhead_cost: overheadCost,
    });
  }

  // Sort by margin pct ascending (worst first)
  margins.sort((a, b) => a.margin_pct - b.margin_pct);

  log.info({ projectCount: margins.length }, "Project margins calculated");
  return margins;
}

/**
 * Detect projects with margin below threshold.
 * Default: alert if below 25% (Parket premium positioning requires healthy margins).
 */
export async function detectLowMarginProjects(
  thresholdPct: number = 25
): Promise<ProjectMargin[]> {
  const margins = await calculateProjectMargins();
  const lowMargin = margins.filter(
    (m) => m.total_revenue > 0 && m.margin_pct < thresholdPct
  );

  if (lowMargin.length === 0) {
    log.info("No low-margin projects detected");
    return [];
  }

  log.warn({ count: lowMargin.length, thresholdPct }, "Low-margin projects detected");

  const alertLines = lowMargin.slice(0, 8).map(
    (m, i) =>
      `${i + 1}. *${m.project_name}* (${m.client_name}) — Margem: ${m.margin_pct}% | Receita: R$ ${m.total_revenue.toLocaleString("pt-BR")} | Custo: R$ ${m.total_costs.toLocaleString("pt-BR")}`
  );

  const message = [
    `*ALERTA: ${lowMargin.length} projetos com margem abaixo de ${thresholdPct}%*`,
    ``,
    ...alertLines,
    ``,
    `Acao: revisar custos e renegociar se necessario.`,
  ].join("\n");

  try {
    await sendSlackMessage({
      text: `Margin Alert: ${lowMargin.length} projects below ${thresholdPct}%`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `Alerta de Margem` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: alertLines.join("\n") },
        },
      ],
    });
  } catch (err) {
    log.error({ err }, "Failed to send margin alert to Slack");
  }

  const opsGroup = process.env.WHATSAPP_OPS_GROUP;
  if (opsGroup) {
    try {
      await sendGroupMessage(opsGroup, message);
    } catch (err) {
      log.error({ err }, "Failed to send margin alert to WhatsApp");
    }
  }

  return lowMargin;
}

// ─── Cash Flow ──────────────────────────────────────

/**
 * Generate cash flow projection for the next N months.
 * Based on receivables (due dates) and payables (due dates).
 */
export async function generateCashFlow(months: number = 6): Promise<CashFlowEntry[]> {
  const entries: CashFlowEntry[] = [];
  const today = new Date();
  let cumulative = 0;

  // Get current balance (paid receivables - paid payables to date)
  const balance = await db
    .selectFrom("financial_transactions")
    .select([
      sql<number>`COALESCE(SUM(CASE WHEN type = 'receivable' THEN net_value ELSE 0 END), 0)`.as("total_received"),
      sql<number>`COALESCE(SUM(CASE WHEN type = 'payable' THEN net_value ELSE 0 END), 0)`.as("total_paid"),
    ])
    .where("status", "=", "paid")
    .executeTakeFirst();

  cumulative = Number(balance?.total_received ?? 0) - Number(balance?.total_paid ?? 0);

  for (let i = 0; i < months; i++) {
    const periodStart = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const periodEnd = new Date(today.getFullYear(), today.getMonth() + i + 1, 0);
    const period = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, "0")}`;

    // Receivables due this month
    const receivables = await db
      .selectFrom("financial_transactions")
      .select([
        db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
        sql<number>`COALESCE(SUM(CASE WHEN status = 'paid' THEN net_value ELSE 0 END), 0)`.as("received"),
      ])
      .where("type", "=", "receivable")
      .where("due_at", ">=", periodStart)
      .where("due_at", "<=", periodEnd)
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    // Payables due this month
    const payables = await db
      .selectFrom("financial_transactions")
      .select([
        db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
        sql<number>`COALESCE(SUM(CASE WHEN status = 'paid' THEN net_value ELSE 0 END), 0)`.as("paid"),
      ])
      .where("type", "=", "payable")
      .where("due_at", ">=", periodStart)
      .where("due_at", "<=", periodEnd)
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    const receivableTotal = Number(receivables?.total ?? 0);
    const receivableReceived = Number(receivables?.received ?? 0);
    const payableTotal = Number(payables?.total ?? 0);
    const payablePaid = Number(payables?.paid ?? 0);
    const netFlow = receivableTotal - payableTotal;
    cumulative += netFlow;

    entries.push({
      period,
      receivable_total: receivableTotal,
      receivable_received: receivableReceived,
      payable_total: payableTotal,
      payable_paid: payablePaid,
      net_flow: netFlow,
      cumulative: Math.round(cumulative * 100) / 100,
    });
  }

  log.info({ months, entries: entries.length }, "Cash flow generated");
  return entries;
}

// ─── Monthly P&L ────────────────────────────────────

/**
 * Generate monthly P&L for the last N months.
 */
export async function generateMonthlyPnL(months: number = 12): Promise<MonthlyPnL[]> {
  const results: MonthlyPnL[] = [];
  const today = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const periodStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const periodEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
    const month = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, "0")}`;

    // Revenue (receivable transactions)
    const rev = await db
      .selectFrom("financial_transactions")
      .select([
        db.fn.coalesce(db.fn.sum("gross_value"), sql.lit(0)).as("gross"),
        db.fn.coalesce(db.fn.sum("tax_value"), sql.lit(0)).as("taxes"),
        db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("net"),
      ])
      .where("type", "=", "receivable")
      .where("issued_at", ">=", periodStart)
      .where("issued_at", "<=", periodEnd)
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    // Costs (payable transactions)
    const costs = await db
      .selectFrom("financial_transactions")
      .select([
        db.fn.coalesce(db.fn.sum("net_value"), sql.lit(0)).as("total"),
        sql<number>`COALESCE(SUM(CASE WHEN category = 'material' THEN net_value ELSE 0 END), 0)`.as("material"),
        sql<number>`COALESCE(SUM(CASE WHEN category = 'labor' THEN net_value ELSE 0 END), 0)`.as("labor"),
      ])
      .where("type", "=", "payable")
      .where("issued_at", ">=", periodStart)
      .where("issued_at", "<=", periodEnd)
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    const grossRevenue = Number(rev?.gross ?? 0);
    const taxes = Number(rev?.taxes ?? 0);
    const netRevenue = Number(rev?.net ?? 0);
    const materialCosts = Number(costs?.material ?? 0);
    const laborCosts = Number(costs?.labor ?? 0);
    const totalCosts = Number(costs?.total ?? 0);
    const overhead = totalCosts - materialCosts - laborCosts;
    const grossProfit = netRevenue - totalCosts;
    const grossMarginPct =
      netRevenue > 0 ? Math.round((grossProfit / netRevenue) * 1000) / 10 : 0;

    results.push({
      month,
      gross_revenue: grossRevenue,
      taxes,
      net_revenue: netRevenue,
      material_costs: materialCosts,
      labor_costs: laborCosts,
      overhead,
      total_costs: totalCosts,
      gross_profit: grossProfit,
      gross_margin_pct: grossMarginPct,
    });
  }

  log.info({ months: results.length }, "Monthly P&L generated");
  return results;
}
