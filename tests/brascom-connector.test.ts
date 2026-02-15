import { describe, it, expect } from "vitest";
import {
  parseCsvInvoices,
  type CsvInvoiceRow,
} from "../src/connectors/brascom/client.js";

describe("Brascom Connector — CSV Parser", () => {
  const sampleRows: CsvInvoiceRow[] = [
    {
      numero: "NF-001",
      tipo: "receber",
      descricao: "Projeto Residencial Silva",
      valor_bruto: "45000,00",
      impostos: "4500,00",
      valor_liquido: "40500,00",
      centro_custo: "obras",
      categoria: "servico",
      emissao: "15/01/2026",
      vencimento: "15/02/2026",
      pagamento: "10/02/2026",
      status: "pago",
    },
    {
      numero: "NF-002",
      tipo: "pagar",
      descricao: "Compra madeira Ipe",
      valor_bruto: "22000,00",
      impostos: "2200,00",
      valor_liquido: "19800,00",
      centro_custo: "materiais",
      categoria: "material",
      emissao: "20/01/2026",
      vencimento: "20/02/2026",
      pagamento: "",
      status: "vencido",
    },
    {
      numero: "NF-003",
      tipo: "receber",
      descricao: "Parcela 2 - Projeto Arquiteta Maria",
      valor_bruto: "30000,00",
      impostos: "3000,00",
      valor_liquido: "27000,00",
      centro_custo: "obras",
      categoria: "servico",
      emissao: "01/02/2026",
      vencimento: "01/03/2026",
      pagamento: "",
      status: "aberto",
    },
  ];

  it("should parse CSV rows into BrascomInvoice format", () => {
    const invoices = parseCsvInvoices(sampleRows);

    expect(invoices).toHaveLength(3);

    // First invoice: receivable, paid
    expect(invoices[0].number).toBe("NF-001");
    expect(invoices[0].type).toBe("receivable");
    expect(invoices[0].gross_value).toBe(45000);
    expect(invoices[0].tax_value).toBe(4500);
    expect(invoices[0].net_value).toBe(40500);
    expect(invoices[0].status).toBe("paid");
    expect(invoices[0].paid_at).toBe("2026-02-10");
  });

  it("should correctly map type receber → receivable, pagar → payable", () => {
    const invoices = parseCsvInvoices(sampleRows);
    expect(invoices[0].type).toBe("receivable");
    expect(invoices[1].type).toBe("payable");
  });

  it("should convert BR dates to ISO format", () => {
    const invoices = parseCsvInvoices(sampleRows);
    expect(invoices[0].issued_at).toBe("2026-01-15");
    expect(invoices[0].due_at).toBe("2026-02-15");
    expect(invoices[2].issued_at).toBe("2026-02-01");
  });

  it("should map status correctly", () => {
    const invoices = parseCsvInvoices(sampleRows);
    expect(invoices[0].status).toBe("paid");       // pago
    expect(invoices[1].status).toBe("overdue");     // vencido
    expect(invoices[2].status).toBe("open");        // aberto
  });

  it("should handle missing payment date as null", () => {
    const invoices = parseCsvInvoices(sampleRows);
    expect(invoices[1].paid_at).toBeNull();
    expect(invoices[2].paid_at).toBeNull();
  });

  it("should parse decimal values with comma separator", () => {
    const rows: CsvInvoiceRow[] = [
      {
        numero: "NF-100",
        tipo: "receber",
        descricao: "Test",
        valor_bruto: "1234,56",
        impostos: "123,45",
        valor_liquido: "1111,11",
        centro_custo: "",
        categoria: "",
        emissao: "01/01/2026",
        vencimento: "31/01/2026",
        pagamento: "",
        status: "aberto",
      },
    ];
    const invoices = parseCsvInvoices(rows);
    expect(invoices[0].gross_value).toBeCloseTo(1234.56);
    expect(invoices[0].tax_value).toBeCloseTo(123.45);
    expect(invoices[0].net_value).toBeCloseTo(1111.11);
  });

  it("should handle cancelled status", () => {
    const rows: CsvInvoiceRow[] = [
      {
        numero: "NF-200",
        tipo: "pagar",
        descricao: "Cancelled order",
        valor_bruto: "5000,00",
        impostos: "500,00",
        valor_liquido: "4500,00",
        centro_custo: "",
        categoria: "",
        emissao: "01/01/2026",
        vencimento: "31/01/2026",
        pagamento: "",
        status: "cancelado",
      },
    ];
    const invoices = parseCsvInvoices(rows);
    expect(invoices[0].status).toBe("cancelled");
  });

  it("should handle quitado as paid", () => {
    const rows: CsvInvoiceRow[] = [
      {
        numero: "NF-300",
        tipo: "receber",
        descricao: "Paid invoice",
        valor_bruto: "10000,00",
        impostos: "1000,00",
        valor_liquido: "9000,00",
        centro_custo: "",
        categoria: "",
        emissao: "01/01/2026",
        vencimento: "31/01/2026",
        pagamento: "15/01/2026",
        status: "quitado",
      },
    ];
    const invoices = parseCsvInvoices(rows);
    expect(invoices[0].status).toBe("paid");
  });
});
