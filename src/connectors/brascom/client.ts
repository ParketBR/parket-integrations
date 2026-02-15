import axios from "axios";
import axiosRetry from "axios-retry";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:brascom");

// ─── Brascom ERP Client ─────────────────────────────
// Conector para o ERP Brascom (financeiro + estoque)
// Suporta polling via API REST ou importacao de CSV/XML

export interface BrascomConfig {
  baseUrl: string;
  apiKey: string;
  companyId: string;
}

function createClient(config: BrascomConfig) {
  const client = axios.create({
    baseURL: config.baseUrl,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "X-Company-Id": config.companyId,
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) =>
      axiosRetry.isNetworkOrIdempotentRequestError(err) ||
      err.response?.status === 429,
  });

  return client;
}

// ─── Types ──────────────────────────────────────────

export interface BrascomInvoice {
  id: string;
  number: string;
  type: "receivable" | "payable";
  customer_id: string | null;
  supplier_id: string | null;
  description: string;
  gross_value: number;
  tax_value: number;
  net_value: number;
  cost_center: string | null;
  category: string | null;
  issued_at: string;
  due_at: string;
  paid_at: string | null;
  status: "open" | "paid" | "overdue" | "cancelled";
}

export interface BrascomPayment {
  id: string;
  invoice_id: string;
  amount: number;
  method: "pix" | "boleto" | "transfer" | "credit_card" | "cash";
  paid_at: string;
  bank_account: string | null;
}

export interface BrascomCostCenter {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
}

export interface BrascomStockItem {
  sku: string;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  avg_cost: number;
  last_purchase_price: number;
  min_stock: number;
}

// ─── API Functions ──────────────────────────────────

let _client: ReturnType<typeof createClient> | null = null;

function getClient(): ReturnType<typeof createClient> {
  if (!_client) {
    const baseUrl = process.env.BRASCOM_API_URL;
    const apiKey = process.env.BRASCOM_API_KEY;
    const companyId = process.env.BRASCOM_COMPANY_ID;

    if (!baseUrl || !apiKey || !companyId) {
      throw new Error("Brascom credentials not configured (BRASCOM_API_URL, BRASCOM_API_KEY, BRASCOM_COMPANY_ID)");
    }

    _client = createClient({ baseUrl, apiKey, companyId });
  }
  return _client;
}

/**
 * Fetch invoices (receivable + payable) for a date range.
 */
export async function fetchInvoices(
  startDate: string,
  endDate: string,
  type?: "receivable" | "payable"
): Promise<BrascomInvoice[]> {
  const client = getClient();
  const allInvoices: BrascomInvoice[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await client.get<{
      data: BrascomInvoice[];
      meta: { total: number; page: number; per_page: number };
    }>("/invoices", {
      params: {
        start_date: startDate,
        end_date: endDate,
        type,
        page,
        per_page: perPage,
      },
    });

    allInvoices.push(...data.data);

    if (allInvoices.length >= data.meta.total || data.data.length < perPage) {
      break;
    }
    page++;
  }

  log.info(
    { count: allInvoices.length, startDate, endDate, type },
    "Fetched invoices from Brascom"
  );

  return allInvoices;
}

/**
 * Fetch payments for a date range.
 */
export async function fetchPayments(
  startDate: string,
  endDate: string
): Promise<BrascomPayment[]> {
  const client = getClient();
  const { data } = await client.get<{ data: BrascomPayment[] }>("/payments", {
    params: { start_date: startDate, end_date: endDate, per_page: 500 },
  });

  log.info({ count: data.data.length }, "Fetched payments from Brascom");
  return data.data;
}

/**
 * Fetch cost centers.
 */
export async function fetchCostCenters(): Promise<BrascomCostCenter[]> {
  const client = getClient();
  const { data } = await client.get<{ data: BrascomCostCenter[] }>("/cost-centers");
  return data.data;
}

/**
 * Fetch current stock levels.
 */
export async function fetchStock(): Promise<BrascomStockItem[]> {
  const client = getClient();
  const { data } = await client.get<{ data: BrascomStockItem[] }>("/stock", {
    params: { per_page: 1000 },
  });

  log.info({ count: data.data.length }, "Fetched stock from Brascom");
  return data.data;
}

// ─── CSV Import (fallback if no API) ────────────────

export interface CsvInvoiceRow {
  numero: string;
  tipo: string;
  descricao: string;
  valor_bruto: string;
  impostos: string;
  valor_liquido: string;
  centro_custo: string;
  categoria: string;
  emissao: string;
  vencimento: string;
  pagamento: string;
  status: string;
}

/**
 * Parse CSV invoice rows into BrascomInvoice format.
 * Use when ERP doesn't have API and exports CSV.
 */
export function parseCsvInvoices(rows: CsvInvoiceRow[]): BrascomInvoice[] {
  return rows.map((row, idx) => ({
    id: `csv_${idx}_${row.numero}`,
    number: row.numero,
    type: row.tipo === "receber" ? "receivable" as const : "payable" as const,
    customer_id: null,
    supplier_id: null,
    description: row.descricao,
    gross_value: parseFloat(row.valor_bruto.replace(",", ".")) || 0,
    tax_value: parseFloat(row.impostos.replace(",", ".")) || 0,
    net_value: parseFloat(row.valor_liquido.replace(",", ".")) || 0,
    cost_center: row.centro_custo || null,
    category: row.categoria || null,
    issued_at: parseBrDate(row.emissao),
    due_at: parseBrDate(row.vencimento),
    paid_at: row.pagamento ? parseBrDate(row.pagamento) : null,
    status: mapCsvStatus(row.status),
  }));
}

function parseBrDate(dateStr: string): string {
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  }
  return dateStr;
}

function mapCsvStatus(status: string): BrascomInvoice["status"] {
  const s = status.toLowerCase().trim();
  if (s === "pago" || s === "quitado") return "paid";
  if (s === "vencido" || s === "atrasado") return "overdue";
  if (s === "cancelado") return "cancelled";
  return "open";
}
