import { describe, it, expect } from "vitest";

// ─── Margin Calculation Logic Tests ─────────────────
// Testing pure business logic without DB

interface MarginInput {
  contract_value: number;
  revenue: number;
  material_cost: number;
  labor_cost: number;
  overhead: number;
}

function calculateMargin(input: MarginInput) {
  const totalCosts = input.material_cost + input.labor_cost + input.overhead;
  const grossMargin = input.revenue - totalCosts;
  const marginPct =
    input.revenue > 0
      ? Math.round((grossMargin / input.revenue) * 1000) / 10
      : 0;

  return {
    total_costs: totalCosts,
    gross_margin: grossMargin,
    margin_pct: marginPct,
    is_healthy: marginPct >= 25,
    cost_breakdown: {
      material_pct:
        totalCosts > 0
          ? Math.round((input.material_cost / totalCosts) * 1000) / 10
          : 0,
      labor_pct:
        totalCosts > 0
          ? Math.round((input.labor_cost / totalCosts) * 1000) / 10
          : 0,
      overhead_pct:
        totalCosts > 0
          ? Math.round((input.overhead / totalCosts) * 1000) / 10
          : 0,
    },
  };
}

describe("Margin Analysis — Business Logic", () => {
  it("should calculate healthy margin for premium project", () => {
    const result = calculateMargin({
      contract_value: 100_000,
      revenue: 100_000,
      material_cost: 40_000,
      labor_cost: 20_000,
      overhead: 5_000,
    });

    expect(result.gross_margin).toBe(35_000);
    expect(result.margin_pct).toBe(35);
    expect(result.is_healthy).toBe(true);
  });

  it("should flag low-margin project", () => {
    const result = calculateMargin({
      contract_value: 50_000,
      revenue: 50_000,
      material_cost: 25_000,
      labor_cost: 15_000,
      overhead: 3_000,
    });

    expect(result.margin_pct).toBe(14);
    expect(result.is_healthy).toBe(false);
  });

  it("should handle zero revenue", () => {
    const result = calculateMargin({
      contract_value: 80_000,
      revenue: 0,
      material_cost: 10_000,
      labor_cost: 5_000,
      overhead: 1_000,
    });

    expect(result.margin_pct).toBe(0);
    expect(result.gross_margin).toBe(-16_000);
  });

  it("should handle negative margin (cost overrun)", () => {
    const result = calculateMargin({
      contract_value: 60_000,
      revenue: 60_000,
      material_cost: 35_000,
      labor_cost: 25_000,
      overhead: 8_000,
    });

    expect(result.gross_margin).toBe(-8_000);
    expect(result.margin_pct).toBe(-13.3);
    expect(result.is_healthy).toBe(false);
  });

  it("should calculate correct cost breakdown percentages", () => {
    const result = calculateMargin({
      contract_value: 100_000,
      revenue: 100_000,
      material_cost: 30_000,
      labor_cost: 20_000,
      overhead: 10_000,
    });

    expect(result.cost_breakdown.material_pct).toBe(50);
    expect(result.cost_breakdown.labor_pct).toBeCloseTo(33.3, 0);
    expect(result.cost_breakdown.overhead_pct).toBeCloseTo(16.7, 0);
  });

  it("should detect Parket ideal margin range (30-40%)", () => {
    // Parket premium positioning requires healthy margins
    const scenarios = [
      { revenue: 100_000, costs: 60_000, expected_healthy: true },   // 40%
      { revenue: 100_000, costs: 70_000, expected_healthy: true },   // 30%
      { revenue: 100_000, costs: 75_000, expected_healthy: true },   // 25% borderline
      { revenue: 100_000, costs: 80_000, expected_healthy: false },  // 20%
    ];

    for (const s of scenarios) {
      const result = calculateMargin({
        contract_value: s.revenue,
        revenue: s.revenue,
        material_cost: s.costs * 0.6,
        labor_cost: s.costs * 0.3,
        overhead: s.costs * 0.1,
      });
      expect(result.is_healthy).toBe(s.expected_healthy);
    }
  });
});

describe("Margin Analysis — Cash Flow Logic", () => {
  interface CashFlowInput {
    receivable: number;
    received: number;
    payable: number;
    paid: number;
  }

  function calculateNetFlow(input: CashFlowInput) {
    return {
      net_flow: input.receivable - input.payable,
      collection_rate:
        input.receivable > 0
          ? Math.round((input.received / input.receivable) * 1000) / 10
          : 0,
      payment_rate:
        input.payable > 0
          ? Math.round((input.paid / input.payable) * 1000) / 10
          : 0,
      cash_gap: input.received - input.paid,
    };
  }

  it("should calculate positive net flow", () => {
    const result = calculateNetFlow({
      receivable: 200_000,
      received: 150_000,
      payable: 120_000,
      paid: 100_000,
    });

    expect(result.net_flow).toBe(80_000);
    expect(result.cash_gap).toBe(50_000);
    expect(result.collection_rate).toBe(75);
  });

  it("should detect negative cash gap", () => {
    const result = calculateNetFlow({
      receivable: 100_000,
      received: 30_000,
      payable: 80_000,
      paid: 70_000,
    });

    expect(result.cash_gap).toBe(-40_000);
  });

  it("should handle all zeros", () => {
    const result = calculateNetFlow({
      receivable: 0,
      received: 0,
      payable: 0,
      paid: 0,
    });

    expect(result.net_flow).toBe(0);
    expect(result.collection_rate).toBe(0);
    expect(result.payment_rate).toBe(0);
  });
});
