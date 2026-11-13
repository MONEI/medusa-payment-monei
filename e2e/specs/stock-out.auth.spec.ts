// Stock runs out while the buyer pays with `capture: false`. Core cart completion reserves
// stock before it authorizes, so no order is created and Medusa never voids the hold. The
// plugin re-checks the cart after `releaseUnorderedHoldsAfterMinutes` (1 in the e2e backend)
// and cancels the MONEI payment. A normal AUTH order past the delay keeps its hold.
import { stripVTControlCharacters } from "node:util";
import type { Page } from "@playwright/test";
import { expect, test } from "../utils/auth.ts";
import {
  CARDS,
  METHODS,
  PRODUCTS,
  answerThreeDsChallenge,
  cartIdOf,
  checkoutToPayment,
  payOnHostedPage,
  placeHostedOrder,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import {
  adminRequest,
  backendLog,
  orderPayments,
  ordersByEmail,
  setLimitedStock,
  waitForSubscriber,
} from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

// Callback (5 s event delay) + the 1 minute release delay + event bus polling.
const RELEASE_TIMEOUT_MS = 150_000;

test.describe.configure({ timeout: 360_000 });

test.afterEach(async () => {
  await setLimitedStock(1000);
});

async function waitForStatus(paymentId: string, status: string, timeout = 60_000) {
  await expect.poll(async () => (await getPayment(paymentId)).status, { timeout }).toBe(status);
}

/** The backend log line, without colours, that contains every one of `parts`. */
function logLine(...parts: string[]): string | undefined {
  return backendLog()
    .map((line) => stripVTControlCharacters(line))
    .find((line) => parts.every((part) => line.includes(part)));
}

/** Checkout of the managed-stock product; the stock is gone once the hosted page is open. */
async function payWhileStockRunsOut(page: Page, email: string) {
  await checkoutToPayment(page, { product: PRODUCTS.limited, email });
  await placeHostedOrder(page, METHODS.card);
  const paymentId = hostedPaymentId(page.url());
  const cartId = await cartIdOf(page.context());
  await setLimitedStock(0);
  return { paymentId, cartId };
}

async function expectHoldReleased(paymentId: string, cartId: string, email: string) {
  await waitForStatus(paymentId, "CANCELED", RELEASE_TIMEOUT_MS);
  expect(await ordersByEmail(email), "no order for the cart").toEqual([]);
  expect((await storeCart(cartId)).completed_at, "the cart stays open").toBeNull();
  // Core logs the failed completion as "[object Object]"; the plugin's line names the hold.
  expect(
    logLine("MONEI hold release:", paymentId, cartId),
    "the plugin logged which hold it released and why",
  ).toBeTruthy();
}

test("stock runs out while the buyer pays and returns: the hold is released", async ({ page }) => {
  const email = uniqueEmail("stock-out-auth-return");
  const { paymentId, cartId } = await payWhileStockRunsOut(page, email);

  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  await page.waitForURL(/\/checkout\/monei\/return/, { timeout: 60_000 });
  await waitForStatus(paymentId, "AUTHORIZED");

  await expectHoldReleased(paymentId, cartId, email);
});

test("stock runs out while the buyer pays and closes the tab: the hold is released", async ({
  page,
}) => {
  const email = uniqueEmail("stock-out-auth-closed");
  const { paymentId, cartId } = await payWhileStockRunsOut(page, email);

  // Only the callback tries to complete the cart.
  await page.route("**/checkout/monei/return**", (route) => route.abort());
  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  await waitForStatus(paymentId, "AUTHORIZED");
  await page.close();

  await expectHoldReleased(paymentId, cartId, email);
});

test("an AUTH order left uncaptured past the release delay keeps its hold", async ({
  page,
  context,
}) => {
  const email = uniqueEmail("hold-kept");
  await checkoutToPayment(page, { email });
  await placeHostedOrder(page, METHODS.card);
  const paymentId = hostedPaymentId(page.url());
  const cartId = await cartIdOf(context);

  await page.route("**/checkout/monei/return**", (route) => route.abort());
  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  await waitForStatus(paymentId, "AUTHORIZED");
  await page.close();

  await waitForSubscriber(async () => (await storeCart(cartId)).completed_at, {
    what: "the AUTHORIZED callback to complete the cart",
  });
  const [order] = await ordersByEmail(email);
  expect(order, "the callback placed an order").toBeTruthy();

  // Without this the test would also pass on a plugin that never re-checks a hold.
  await waitForSubscriber(async () => logLine("MONEI hold check:", paymentId, "kept"), {
    timeoutMs: RELEASE_TIMEOUT_MS,
    what: `the release re-check of payment ${paymentId}`,
  });
  expect((await getPayment(paymentId)).status, "the money is still held").toBe("AUTHORIZED");

  const [payment] = await waitForSubscriber(
    async () => {
      const payments = await orderPayments(order.id);
      return payments.length ? payments : undefined;
    },
    { what: "the order's payment" },
  );
  const capture = await adminRequest(`/admin/payments/${payment.id}/capture`, {});
  expect(capture.status, JSON.stringify(capture.body)).toBe(200);
  expect((await getPayment(paymentId)).status).toBe("SUCCEEDED");
});
