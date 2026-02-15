import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import {
  fetchInvoices,
  fetchPayments,
  parseCsvInvoices,
  type BrascomInvoice,
  type BrascomPayment,
  type CsvInvoiceRow,
} from "../connectors/brascom/client.js";

const log = createChildLogger("service:financial-sync");

// ─── Invoice Sync ───────────────────────────────────

/**
 * Sync invoices from Brascom ERP to local DB.
 * Upserts by external erp_invoice_id to avoid duplicates.
 */
export async function syncInvoices(
  startDate: string,
  endDate: string
): Promise<{ created: number; updated: number }> {
  const invoices = await fetchInvoices(startDate, endDate);
  return upsertInvoices(invoices);
}

/**
 * Import invoices from CSV (when API not available).
 */
export async function importInvoicesFromCsv(
  rows: CsvInvoiceRow[]
): Promise<{ created: number; updated: number }> {
  const invoices = parseCsvInvoices(rows);
  return upsertInvoices(invoices);
}

async function upsertInvoices(
  invoices: BrascomInvoice[]
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const inv of invoices) {
    // Try to link to a project by matching invoice description or customer
    const projectId = await findProjectForInvoice(inv);

    const result = await db
      .insertInto("financial_transactions")
      .values({
        erp_invoice_id: inv.id,
        type: inv.type,
        description: inv.description,
        gross_value: inv.gross_value,
        tax_value: inv.tax_value,
        net_value: inv.net_value,
        cost_center: inv.cost_center,
        category: inv.category,
        issued_at: new Date(inv.issued_at),
        due_at: new Date(inv.due_at),
        paid_at: inv.paid_at ? new Date(inv.paid_at) : null,
        status: inv.status,
        project_id: projectId,
      })
      .onConflict((oc) =>
        oc.column("erp_invoice_id").doUpdateSet({
          gross_value: inv.gross_value,
          tax_value: inv.tax_value,
          net_value: inv.net_value,
          status: inv.status,
          paid_at: inv.paid_at ? new Date(inv.paid_at) : null,
          updated_at: new Date(),
        })
      )
      .executeTakeFirst();

    if (result.numInsertedOrUpdatedRows === 1n) {
      // Check if it was an insert or update
      const existing = await db
        .selectFrom("financial_transactions")
        .select("created_at")
        .where("erp_invoice_id", "=", inv.id)
        .executeTakeFirst();

      if (
        existing &&
        new Date(existing.created_at).getTime() > Date.now() - 5000
      ) {
        created++;
      } else {
        updated++;
      }
    }
  }

  log.info({ created, updated, total: invoices.length }, "Invoices synced");
  return { created, updated };
}

/**
 * Sync payments from ERP.
 */
export async function syncPayments(
  startDate: string,
  endDate: string
): Promise<number> {
  const payments = await fetchPayments(startDate, endDate);
  let synced = 0;

  for (const pay of payments) {
    await db
      .insertInto("financial_payments")
      .values({
        erp_payment_id: pay.id,
        erp_invoice_id: pay.invoice_id,
        amount: pay.amount,
        method: pay.method,
        paid_at: new Date(pay.paid_at),
        bank_account: pay.bank_account,
      })
      .onConflict((oc) =>
        oc.column("erp_payment_id").doUpdateSet({
          amount: pay.amount,
          method: pay.method,
        })
      )
      .execute();
    synced++;
  }

  // Update related transaction statuses
  await db
    .updateTable("financial_transactions")
    .set({ status: "paid", paid_at: new Date() })
    .where(
      "erp_invoice_id",
      "in",
      payments.map((p) => p.invoice_id)
    )
    .where("status", "!=", "paid")
    .execute();

  log.info({ synced }, "Payments synced");
  return synced;
}

// ─── Helpers ────────────────────────────────────────

/**
 * Try to match an invoice to a project by looking for
 * project name/client in the description.
 */
async function findProjectForInvoice(
  inv: BrascomInvoice
): Promise<string | null> {
  if (!inv.description) return null;

  // Search projects by partial name match
  const desc = inv.description.toLowerCase();

  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "client_name"])
    .where("status", "!=", "cancelado")
    .execute();

  for (const p of projects) {
    if (
      desc.includes(p.name.toLowerCase()) ||
      desc.includes(p.client_name.toLowerCase())
    ) {
      return p.id;
    }
  }

  return null;
}

/**
 * Mark overdue invoices based on due_at < today and status = open.
 */
export async function markOverdueInvoices(): Promise<number> {
  const result = await db
    .updateTable("financial_transactions")
    .set({ status: "overdue" })
    .where("status", "=", "open")
    .where("due_at", "<", new Date())
    .executeTakeFirst();

  const count = Number(result.numUpdatedRows);
  if (count > 0) {
    log.warn({ count }, "Invoices marked as overdue");
  }
  return count;
}
