import { describe, it, expect } from "vitest";

// ─── CAC & Scoreboard Logic Tests ───────────────────
// Testing pure business logic without DB

interface CacInput {
  marketing_spend: number;
  sales_spend: number;
  new_customers: number;
  avg_ticket: number;
}

function calculateCac(input: CacInput) {
  const totalSpend = input.marketing_spend + input.sales_spend;
  const cac = input.new_customers > 0 ? Math.round(totalSpend / input.new_customers) : 0;
  const ltvEstimate = input.avg_ticket * 1.3; // 30% repeat factor
  const ltvCacRatio = cac > 0 ? Math.round((ltvEstimate / cac) * 10) / 10 : 0;

  return {
    total_spend: totalSpend,
    cac,
    ltv_estimate: Math.round(ltvEstimate),
    ltv_cac_ratio: ltvCacRatio,
    is_healthy: ltvCacRatio >= 3,
  };
}

interface CacBySourceInput {
  source: string;
  total_spend: number;
  total_leads: number;
  leads: number;
  customers: number;
}

function calculateSourceCac(input: CacBySourceInput) {
  const proportionalSpend =
    input.total_leads > 0
      ? Math.round((input.total_spend * input.leads) / input.total_leads)
      : 0;
  const cac =
    input.customers > 0 ? Math.round(proportionalSpend / input.customers) : 0;
  const cpl =
    input.leads > 0 ? Math.round(proportionalSpend / input.leads) : 0;
  const convRate =
    input.leads > 0
      ? Math.round((input.customers / input.leads) * 1000) / 10
      : 0;

  return {
    source: input.source,
    spend: proportionalSpend,
    cac,
    cost_per_lead: cpl,
    conversion_rate: convRate,
  };
}

describe("CAC Calculator — Business Logic", () => {
  it("should calculate CAC correctly", () => {
    const result = calculateCac({
      marketing_spend: 15_000,
      sales_spend: 5_000,
      new_customers: 4,
      avg_ticket: 60_000,
    });

    expect(result.cac).toBe(5_000);
    expect(result.total_spend).toBe(20_000);
    expect(result.ltv_estimate).toBe(78_000); // 60k * 1.3
    expect(result.ltv_cac_ratio).toBe(15.6);
    expect(result.is_healthy).toBe(true);
  });

  it("should handle zero customers", () => {
    const result = calculateCac({
      marketing_spend: 10_000,
      sales_spend: 3_000,
      new_customers: 0,
      avg_ticket: 50_000,
    });

    expect(result.cac).toBe(0);
    expect(result.ltv_cac_ratio).toBe(0);
    expect(result.is_healthy).toBe(false);
  });

  it("should flag unhealthy LTV/CAC ratio", () => {
    // High CAC scenario: too much spend per customer
    const result = calculateCac({
      marketing_spend: 50_000,
      sales_spend: 20_000,
      new_customers: 2,
      avg_ticket: 30_000,
    });

    expect(result.cac).toBe(35_000);
    expect(result.ltv_cac_ratio).toBe(1.1);
    expect(result.is_healthy).toBe(false);
  });

  it("should consider 30% repeat factor in LTV", () => {
    const result = calculateCac({
      marketing_spend: 10_000,
      sales_spend: 0,
      new_customers: 1,
      avg_ticket: 100_000,
    });

    // LTV = 100k * 1.3 = 130k
    expect(result.ltv_estimate).toBe(130_000);
    expect(result.ltv_cac_ratio).toBe(13);
  });
});

describe("CAC by Source", () => {
  it("should calculate proportional spend by source", () => {
    const result = calculateSourceCac({
      source: "meta_ads",
      total_spend: 20_000,
      total_leads: 100,
      leads: 40, // 40% of leads from Meta
      customers: 8,
    });

    // 40% of 20k = 8k spend
    expect(result.spend).toBe(8_000);
    expect(result.cac).toBe(1_000);
    expect(result.cost_per_lead).toBe(200);
    expect(result.conversion_rate).toBe(20);
  });

  it("should handle source with no customers", () => {
    const result = calculateSourceCac({
      source: "google_ads",
      total_spend: 10_000,
      total_leads: 50,
      leads: 15,
      customers: 0,
    });

    expect(result.cac).toBe(0);
    expect(result.conversion_rate).toBe(0);
    expect(result.cost_per_lead).toBe(200);
  });

  it("should compare efficiency across sources", () => {
    const meta = calculateSourceCac({
      source: "meta_ads",
      total_spend: 30_000,
      total_leads: 100,
      leads: 50,
      customers: 5,
    });

    const referral = calculateSourceCac({
      source: "referral",
      total_spend: 30_000,
      total_leads: 100,
      leads: 10,
      customers: 4,
    });

    const whatsapp = calculateSourceCac({
      source: "whatsapp",
      total_spend: 30_000,
      total_leads: 100,
      leads: 20,
      customers: 6,
    });

    // Meta: 15k spend / 5 customers = 3k CAC
    expect(meta.cac).toBe(3_000);

    // Referral: 3k spend / 4 customers = 750 CAC (best!)
    expect(referral.cac).toBe(750);

    // WhatsApp: 6k spend / 6 customers = 1k CAC
    expect(whatsapp.cac).toBe(1_000);

    // Referral has highest conversion rate
    expect(referral.conversion_rate).toBe(40);
    expect(meta.conversion_rate).toBe(10);
  });
});

describe("Executive Scoreboard — KPI Logic", () => {
  const STAGE_PROBABILITIES: Record<string, number> = {
    triagem: 0.05,
    qualificado: 0.15,
    reuniao: 0.30,
    proposta: 0.50,
    negociacao: 0.75,
  };

  function weightedPipeline(
    stages: { stage: string; value: number }[]
  ): number {
    return stages.reduce(
      (sum, s) => sum + s.value * (STAGE_PROBABILITIES[s.stage] ?? 0),
      0
    );
  }

  it("should weight pipeline by stage probability", () => {
    const stages = [
      { stage: "triagem", value: 500_000 },
      { stage: "qualificado", value: 300_000 },
      { stage: "proposta", value: 200_000 },
      { stage: "negociacao", value: 100_000 },
    ];

    const weighted = weightedPipeline(stages);
    // 500k*0.05 + 300k*0.15 + 200k*0.50 + 100k*0.75
    // = 25k + 45k + 100k + 75k = 245k
    expect(weighted).toBe(245_000);
  });

  it("should calculate MoM growth", () => {
    const prev = 350_000;
    const current = 420_000;
    const growth = Math.round(((current - prev) / prev) * 1000) / 10;
    expect(growth).toBe(20);
  });

  it("should calculate revenue target percentage", () => {
    const target = 500_000;
    const mtd = 380_000;
    const pct = Math.round((mtd / target) * 1000) / 10;
    expect(pct).toBe(76);
  });

  it("should calculate lead-to-close rate", () => {
    const total = 200;
    const closed = 18;
    const rate = Math.round((closed / total) * 1000) / 10;
    expect(rate).toBe(9);
  });
});
