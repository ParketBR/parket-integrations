import { describe, it, expect } from "vitest";

describe("OTIF calculation", () => {
  it("100% OTIF when all on time", () => {
    const delivered = 10;
    const onTime = 10;
    const otif = delivered > 0 ? Math.round((onTime / delivered) * 100) : 0;
    expect(otif).toBe(100);
  });

  it("50% OTIF when half on time", () => {
    const delivered = 10;
    const onTime = 5;
    const otif = delivered > 0 ? Math.round((onTime / delivered) * 100) : 0;
    expect(otif).toBe(50);
  });

  it("0% OTIF when nothing delivered", () => {
    const delivered = 0;
    const onTime = 0;
    const otif = delivered > 0 ? Math.round((onTime / delivered) * 100) : 0;
    expect(otif).toBe(0);
  });
});

describe("delivery on time check", () => {
  it("on time when delivered before estimated", () => {
    const estimated = new Date("2026-03-15");
    const actual = new Date("2026-03-14");
    expect(actual <= estimated).toBe(true);
  });

  it("on time when delivered same day", () => {
    const estimated = new Date("2026-03-15");
    const actual = new Date("2026-03-15");
    expect(actual <= estimated).toBe(true);
  });

  it("late when delivered after estimated", () => {
    const estimated = new Date("2026-03-15");
    const actual = new Date("2026-03-16");
    expect(actual <= estimated).toBe(false);
  });
});

describe("purchase order status flow", () => {
  const PO_STATUSES = [
    "draft",
    "sent",
    "confirmed",
    "production",
    "shipped",
    "delivered",
  ];

  it("has 6 statuses", () => {
    expect(PO_STATUSES).toHaveLength(6);
  });

  it("starts with draft and ends with delivered", () => {
    expect(PO_STATUSES[0]).toBe("draft");
    expect(PO_STATUSES[PO_STATUSES.length - 1]).toBe("delivered");
  });
});
