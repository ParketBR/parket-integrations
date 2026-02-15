import { describe, it, expect } from "vitest";
import { normalizePhone } from "../src/connectors/whatsapp/client.js";

describe("normalizePhone", () => {
  it("normalizes a full Brazilian mobile number", () => {
    expect(normalizePhone("5511999887766")).toBe("5511999887766");
  });

  it("adds country code to 11-digit number", () => {
    expect(normalizePhone("11999887766")).toBe("5511999887766");
  });

  it("adds country code and 9th digit to 10-digit number", () => {
    expect(normalizePhone("1198765432")).toBe("5511998765432");
  });

  it("strips non-digit characters", () => {
    expect(normalizePhone("+55 (11) 99988-7766")).toBe("5511999887766");
  });

  it("handles number with country code but no 9th digit", () => {
    expect(normalizePhone("551198765432")).toBe("5511998765432");
  });

  it("handles already correct format", () => {
    expect(normalizePhone("5521987654321")).toBe("5521987654321");
  });
});
