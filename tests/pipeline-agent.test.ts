import { describe, it, expect } from "vitest";

describe("pipeline forecast probabilities", () => {
  const STAGE_PROBABILITIES: Record<string, number> = {
    triagem: 0.05,
    qualificado: 0.15,
    reuniao: 0.30,
    proposta: 0.50,
    negociacao: 0.75,
  };

  it("probabilities increase monotonically", () => {
    const stages = ["triagem", "qualificado", "reuniao", "proposta", "negociacao"];
    for (let i = 1; i < stages.length; i++) {
      expect(STAGE_PROBABILITIES[stages[i]]).toBeGreaterThan(
        STAGE_PROBABILITIES[stages[i - 1]]
      );
    }
  });

  it("triagem has lowest probability", () => {
    expect(STAGE_PROBABILITIES.triagem).toBe(0.05);
  });

  it("negociacao has highest probability", () => {
    expect(STAGE_PROBABILITIES.negociacao).toBe(0.75);
  });

  it("weighted pipeline calculation is correct", () => {
    const deals = [
      { stage: "triagem", value: 100000 },
      { stage: "proposta", value: 50000 },
      { stage: "negociacao", value: 80000 },
    ];

    const weighted = deals.reduce(
      (sum, d) => sum + d.value * STAGE_PROBABILITIES[d.stage],
      0
    );

    // 100000 * 0.05 + 50000 * 0.50 + 80000 * 0.75
    expect(weighted).toBe(5000 + 25000 + 60000);
    expect(weighted).toBe(90000);
  });
});

describe("stale deal detection threshold", () => {
  it("5-day threshold in milliseconds is correct", () => {
    const thresholdDays = 5;
    const thresholdMs = thresholdDays * 86_400_000;
    expect(thresholdMs).toBe(432_000_000);
  });

  it("a deal updated 6 days ago is stale at 5-day threshold", () => {
    const now = Date.now();
    const sixDaysAgo = now - 6 * 86_400_000;
    const threshold = now - 5 * 86_400_000;
    expect(sixDaysAgo).toBeLessThan(threshold);
  });

  it("a deal updated 3 days ago is NOT stale at 5-day threshold", () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 86_400_000;
    const threshold = now - 5 * 86_400_000;
    expect(threeDaysAgo).toBeGreaterThan(threshold);
  });
});
