import { createHmac } from "node:crypto";
import { MoneiBase } from "../src/providers/monei/core/monei-base";

export class TestProvider extends MoneiBase {
  static identifier = "monei";
  protected allowedPaymentMethods = ["card"];
  protected authAllowed = true;
}

export const moneiError = (statusCode: number) => ({
  status: "ERROR",
  statusCode,
  requestId: "req_123",
  message: "Something failed",
  requestTime: "2026-11-12T10:00:00.000Z",
});

export const API_KEY = "pk_test_x";
export const T = "1762970000";

// Computed independently of the SDK: `t=<ts>,v1=hex(HMAC-SHA256(apiKey, "<ts>.<body>"))`.
export const hmac = (raw: string, key = API_KEY) =>
  createHmac("sha256", key).update(`${T}.${raw}`).digest("hex");
export const sign = (raw: string, key = API_KEY) => `t=${T},v1=${hmac(raw, key)}`;

type GraphConfig = { entity: string; fields: string[]; filters: Record<string, unknown> };

/** A `query.graph` fake that returns only the requested fields, so a field missing from a query shows up. */
export const fakeGraph =
  (tables: Record<string, Record<string, unknown>[]>) =>
  async ({ entity, fields, filters }: GraphConfig) => {
    const keys = fields.map((field) => field.split(".")[0]);
    return {
      data: tables[entity]
        .filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value))
        .map((row) => Object.fromEntries(keys.map((key) => [key, row[key]]))),
    };
  };
