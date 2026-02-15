import { describe, it, expect } from "vitest";

// ─── Prospect Scoring Logic Tests ───────────────────

function calculateRelationshipScore(
  outcomes: Array<"positive" | "neutral" | "negative" | "no_response">
): number {
  const SCORE_MAP = {
    positive: 15,
    neutral: 5,
    negative: -5,
    no_response: 0,
  };

  let score = 0;
  for (const outcome of outcomes) {
    score += SCORE_MAP[outcome];
  }
  return Math.max(0, Math.min(100, score));
}

describe("Relationship Scoring", () => {
  it("should increase score on positive interactions", () => {
    const score = calculateRelationshipScore(["positive", "positive", "positive"]);
    expect(score).toBe(45);
  });

  it("should decrease score on negative interactions", () => {
    const score = calculateRelationshipScore(["positive", "negative", "negative"]);
    expect(score).toBe(5);
  });

  it("should cap at 100", () => {
    const outcomes: Array<"positive"> = Array(10).fill("positive");
    const score = calculateRelationshipScore(outcomes);
    expect(score).toBe(100);
  });

  it("should floor at 0", () => {
    const outcomes: Array<"negative"> = Array(10).fill("negative");
    const score = calculateRelationshipScore(outcomes);
    expect(score).toBe(0);
  });

  it("should handle no_response as neutral (0 points)", () => {
    const score = calculateRelationshipScore(["no_response", "no_response", "no_response"]);
    expect(score).toBe(0);
  });

  it("should track engagement progression", () => {
    // First contact: neutral, second: positive, third: positive
    const progression = [
      calculateRelationshipScore(["neutral"]),
      calculateRelationshipScore(["neutral", "positive"]),
      calculateRelationshipScore(["neutral", "positive", "positive"]),
    ];
    expect(progression[0]).toBe(5);
    expect(progression[1]).toBe(20);
    expect(progression[2]).toBe(35);
    expect(progression[0] < progression[1]).toBe(true);
    expect(progression[1] < progression[2]).toBe(true);
  });
});

// ─── Prospect Tier Classification ───────────────────

interface Prospect {
  name: string;
  type: string;
  region: string;
  estimated_annual_value: number;
  has_active_projects: boolean;
}

function classifyTier(
  prospect: Prospect
): "high_potential" | "build_relationship" | "nurture" {
  // High potential: high value + active projects or architect in SP
  if (
    prospect.estimated_annual_value >= 200_000 ||
    (prospect.type === "architect" && prospect.has_active_projects)
  ) {
    return "high_potential";
  }

  // Build relationship: medium value or strategic type
  if (
    prospect.estimated_annual_value >= 50_000 ||
    prospect.type === "incorporadora"
  ) {
    return "build_relationship";
  }

  return "nurture";
}

describe("Prospect Tier Classification", () => {
  it("should classify high-value prospects as high_potential", () => {
    const tier = classifyTier({
      name: "Arq. Maria",
      type: "architect",
      region: "SP",
      estimated_annual_value: 300_000,
      has_active_projects: true,
    });
    expect(tier).toBe("high_potential");
  });

  it("should classify active architects as high_potential", () => {
    const tier = classifyTier({
      name: "Studio Design",
      type: "architect",
      region: "RJ",
      estimated_annual_value: 80_000,
      has_active_projects: true,
    });
    expect(tier).toBe("high_potential");
  });

  it("should classify incorporadoras as build_relationship", () => {
    const tier = classifyTier({
      name: "MRV",
      type: "incorporadora",
      region: "SP",
      estimated_annual_value: 30_000,
      has_active_projects: false,
    });
    expect(tier).toBe("build_relationship");
  });

  it("should classify low-value inactive as nurture", () => {
    const tier = classifyTier({
      name: "Small Studio",
      type: "designer",
      region: "SC",
      estimated_annual_value: 20_000,
      has_active_projects: false,
    });
    expect(tier).toBe("nurture");
  });
});

// ─── Regional Analysis ──────────────────────────────

describe("Regional Segmentation", () => {
  interface RegionData {
    region: string;
    prospects: number;
    estimated_value: number;
  }

  function rankRegions(data: RegionData[]): RegionData[] {
    return [...data].sort((a, b) => b.estimated_value - a.estimated_value);
  }

  it("should rank regions by estimated value", () => {
    const data: RegionData[] = [
      { region: "SC", prospects: 5, estimated_value: 200_000 },
      { region: "SP", prospects: 15, estimated_value: 800_000 },
      { region: "RJ", prospects: 8, estimated_value: 400_000 },
      { region: "BSB", prospects: 3, estimated_value: 150_000 },
    ];

    const ranked = rankRegions(data);
    expect(ranked[0].region).toBe("SP");
    expect(ranked[1].region).toBe("RJ");
    expect(ranked[2].region).toBe("SC");
    expect(ranked[3].region).toBe("BSB");
  });

  it("should identify top 3 regions", () => {
    const data: RegionData[] = [
      { region: "SP", prospects: 15, estimated_value: 800_000 },
      { region: "RJ", prospects: 8, estimated_value: 400_000 },
      { region: "SC", prospects: 5, estimated_value: 200_000 },
      { region: "BSB", prospects: 3, estimated_value: 150_000 },
      { region: "Sul", prospects: 2, estimated_value: 100_000 },
    ];

    const top3 = rankRegions(data).slice(0, 3);
    expect(top3).toHaveLength(3);
    expect(top3.map((r) => r.region)).toEqual(["SP", "RJ", "SC"]);
  });
});

// ─── Stale Prospect Detection ───────────────────────

describe("Stale Prospect Detection", () => {
  it("should detect prospects without contact for >14 days", () => {
    const now = new Date("2026-02-14");
    const lastContact = new Date("2026-01-25");
    const daysSince = Math.round(
      (now.getTime() - lastContact.getTime()) / 86_400_000
    );
    expect(daysSince).toBe(20);
    expect(daysSince > 14).toBe(true);
  });

  it("should not flag recent contacts", () => {
    const now = new Date("2026-02-14");
    const lastContact = new Date("2026-02-10");
    const daysSince = Math.round(
      (now.getTime() - lastContact.getTime()) / 86_400_000
    );
    expect(daysSince).toBe(4);
    expect(daysSince > 14).toBe(false);
  });
});
