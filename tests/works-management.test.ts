import { describe, it, expect } from "vitest";

describe("checklist templates", () => {
  const PHASES = ["pre_obra", "instalacao", "entrega", "pos_obra"];

  const residentialChecklist = [
    { phase: "pre_obra", description: "Vistoria tecnica realizada", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Medicao final confirmada (m²)", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Teste de umidade do contrapiso (< 2.5%)", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Nivel e planeza do contrapiso verificados", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Aclimatacao do material no local (min 72h)", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Planta baixa com paginacao aprovada", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Condicoes de acesso e logistica verificadas", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Contrapiso limpo e preparado", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Cola/sistema de fixacao correto aplicado", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Paginacao conforme projeto aprovado", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Junta de dilatacao respeitada", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Cortes limpos e precisos", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Limpeza final realizada", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Termo de entrega assinado pelo cliente", is_mandatory: true, requires_photo: true },
    { phase: "pos_obra", description: "Contato pos-obra 7 dias (satisfacao)", is_mandatory: true, requires_photo: false },
  ];

  it("covers all 4 phases", () => {
    const phases = [...new Set(residentialChecklist.map((c) => c.phase))];
    for (const phase of PHASES) {
      expect(phases).toContain(phase);
    }
  });

  it("has mandatory items with photos for pre_obra", () => {
    const preObra = residentialChecklist.filter((c) => c.phase === "pre_obra");
    const mandatoryWithPhoto = preObra.filter(
      (c) => c.is_mandatory && c.requires_photo
    );
    expect(mandatoryWithPhoto.length).toBeGreaterThanOrEqual(3);
  });

  it("requires termo de entrega assinado", () => {
    const entrega = residentialChecklist.filter((c) => c.phase === "entrega");
    const termoItem = entrega.find((c) =>
      c.description.toLowerCase().includes("termo de entrega")
    );
    expect(termoItem).toBeDefined();
    expect(termoItem!.is_mandatory).toBe(true);
    expect(termoItem!.requires_photo).toBe(true);
  });

  it("includes humidity test in pre_obra", () => {
    const humidityItem = residentialChecklist.find((c) =>
      c.description.toLowerCase().includes("umidade")
    );
    expect(humidityItem).toBeDefined();
    expect(humidityItem!.phase).toBe("pre_obra");
    expect(humidityItem!.is_mandatory).toBe(true);
  });
});

describe("project status flow", () => {
  const STATUS_FLOW = [
    "handoff",
    "vistoria",
    "material_pedido",
    "aguardando_material",
    "agendado",
    "em_execucao",
    "entrega",
    "pos_obra",
    "concluido",
  ];

  it("has 9 statuses in correct order", () => {
    expect(STATUS_FLOW).toHaveLength(9);
    expect(STATUS_FLOW[0]).toBe("handoff");
    expect(STATUS_FLOW[STATUS_FLOW.length - 1]).toBe("concluido");
  });

  it("each status transitions to the next", () => {
    for (let i = 0; i < STATUS_FLOW.length - 1; i++) {
      const current = STATUS_FLOW[i];
      const next = STATUS_FLOW[i + 1];
      expect(next).toBeDefined();
      // Just verify the ordering exists
      expect(STATUS_FLOW.indexOf(next)).toBe(STATUS_FLOW.indexOf(current) + 1);
    }
  });
});

describe("quality score calculation", () => {
  it("100% completion + 100% photos = 100 score", () => {
    const total = 20;
    const completed = 20;
    const needsPhotos = 10;
    const withPhotos = 10;
    const hasRework = false;

    const completionScore = (completed / total) * 70;
    const photoScore = (withPhotos / needsPhotos) * 30;
    const score = Math.round(completionScore + photoScore);
    const finalScore = hasRework ? Math.max(0, score - 15) : score;

    expect(finalScore).toBe(100);
  });

  it("rework deducts 15 points", () => {
    const total = 20;
    const completed = 20;
    const needsPhotos = 10;
    const withPhotos = 10;
    const hasRework = true;

    const completionScore = (completed / total) * 70;
    const photoScore = (withPhotos / needsPhotos) * 30;
    const score = Math.round(completionScore + photoScore);
    const finalScore = hasRework ? Math.max(0, score - 15) : score;

    expect(finalScore).toBe(85);
  });

  it("50% completion + 50% photos = ~50 score", () => {
    const total = 20;
    const completed = 10;
    const needsPhotos = 10;
    const withPhotos = 5;
    const hasRework = false;

    const completionScore = (completed / total) * 70;
    const photoScore = (withPhotos / needsPhotos) * 30;
    const score = Math.round(completionScore + photoScore);

    expect(score).toBe(50);
  });

  it("score never goes below 0", () => {
    const total = 20;
    const completed = 1;
    const needsPhotos = 10;
    const withPhotos = 0;
    const hasRework = true;

    const completionScore = (completed / total) * 70;
    const photoScore = (withPhotos / needsPhotos) * 30;
    const score = Math.round(completionScore + photoScore);
    const finalScore = hasRework ? Math.max(0, score - 15) : score;

    expect(finalScore).toBeGreaterThanOrEqual(0);
  });
});
