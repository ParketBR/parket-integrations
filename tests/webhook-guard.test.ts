import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module
vi.mock("../src/db/connection.js", () => {
  const insertedKeys = new Set<string>();

  return {
    db: {
      insertInto: () => ({
        values: (val: { idempotency_key: string }) => ({
          execute: async () => {
            if (insertedKeys.has(val.idempotency_key)) {
              const err = new Error("duplicate") as Error & { code: string };
              err.code = "23505";
              throw err;
            }
            insertedKeys.add(val.idempotency_key);
          },
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: async () => {},
          }),
        }),
      }),
    },
  };
});

// Import after mock
const { isNewWebhookEvent, markWebhookStatus } = await import(
  "../src/services/webhook-guard.js"
);

describe("webhook-guard", () => {
  it("allows first event through", async () => {
    const result = await isNewWebhookEvent(
      "meta_ads",
      "leadgen",
      "test_key_unique_1",
      { test: true }
    );
    expect(result).toBe(true);
  });

  it("blocks duplicate event", async () => {
    await isNewWebhookEvent("meta_ads", "leadgen", "test_key_dup", {
      test: true,
    });

    const result = await isNewWebhookEvent("meta_ads", "leadgen", "test_key_dup", {
      test: true,
    });
    expect(result).toBe(false);
  });

  it("markWebhookStatus does not throw", async () => {
    await expect(
      markWebhookStatus("any_key", "processed")
    ).resolves.not.toThrow();
  });
});
