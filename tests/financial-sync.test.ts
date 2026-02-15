import { describe, it, expect } from "vitest";

// ─── Financial Sync Logic Tests ─────────────────────
// Testing overdue detection and payment matching logic

interface Transaction {
  id: string;
  type: "receivable" | "payable";
  net_value: number;
  due_at: Date;
  paid_at: Date | null;
  status: "open" | "paid" | "overdue" | "cancelled";
}

function detectOverdue(transactions: Transaction[], now: Date): Transaction[] {
  return transactions
    .filter((t) => t.status === "open" && t.due_at < now)
    .map((t) => ({ ...t, status: "overdue" as const }));
}

function matchPaymentsToTransactions(
  transactions: Transaction[],
  paymentInvoiceIds: string[]
): Transaction[] {
  return transactions.map((t) => {
    if (paymentInvoiceIds.includes(t.id) && t.status !== "paid") {
      return { ...t, status: "paid" as const, paid_at: new Date() };
    }
    return t;
  });
}

function calculateTotals(transactions: Transaction[]) {
  const receivable = transactions
    .filter((t) => t.type === "receivable" && t.status !== "cancelled")
    .reduce((sum, t) => sum + t.net_value, 0);

  const payable = transactions
    .filter((t) => t.type === "payable" && t.status !== "cancelled")
    .reduce((sum, t) => sum + t.net_value, 0);

  const overdue = transactions
    .filter((t) => t.status === "overdue")
    .reduce((sum, t) => sum + t.net_value, 0);

  const paid = transactions
    .filter((t) => t.status === "paid")
    .reduce((sum, t) => sum + t.net_value, 0);

  return { receivable, payable, overdue, paid, balance: receivable - payable };
}

describe("Financial Sync — Overdue Detection", () => {
  const now = new Date("2026-02-14");

  it("should detect overdue open transactions", () => {
    const transactions: Transaction[] = [
      { id: "1", type: "receivable", net_value: 10_000, due_at: new Date("2026-02-01"), paid_at: null, status: "open" },
      { id: "2", type: "receivable", net_value: 20_000, due_at: new Date("2026-03-01"), paid_at: null, status: "open" },
      { id: "3", type: "payable", net_value: 5_000, due_at: new Date("2026-01-15"), paid_at: null, status: "open" },
    ];

    const overdue = detectOverdue(transactions, now);
    expect(overdue).toHaveLength(2); // id 1 and 3 are past due
    expect(overdue.every((t) => t.status === "overdue")).toBe(true);
  });

  it("should not flag already paid transactions as overdue", () => {
    const transactions: Transaction[] = [
      { id: "1", type: "receivable", net_value: 10_000, due_at: new Date("2026-01-01"), paid_at: new Date("2026-01-05"), status: "paid" },
    ];

    const overdue = detectOverdue(transactions, now);
    expect(overdue).toHaveLength(0);
  });

  it("should not flag cancelled transactions as overdue", () => {
    const transactions: Transaction[] = [
      { id: "1", type: "receivable", net_value: 10_000, due_at: new Date("2026-01-01"), paid_at: null, status: "cancelled" },
    ];

    const overdue = detectOverdue(transactions, now);
    expect(overdue).toHaveLength(0);
  });

  it("should not flag future due dates as overdue", () => {
    const transactions: Transaction[] = [
      { id: "1", type: "receivable", net_value: 10_000, due_at: new Date("2026-12-31"), paid_at: null, status: "open" },
    ];

    const overdue = detectOverdue(transactions, now);
    expect(overdue).toHaveLength(0);
  });
});

describe("Financial Sync — Payment Matching", () => {
  it("should match payments to transactions", () => {
    const transactions: Transaction[] = [
      { id: "inv-1", type: "receivable", net_value: 15_000, due_at: new Date("2026-02-01"), paid_at: null, status: "open" },
      { id: "inv-2", type: "receivable", net_value: 25_000, due_at: new Date("2026-03-01"), paid_at: null, status: "open" },
    ];

    const result = matchPaymentsToTransactions(transactions, ["inv-1"]);
    expect(result[0].status).toBe("paid");
    expect(result[0].paid_at).not.toBeNull();
    expect(result[1].status).toBe("open");
  });

  it("should not double-pay already paid transactions", () => {
    const transactions: Transaction[] = [
      { id: "inv-1", type: "receivable", net_value: 15_000, due_at: new Date("2026-02-01"), paid_at: new Date("2026-01-30"), status: "paid" },
    ];

    const result = matchPaymentsToTransactions(transactions, ["inv-1"]);
    expect(result[0].status).toBe("paid");
  });
});

describe("Financial Sync — Totals Calculation", () => {
  const transactions: Transaction[] = [
    { id: "1", type: "receivable", net_value: 50_000, due_at: new Date(), paid_at: new Date(), status: "paid" },
    { id: "2", type: "receivable", net_value: 30_000, due_at: new Date(), paid_at: null, status: "open" },
    { id: "3", type: "receivable", net_value: 10_000, due_at: new Date(), paid_at: null, status: "overdue" },
    { id: "4", type: "payable", net_value: 20_000, due_at: new Date(), paid_at: new Date(), status: "paid" },
    { id: "5", type: "payable", net_value: 15_000, due_at: new Date(), paid_at: null, status: "open" },
    { id: "6", type: "receivable", net_value: 5_000, due_at: new Date(), paid_at: null, status: "cancelled" },
  ];

  it("should calculate total receivable (excluding cancelled)", () => {
    const totals = calculateTotals(transactions);
    expect(totals.receivable).toBe(90_000); // 50k + 30k + 10k
  });

  it("should calculate total payable (excluding cancelled)", () => {
    const totals = calculateTotals(transactions);
    expect(totals.payable).toBe(35_000); // 20k + 15k
  });

  it("should calculate overdue total", () => {
    const totals = calculateTotals(transactions);
    expect(totals.overdue).toBe(10_000);
  });

  it("should calculate paid total", () => {
    const totals = calculateTotals(transactions);
    expect(totals.paid).toBe(70_000); // 50k + 20k
  });

  it("should calculate balance", () => {
    const totals = calculateTotals(transactions);
    expect(totals.balance).toBe(55_000); // 90k - 35k
  });
});
