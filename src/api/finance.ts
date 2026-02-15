import { Router, Request, Response } from "express";
import { createChildLogger } from "../config/logger.js";
import { syncInvoices, syncPayments, markOverdueInvoices } from "../services/financial-sync.js";
import {
  calculateProjectMargins,
  detectLowMarginProjects,
  generateCashFlow,
  generateMonthlyPnL,
} from "../services/margin-analysis.js";
import {
  calculateMonthlyCac,
  calculateCacBySource,
  generateExecutiveScoreboard,
  sendScoreboardAlert,
} from "../services/cac-calculator.js";
import { db } from "../db/connection.js";

const log = createChildLogger("api:finance");

export const financeRouter = Router();

// ── Sync ──────────────────────────────────────────

/**
 * POST /api/finance/sync
 * Trigger ERP sync for a date range.
 */
financeRouter.post("/sync", async (req: Request, res: Response) => {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date required" });
    }

    const invoiceResult = await syncInvoices(start_date, end_date);
    const paymentCount = await syncPayments(start_date, end_date);
    const overdueCount = await markOverdueInvoices();

    res.json({
      status: "ok",
      invoices: invoiceResult,
      payments_synced: paymentCount,
      overdue_marked: overdueCount,
    });
  } catch (err) {
    log.error({ err }, "Finance sync failed");
    res.status(500).json({ error: "Sync failed" });
  }
});

// ── Transactions ──────────────────────────────────

/**
 * GET /api/finance/transactions
 * List financial transactions with filters.
 */
financeRouter.get("/transactions", async (req: Request, res: Response) => {
  try {
    const {
      type,
      status,
      project_id,
      start_date,
      end_date,
      limit = "50",
      offset = "0",
    } = req.query;

    let query = db
      .selectFrom("financial_transactions")
      .selectAll()
      .orderBy("issued_at", "desc")
      .limit(Number(limit))
      .offset(Number(offset));

    if (type) query = query.where("type", "=", type as any);
    if (status) query = query.where("status", "=", status as any);
    if (project_id) query = query.where("project_id", "=", project_id as string);
    if (start_date) query = query.where("issued_at", ">=", new Date(start_date as string));
    if (end_date) query = query.where("issued_at", "<=", new Date(end_date as string));

    const transactions = await query.execute();
    res.json({ data: transactions, count: transactions.length });
  } catch (err) {
    log.error({ err }, "Failed to list transactions");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Margins ───────────────────────────────────────

/**
 * GET /api/finance/margins
 * Project margins analysis.
 */
financeRouter.get("/margins", async (_req: Request, res: Response) => {
  try {
    const margins = await calculateProjectMargins();
    const avgMargin =
      margins.length > 0
        ? Math.round(
            (margins.reduce((sum, m) => sum + m.margin_pct, 0) / margins.length) * 10
          ) / 10
        : 0;

    res.json({
      data: margins,
      summary: {
        project_count: margins.length,
        avg_margin_pct: avgMargin,
        low_margin_count: margins.filter((m) => m.margin_pct < 25).length,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to calculate margins");
    res.status(500).json({ error: "Internal error" });
  }
});

/**
 * POST /api/finance/margins/alert
 * Trigger low-margin alert manually.
 */
financeRouter.post("/margins/alert", async (req: Request, res: Response) => {
  try {
    const threshold = Number(req.body.threshold_pct ?? 25);
    const lowMargin = await detectLowMarginProjects(threshold);
    res.json({ alerted: lowMargin.length, projects: lowMargin });
  } catch (err) {
    log.error({ err }, "Margin alert failed");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Cash Flow ─────────────────────────────────────

/**
 * GET /api/finance/cashflow
 * Cash flow projection.
 */
financeRouter.get("/cashflow", async (req: Request, res: Response) => {
  try {
    const months = Number(req.query.months ?? 6);
    const cashflow = await generateCashFlow(months);
    res.json({ data: cashflow });
  } catch (err) {
    log.error({ err }, "Failed to generate cash flow");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── P&L ───────────────────────────────────────────

/**
 * GET /api/finance/pnl
 * Monthly P&L.
 */
financeRouter.get("/pnl", async (req: Request, res: Response) => {
  try {
    const months = Number(req.query.months ?? 12);
    const pnl = await generateMonthlyPnL(months);

    const totals = pnl.reduce(
      (acc, m) => {
        acc.revenue += m.net_revenue;
        acc.costs += m.total_costs;
        acc.profit += m.gross_profit;
        return acc;
      },
      { revenue: 0, costs: 0, profit: 0 }
    );

    res.json({
      data: pnl,
      totals: {
        ...totals,
        margin_pct:
          totals.revenue > 0
            ? Math.round((totals.profit / totals.revenue) * 1000) / 10
            : 0,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to generate P&L");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── CAC ───────────────────────────────────────────

/**
 * GET /api/finance/cac
 * Monthly CAC.
 */
financeRouter.get("/cac", async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const year = Number(req.query.year ?? now.getFullYear());
    const month = Number(req.query.month ?? now.getMonth() + 1);

    const cac = await calculateMonthlyCac(year, month);
    const bySource = await calculateCacBySource(year, month);

    res.json({ cac, by_source: bySource });
  } catch (err) {
    log.error({ err }, "Failed to calculate CAC");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Executive Scoreboard ──────────────────────────

/**
 * GET /api/finance/scoreboard
 * Executive scoreboard with all KPIs.
 */
financeRouter.get("/scoreboard", async (req: Request, res: Response) => {
  try {
    const target = Number(req.query.revenue_target ?? 500_000);
    const scoreboard = await generateExecutiveScoreboard(target);
    res.json(scoreboard);
  } catch (err) {
    log.error({ err }, "Failed to generate scoreboard");
    res.status(500).json({ error: "Internal error" });
  }
});

/**
 * POST /api/finance/scoreboard/send
 * Send scoreboard to Slack.
 */
financeRouter.post("/scoreboard/send", async (req: Request, res: Response) => {
  try {
    const target = Number(req.body.revenue_target ?? 500_000);
    const scoreboard = await generateExecutiveScoreboard(target);
    await sendScoreboardAlert(scoreboard);
    res.json({ status: "sent", scoreboard });
  } catch (err) {
    log.error({ err }, "Failed to send scoreboard");
    res.status(500).json({ error: "Internal error" });
  }
});
