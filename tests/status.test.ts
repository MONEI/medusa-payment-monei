import { describe, expect, it, vi } from "vite-plus/test";
import { toSessionStatus, toWebhookAction } from "../src/providers/monei/utils/status";

const logger = () => ({ warn: vi.fn() });

describe("toSessionStatus", () => {
  it.each([
    ["AUTHORIZED", "authorized"],
    ["SUCCEEDED", "captured"],
    ["PENDING", "pending"],
    // MONEI sends no EXPIRED callback; a re-fetch must still end the session.
    ["EXPIRED", "error"],
  ])("maps %s to %s", (status, expected) => {
    expect(toSessionStatus(status, logger())).toBe(expected);
  });

  it("keeps REFUNDED captured for status", () => {
    // Bug: a refunded order's payment reported as error; authorize maps it to error itself.
    expect(toSessionStatus("REFUNDED", logger())).toBe("captured");
  });

  it("treats an unknown status as pending and warns", () => {
    // Bug: a new MONEI status mapped to error or captured ends the session wrongly.
    const log = logger();

    expect(toSessionStatus("PENDING_PROCESSING", log)).toBe("pending");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("PENDING_PROCESSING"));
  });
});

describe("toWebhookAction", () => {
  it.each([
    ["AUTHORIZED", "authorized"],
    ["SUCCEEDED", "captured"],
    ["CANCELED", "failed"],
    ["PENDING", "pending"],
    // Bug: a refund callback mapped to captured re-runs order completion.
    ["REFUNDED", "not_supported"],
  ])("maps %s to %s", (status, expected) => {
    expect(toWebhookAction(status)).toBe(expected);
  });
});
