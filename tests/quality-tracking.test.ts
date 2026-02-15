import { describe, it, expect } from "vitest";

// ─── NPS Logic Tests ────────────────────────────────

function classifyNps(score: number): "promoter" | "passive" | "detractor" {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

function calculateNps(scores: number[]): {
  nps: number;
  promoters: number;
  passives: number;
  detractors: number;
} {
  if (scores.length === 0) return { nps: 0, promoters: 0, passives: 0, detractors: 0 };

  const promoters = scores.filter((s) => s >= 9).length;
  const passives = scores.filter((s) => s >= 7 && s <= 8).length;
  const detractors = scores.filter((s) => s <= 6).length;
  const nps = Math.round(((promoters - detractors) / scores.length) * 100);

  return { nps, promoters, passives, detractors };
}

describe("NPS Classification", () => {
  it("should classify 9-10 as promoter", () => {
    expect(classifyNps(9)).toBe("promoter");
    expect(classifyNps(10)).toBe("promoter");
  });

  it("should classify 7-8 as passive", () => {
    expect(classifyNps(7)).toBe("passive");
    expect(classifyNps(8)).toBe("passive");
  });

  it("should classify 0-6 as detractor", () => {
    expect(classifyNps(0)).toBe("detractor");
    expect(classifyNps(3)).toBe("detractor");
    expect(classifyNps(6)).toBe("detractor");
  });
});

describe("NPS Calculation", () => {
  it("should calculate perfect NPS (all promoters)", () => {
    const result = calculateNps([10, 9, 10, 9, 10]);
    expect(result.nps).toBe(100);
    expect(result.promoters).toBe(5);
    expect(result.detractors).toBe(0);
  });

  it("should calculate worst NPS (all detractors)", () => {
    const result = calculateNps([1, 2, 3, 4, 5]);
    expect(result.nps).toBe(-100);
    expect(result.detractors).toBe(5);
  });

  it("should calculate mixed NPS", () => {
    // 4 promoters, 3 passives, 3 detractors = (4-3)/10 = 10%
    const result = calculateNps([10, 9, 10, 9, 8, 7, 8, 5, 3, 6]);
    expect(result.nps).toBe(10);
    expect(result.promoters).toBe(4);
    expect(result.passives).toBe(3);
    expect(result.detractors).toBe(3);
  });

  it("should handle empty responses", () => {
    const result = calculateNps([]);
    expect(result.nps).toBe(0);
  });

  it("should calculate Parket target NPS (>70)", () => {
    // Premium brand should aim for NPS > 70
    const scores = [10, 10, 9, 10, 9, 9, 8, 10, 9, 7]; // 8 promoters, 2 passives, 0 detractors
    const result = calculateNps(scores);
    expect(result.nps).toBe(80);
    expect(result.nps >= 70).toBe(true);
  });
});

// ─── Go/No-Go Logic Tests ───────────────────────────

interface ChecklistItem {
  description: string;
  completed: boolean;
  is_mandatory: boolean;
  requires_photo: boolean;
  photo_url: string | null;
}

function evaluateGoNoGo(items: ChecklistItem[]): {
  decision: "go" | "no_go";
  blocking: string[];
} {
  const mandatory = items.filter((i) => i.is_mandatory);
  const blocking = mandatory
    .filter((i) => !i.completed || (i.requires_photo && !i.photo_url))
    .map((i) => i.description);

  return {
    decision: blocking.length === 0 ? "go" : "no_go",
    blocking,
  };
}

describe("Go/No-Go Evaluation", () => {
  it("should approve when all mandatory items complete", () => {
    const items: ChecklistItem[] = [
      { description: "Vistoria base", completed: true, is_mandatory: true, requires_photo: true, photo_url: "https://..." },
      { description: "Medicao umidade", completed: true, is_mandatory: true, requires_photo: true, photo_url: "https://..." },
      { description: "Limpeza opcional", completed: false, is_mandatory: false, requires_photo: false, photo_url: null },
    ];

    const result = evaluateGoNoGo(items);
    expect(result.decision).toBe("go");
    expect(result.blocking).toHaveLength(0);
  });

  it("should block when mandatory item incomplete", () => {
    const items: ChecklistItem[] = [
      { description: "Vistoria base", completed: true, is_mandatory: true, requires_photo: false, photo_url: null },
      { description: "Medicao umidade", completed: false, is_mandatory: true, requires_photo: true, photo_url: null },
    ];

    const result = evaluateGoNoGo(items);
    expect(result.decision).toBe("no_go");
    expect(result.blocking).toContain("Medicao umidade");
  });

  it("should block when mandatory photo missing", () => {
    const items: ChecklistItem[] = [
      { description: "Vistoria base", completed: true, is_mandatory: true, requires_photo: true, photo_url: null },
    ];

    const result = evaluateGoNoGo(items);
    expect(result.decision).toBe("no_go");
    expect(result.blocking).toContain("Vistoria base");
  });

  it("should not block on optional incomplete items", () => {
    const items: ChecklistItem[] = [
      { description: "Mandatory item", completed: true, is_mandatory: true, requires_photo: false, photo_url: null },
      { description: "Optional item", completed: false, is_mandatory: false, requires_photo: false, photo_url: null },
    ];

    const result = evaluateGoNoGo(items);
    expect(result.decision).toBe("go");
  });
});

// ─── Rework Matrix Logic ────────────────────────────

describe("Rework Prevention", () => {
  const PREVENTION_MAP: Record<string, string> = {
    base_umida: "Medicao de umidade obrigatoria pre-instalacao (max 12%)",
    contrapiso_irregular: "Vistoria com nivel laser antes de liberar",
    material_danificado: "Inspecao fotografica na entrega + aclimatacao 72h",
    instalacao_incorreta: "Checklist de instalacao + supervisao senior",
  };

  it("should map known causes to prevention measures", () => {
    expect(PREVENTION_MAP["base_umida"]).toContain("umidade");
    expect(PREVENTION_MAP["contrapiso_irregular"]).toContain("nivel laser");
    expect(PREVENTION_MAP["material_danificado"]).toContain("aclimatacao");
  });

  it("should prioritize by frequency", () => {
    const incidents = [
      { cause: "base_umida", count: 8, cost: 40_000 },
      { cause: "instalacao_incorreta", count: 3, cost: 15_000 },
      { cause: "material_danificado", count: 5, cost: 30_000 },
    ];

    const sorted = incidents.sort((a, b) => b.count - a.count);
    expect(sorted[0].cause).toBe("base_umida");
    expect(sorted[1].cause).toBe("material_danificado");
  });
});
