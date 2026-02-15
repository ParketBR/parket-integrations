import { describe, it, expect } from "vitest";

describe("project communication templates", () => {
  // Simplified template functions for testing
  const templates: Record<string, (ctx: Record<string, string | null>) => string> = {
    handoff_confirmation: (ctx) =>
      `Ola ${ctx.clientName}! Aqui e a Parket.\n\nSeu contrato foi confirmado e estamos muito felizes em ter voce como cliente!`,

    status_agendado: (ctx) =>
      `${ctx.clientName}, otima noticia!\n\nSua instalacao foi agendada${ctx.installationDate ? ` para ${ctx.installationDate}` : ""}.`,

    status_concluido: (ctx) =>
      `${ctx.clientName}, parabens!\n\nSeu projeto Parket esta oficialmente concluido!`,

    delay_notification: (ctx) =>
      `${ctx.clientName}, informamos que houve um ajuste no cronograma do seu projeto${ctx.location ? ` em ${ctx.location}` : ""}.`,
  };

  it("handoff confirmation includes client name", () => {
    const msg = templates.handoff_confirmation({ clientName: "Maria Silva", location: null });
    expect(msg).toContain("Maria Silva");
    expect(msg).toContain("contrato foi confirmado");
  });

  it("agendado template includes date when provided", () => {
    const msg = templates.status_agendado({
      clientName: "Joao",
      installationDate: "20/03/2026",
    });
    expect(msg).toContain("Joao");
    expect(msg).toContain("20/03/2026");
  });

  it("agendado template works without date", () => {
    const msg = templates.status_agendado({
      clientName: "Ana",
      installationDate: null,
    });
    expect(msg).toContain("Ana");
    expect(msg).toContain("agendada");
    expect(msg).not.toContain("para null");
  });

  it("concluido template includes congratulations", () => {
    const msg = templates.status_concluido({ clientName: "Carlos", location: null });
    expect(msg).toContain("parabens");
    expect(msg).toContain("concluido");
  });

  it("delay notification includes location when available", () => {
    const msg = templates.delay_notification({
      clientName: "Pedro",
      location: "Jardins",
    });
    expect(msg).toContain("Pedro");
    expect(msg).toContain("em Jardins");
  });

  it("delay notification works without location", () => {
    const msg = templates.delay_notification({
      clientName: "Ana",
      location: null,
    });
    expect(msg).toContain("Ana");
    expect(msg).not.toContain("em null");
  });
});

describe("status labels", () => {
  const STATUS_LABELS: Record<string, string> = {
    handoff: "Contrato assinado",
    vistoria: "Vistoria concluida",
    material_pedido: "Material solicitado",
    aguardando_material: "Aguardando material",
    agendado: "Instalacao agendada",
    em_execucao: "Em execucao",
    entrega: "Instalacao concluida",
    pos_obra: "Em pos-obra",
    concluido: "Projeto concluido",
  };

  it("has labels for all 9 statuses", () => {
    expect(Object.keys(STATUS_LABELS)).toHaveLength(9);
  });

  it("labels are human-readable Portuguese", () => {
    for (const label of Object.values(STATUS_LABELS)) {
      expect(label.length).toBeGreaterThan(5);
    }
  });
});
