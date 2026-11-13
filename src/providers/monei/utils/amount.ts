import type { BigNumberInput } from "@medusajs/framework/types";
import { defaultCurrencies, MathBN, MedusaError } from "@medusajs/framework/utils";

function assertTwoDecimals(currency: string): string {
  const code = currency.toUpperCase();
  if (defaultCurrencies[code]?.decimal_digits !== 2) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `MONEI supports only currencies with 2 decimals, got "${currency}"`,
    );
  }
  return code;
}

/** Medusa major units (`19.99`, lowercase `eur`) to the MONEI request (`1999`, `EUR`). */
export function toMinorUnits(
  amount: BigNumberInput,
  currency: string,
): { amount: number; currency: string } {
  const code = assertTwoDecimals(currency);
  const minor = MathBN.convert(MathBN.mult(amount, 100), 0).toNumber();
  // Also refuses negatives, sub-cent amounts that round to 0, and NaN.
  if (!(minor > 0)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Payment amount must be greater than 0, got ${String(amount)} ${code}`,
    );
  }
  return { amount: minor, currency: code };
}

/** MONEI minor units (`1999`) to Medusa major units (`19.99`). */
export function fromMinorUnits(amount: number, currency: string): number {
  assertTwoDecimals(currency);
  return MathBN.div(amount, 100).toNumber();
}
