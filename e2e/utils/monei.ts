import { Monei, type Payment } from "@monei-js/node-sdk";
import { moneiApiKey } from "./env.ts";

/**
 * Methods every spec family needs on the test account. MB WAY and Multibanco have no
 * test processor in production, so they are not required (unit tests cover them).
 */
export const REQUIRED_METHODS = ["card", "paypal", "bizum", "applePay", "googlePay"];

let client: Monei | undefined;

export function moneiClient(): Monei {
  client ??= new Monei(moneiApiKey());
  return client;
}

export const getPayment = (id: string): Promise<Payment> => moneiClient().payments.get(id);

// Describes a refused key without printing it.
function keyShape(raw: string): string {
  return `${raw.trim().length} chars${raw !== raw.trim() ? ", with surrounding whitespace" : ""}`;
}

/**
 * The guards from MONEI-WooCommerce `seed.js`, plus the method check: the key works,
 * is a test mode key, belongs to MONEI_TEST_ACCOUNT_ID when that is set, and the
 * account offers every required method. `getAllowed` authenticates with the key, so
 * the answer does not depend on the runner's GeoIP country.
 */
export async function checkTestAccount(): Promise<{ accountId: string }> {
  const apiKey = moneiApiKey();
  let allowed: Awaited<ReturnType<Monei["paymentMethods"]["getAllowed"]>>;
  try {
    allowed = await moneiClient().paymentMethods.getAllowed();
  } catch (error) {
    // Only message and status: an axios error dump carries the Authorization header.
    const { message, statusCode } = error as { message?: string; statusCode?: number };
    throw new Error(
      `MONEI refused MONEI_TEST_API_KEY (${keyShape(process.env.MONEI_TEST_API_KEY ?? apiKey)}): ` +
        `${statusCode ?? "no status"} ${message ?? "unknown error"}`,
    );
  }

  if (allowed.livemode) {
    throw new Error(
      "MONEI_TEST_API_KEY is a live mode key. The suite takes real payments, so it must only hold a test mode key.",
    );
  }

  const accountId = allowed.accountId ?? "";
  const declared = (process.env.MONEI_TEST_ACCOUNT_ID ?? "").trim();
  if (declared && declared !== accountId) {
    throw new Error(
      `MONEI_TEST_ACCOUNT_ID is ${declared} but MONEI_TEST_API_KEY belongs to ${accountId}.`,
    );
  }

  const missing = REQUIRED_METHODS.filter((method) => !allowed.paymentMethods.includes(method));
  if (missing.length) {
    throw new Error(`The MONEI test account ${accountId} does not offer: ${missing.join(", ")}`);
  }
  return { accountId };
}
