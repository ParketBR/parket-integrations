import { describe, it, expect } from "vitest";
import { scoreLead } from "../src/services/lead-scoring.js";
import type { RawLeadInput } from "../src/services/lead-ingestion.js";

describe("scoreLead", () => {
  it("scores a high-quality architect lead high", () => {
    const input: RawLeadInput = {
      name: "Arq. Maria Silva",
      phone: "11999887766",
      email: "maria@studio.com",
      source: "architect",
      client_type: "architect",
      project_type: "residential",
      project_stage: "acabamentos",
      location: "Sao Paulo",
      estimated_deadline: "2026-04",
      estimated_ticket: 150_000,
    };

    const score = scoreLead(input);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("scores a cold Meta Ads lead with minimal data low", () => {
    const input: RawLeadInput = {
      name: "Joao",
      phone: "11999000000",
      source: "meta_ads",
    };

    const score = scoreLead(input);
    expect(score).toBeLessThan(20);
  });

  it("scores a mid-funnel end client reasonably", () => {
    const input: RawLeadInput = {
      name: "Carlos Mendes",
      phone: "21988776655",
      email: "carlos@gmail.com",
      source: "website",
      client_type: "end_client",
      project_type: "residential",
      project_stage: "obra_iniciada",
      estimated_ticket: 60_000,
    };

    const score = scoreLead(input);
    expect(score).toBeGreaterThanOrEqual(40);
    expect(score).toBeLessThanOrEqual(75);
  });

  it("gives higher score for developer with high ticket", () => {
    const devInput: RawLeadInput = {
      name: "Incorporadora ABC",
      phone: "11977665544",
      source: "referral",
      client_type: "developer",
      project_type: "commercial",
      project_stage: "planta",
      estimated_ticket: 500_000,
      location: "BSB",
      estimated_deadline: "2026-12",
    };

    const coldInput: RawLeadInput = {
      name: "Pessoa Random",
      phone: "11966554433",
      source: "instagram",
    };

    expect(scoreLead(devInput)).toBeGreaterThan(scoreLead(coldInput));
  });

  it("never exceeds 100", () => {
    const maxInput: RawLeadInput = {
      name: "Perfect Lead",
      phone: "11999999999",
      email: "perfect@example.com",
      source: "architect",
      client_type: "architect",
      project_type: "residential",
      project_stage: "acabamentos",
      location: "SP",
      estimated_deadline: "next month",
      estimated_ticket: 1_000_000,
    };

    expect(scoreLead(maxInput)).toBeLessThanOrEqual(100);
  });
});
