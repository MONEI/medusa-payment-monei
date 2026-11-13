import { describe, expect, it } from "vite-plus/test";
import { fromMinorUnits, toMinorUnits } from "../src/providers/monei/utils/amount";

describe("toMinorUnits", () => {
  it("converts 19.99 eur to 1999 EUR", () => {
    // Bugs: major units sent as cents charge 19.99 EUR as 0.20;
    // truncating 19.99 * 100 = 1998.999... gives 1998; a lowercase
    // currency lookup in Medusa's table misses every code.
    expect(toMinorUnits(19.99, "eur")).toEqual({ amount: 1999, currency: "EUR" });
  });

  it("rounds a half cent up", () => {
    // Bug: truncation or banker's rounding charges a cent less than the cart total.
    expect(toMinorUnits(19.995, "eur")).toEqual({ amount: 2000, currency: "EUR" });
  });

  it("refuses a zero-decimal currency", () => {
    // Bug: x100 on JPY charges a hundred times the price.
    expect(() => toMinorUnits(1000, "jpy")).toThrow(
      expect.objectContaining({ type: "invalid_data" }),
    );
  });

  it("refuses a zero amount", () => {
    expect(() => toMinorUnits(0, "eur")).toThrow(expect.objectContaining({ type: "invalid_data" }));
  });
});

describe("fromMinorUnits", () => {
  it("converts 1999 to 19.99", () => {
    // Bug: a webhook or status reporting cents makes Medusa record 100x the amount.
    expect(fromMinorUnits(1999, "EUR")).toBe(19.99);
  });
});
