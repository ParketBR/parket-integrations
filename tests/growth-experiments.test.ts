import { describe, it, expect } from "vitest";

// ─── Experiment Evaluation Logic Tests ──────────────

interface Measurement {
  value: number;
  sample_size: number;
}

function evaluateExperiment(
  control: Measurement,
  variant: Measurement
): {
  lift_pct: number;
  is_significant: boolean;
  verdict: "winner" | "loser" | "inconclusive";
} {
  const liftPct =
    control.value > 0
      ? Math.round(((variant.value - control.value) / control.value) * 1000) / 10
      : 0;

  // Simple significance: min 30 samples + >10% lift
  const isSignificant =
    control.sample_size >= 30 &&
    variant.sample_size >= 30 &&
    Math.abs(liftPct) > 10;

  let verdict: "winner" | "loser" | "inconclusive" = "inconclusive";
  if (isSignificant) {
    verdict = liftPct > 0 ? "winner" : "loser";
  }

  return { lift_pct: liftPct, is_significant: isSignificant, verdict };
}

describe("Experiment Evaluation", () => {
  it("should detect a winner with significant positive lift", () => {
    const result = evaluateExperiment(
      { value: 5.0, sample_size: 100 },  // 5% conversion control
      { value: 7.5, sample_size: 100 }   // 7.5% conversion variant
    );

    expect(result.lift_pct).toBe(50);
    expect(result.is_significant).toBe(true);
    expect(result.verdict).toBe("winner");
  });

  it("should detect a loser with significant negative lift", () => {
    const result = evaluateExperiment(
      { value: 8.0, sample_size: 50 },
      { value: 5.0, sample_size: 50 }
    );

    expect(result.lift_pct).toBe(-37.5);
    expect(result.is_significant).toBe(true);
    expect(result.verdict).toBe("loser");
  });

  it("should be inconclusive with small lift", () => {
    const result = evaluateExperiment(
      { value: 10.0, sample_size: 100 },
      { value: 10.5, sample_size: 100 }  // Only 5% lift
    );

    expect(result.lift_pct).toBe(5);
    expect(result.is_significant).toBe(false);
    expect(result.verdict).toBe("inconclusive");
  });

  it("should be inconclusive with small sample size", () => {
    const result = evaluateExperiment(
      { value: 5.0, sample_size: 10 },   // Too few samples
      { value: 8.0, sample_size: 10 }
    );

    expect(result.lift_pct).toBe(60);
    expect(result.is_significant).toBe(false); // Despite big lift
    expect(result.verdict).toBe("inconclusive");
  });

  it("should handle zero control value", () => {
    const result = evaluateExperiment(
      { value: 0, sample_size: 50 },
      { value: 5.0, sample_size: 50 }
    );

    expect(result.lift_pct).toBe(0);
    expect(result.verdict).toBe("inconclusive");
  });
});

// ─── Experiment Duration Logic ──────────────────────

describe("Experiment Duration", () => {
  it("should calculate days running", () => {
    const startedAt = new Date("2026-02-01");
    const now = new Date("2026-02-14");
    const daysRunning = Math.round((now.getTime() - startedAt.getTime()) / 86_400_000);
    expect(daysRunning).toBe(13);
  });

  it("should detect expired experiment (past end date)", () => {
    const endsAt = new Date("2026-02-10");
    const now = new Date("2026-02-14");
    expect(now > endsAt).toBe(true);
  });

  it("should validate 2-week default cycle", () => {
    const durationDays = 14;
    const startDate = new Date("2026-02-01");
    const endDate = new Date(startDate.getTime() + durationDays * 86_400_000);
    expect(endDate.toISOString().split("T")[0]).toBe("2026-02-15");
  });
});

// ─── Budget Allocation ──────────────────────────────

describe("Experiment Budget", () => {
  it("should split budget 50/50 between control and variant", () => {
    const budget = 10_000;
    const controlBudget = budget / 2;
    const variantBudget = budget / 2;
    expect(controlBudget).toBe(5_000);
    expect(variantBudget).toBe(5_000);
  });

  it("should calculate cost per conversion", () => {
    const spend = 5_000;
    const conversions = 10;
    const cpc = Math.round(spend / conversions);
    expect(cpc).toBe(500);
  });

  it("should calculate experiment ROI", () => {
    const spend = 10_000;
    const revenue = 50_000;
    const roi = Math.round(((revenue - spend) / spend) * 100);
    expect(roi).toBe(400);
  });
});
