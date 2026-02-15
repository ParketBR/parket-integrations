import { describe, it, expect } from "vitest";
import Handlebars from "handlebars";

describe("follow-up templates", () => {
  const templates = {
    end_client_1h: `Ola {{name}}! Aqui e a Parket. Recebemos seu contato e ficamos felizes com seu interesse. Um de nossos consultores vai entrar em contato em breve para entender melhor seu projeto. Enquanto isso, tem alguma duvida que possamos ajudar?`,
    end_client_24h: `Ola {{name}}, tudo bem? Aqui e a Parket. Gostavamos de saber mais sobre seu projeto{{#if location}} em {{location}}{{/if}}. Podemos agendar uma conversa rapida para entender suas necessidades e apresentar as melhores opcoes? Qual o melhor horario para voce?`,
    architect_30min: `Ola {{name}}! Aqui e a Parket. Recebemos seu contato e ficamos muito felizes. Somos especializados em pisos de madeira de alto padrao e trabalhamos com diversos escritorios de arquitetura. Posso enviar nosso portfolio tecnico?`,
  };

  it("renders end client 1h template with name", () => {
    const compiled = Handlebars.compile(templates.end_client_1h);
    const result = compiled({ name: "Maria" });
    expect(result).toContain("Maria");
    expect(result).toContain("Parket");
    expect(result).toContain("consultor");
  });

  it("renders end client 24h template with location", () => {
    const compiled = Handlebars.compile(templates.end_client_24h);
    const result = compiled({ name: "Joao", location: "Sao Paulo" });
    expect(result).toContain("Joao");
    expect(result).toContain("em Sao Paulo");
  });

  it("renders end client 24h template without location", () => {
    const compiled = Handlebars.compile(templates.end_client_24h);
    const result = compiled({ name: "Ana" });
    expect(result).toContain("Ana");
    expect(result).not.toContain("em ");
    expect(result).toContain("seu projeto.");
  });

  it("renders architect template correctly", () => {
    const compiled = Handlebars.compile(templates.architect_30min);
    const result = compiled({ name: "Arq. Silva" });
    expect(result).toContain("Arq. Silva");
    expect(result).toContain("portfolio tecnico");
  });

  it("handles empty name gracefully", () => {
    const compiled = Handlebars.compile(templates.end_client_1h);
    const result = compiled({ name: "" });
    expect(result).toContain("Ola ");
    expect(result).toContain("Parket");
  });
});

describe("sequence timing", () => {
  const SEQUENCE_DELAYS = {
    end_client: [60, 1440, 4320, 10080], // 1h, 24h, 3d, 7d
    architects: [30, 2880, 10080], // 30min, 2d, 7d
    developers: [60, 4320], // 1h, 3d
  };

  it("end client has 4 steps with correct delays", () => {
    expect(SEQUENCE_DELAYS.end_client).toHaveLength(4);
    expect(SEQUENCE_DELAYS.end_client[0]).toBe(60); // 1h
    expect(SEQUENCE_DELAYS.end_client[1]).toBe(1440); // 24h
    expect(SEQUENCE_DELAYS.end_client[2]).toBe(4320); // 3 days
    expect(SEQUENCE_DELAYS.end_client[3]).toBe(10080); // 7 days
  });

  it("architect sequence has 3 steps", () => {
    expect(SEQUENCE_DELAYS.architects).toHaveLength(3);
    expect(SEQUENCE_DELAYS.architects[0]).toBe(30); // 30min - faster for architects
  });

  it("developer sequence has 2 steps", () => {
    expect(SEQUENCE_DELAYS.developers).toHaveLength(2);
  });

  it("delays are always increasing", () => {
    for (const [, delays] of Object.entries(SEQUENCE_DELAYS)) {
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }
    }
  });
});
