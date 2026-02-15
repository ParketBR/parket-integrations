import { describe, it, expect } from "vitest";
import { renderProposalHtml } from "../src/services/proposal-generator.js";
import type { Lead } from "../src/db/schemas/types.js";

const mockLead: Lead = {
  id: "test-uuid",
  external_id: null,
  source: "website",
  funnel: "end_client",
  stage: "proposta",
  name: "Carlos Mendes",
  email: "carlos@test.com",
  phone: "11999887766",
  phone_normalized: "5511999887766",
  client_type: "end_client",
  project_type: "residential",
  project_stage: "acabamentos",
  location: "Sao Paulo",
  estimated_deadline: "2026-06",
  estimated_ticket: 80000,
  score: 65,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  pipedrive_deal_id: null,
  pipedrive_person_id: null,
  created_at: new Date(),
  updated_at: new Date(),
  qualified_at: null,
  closed_at: null,
};

describe("renderProposalHtml", () => {
  it("renders a proposal with client name and items", () => {
    const html = renderProposalHtml(
      mockLead,
      {
        lead_id: mockLead.id,
        project_name: "Apartamento Jardins",
        items: [
          {
            description: "Piso carvalho europeu",
            product: "Carvalho Natural",
            area_m2: 120,
            unit_price: 450,
            total: 54000,
          },
          {
            description: "Rodape",
            product: "Rodape Carvalho",
            area_m2: 45,
            unit_price: 120,
            total: 5400,
          },
        ],
        payment_terms: "50% entrada + 50% na instalacao",
      },
      59400,
      15
    );

    expect(html).toContain("Carlos Mendes");
    expect(html).toContain("Apartamento Jardins");
    expect(html).toContain("Carvalho Natural");
    expect(html).toContain("Rodape Carvalho");
    expect(html).toContain("Sao Paulo");
    expect(html).toContain("15 dias");
    expect(html).toContain("50% entrada");
  });

  it("renders without optional fields", () => {
    const leadNoLocation = { ...mockLead, location: null };

    const html = renderProposalHtml(
      leadNoLocation,
      {
        lead_id: mockLead.id,
        project_name: "Projeto X",
        items: [
          {
            description: "Piso basico",
            product: "Ipe",
            area_m2: 50,
            unit_price: 300,
            total: 15000,
          },
        ],
      },
      15000,
      10
    );

    expect(html).toContain("Carlos Mendes");
    expect(html).toContain("Projeto X");
    expect(html).not.toContain("Local:");
  });

  it("includes all mandatory proposal sections", () => {
    const html = renderProposalHtml(
      mockLead,
      {
        lead_id: mockLead.id,
        project_name: "Teste",
        items: [
          { description: "A", product: "B", area_m2: 10, unit_price: 100, total: 1000 },
        ],
      },
      1000,
      15
    );

    expect(html).toContain("Diagnostico");
    expect(html).toContain("Escopo Tecnico");
    expect(html).toContain("Diferenciais Parket");
    expect(html).toContain("Investimento");
    expect(html).toContain("Proximos Passos");
    expect(html).toContain("Garantia estendida");
    expect(html).toContain("Mao de obra propria");
  });
});
