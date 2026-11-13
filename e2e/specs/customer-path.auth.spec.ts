// The path of a store that runs hosted card payments with `capture: false`, its own
// storefront and no MONEI dashboard webhook, end to end on the Medusa version the stack
// runs (MEDUSA_VERSION; CI also runs the lowest supported one). Stock running out during
// payment on this path is stock-out.auth.spec.ts, in the same project.
import type { Page } from "@playwright/test";
import { expect, test } from "../utils/auth.ts";
import {
  CARDS,
  METHODS,
  answerThreeDsChallenge,
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  payOnHostedPage,
  placeHostedOrder,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import { PLUGIN_VERSION, medusaVersion } from "../utils/env.ts";
import {
  adminFetch,
  adminRequest,
  orderPayments,
  ordersByEmail,
  waitForSubscriber,
} from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The order's only Medusa payment; core creates it after it marks the cart completed. */
async function onlyPayment(orderId: string) {
  const payments = await waitForSubscriber(
    async () => {
      const found = await orderPayments(orderId);
      return found.length ? found : undefined;
    },
    { what: "the order's payment" },
  );
  expect(payments, "one Medusa payment").toHaveLength(1);
  return payments[0];
}

async function paymentDates(paymentId: string) {
  const { payment } = await adminFetch<{
    payment: { captured_at: string | null; canceled_at: string | null };
  }>(`/admin/payments/${paymentId}?fields=id,captured_at,canceled_at`);
  return payment;
}

/** 18.00 EUR product + 4.50 EUR standard shipping, paid on the hosted page with 3DS. */
async function payHosted(page: Page, email: string) {
  await checkoutToPayment(page, { email });
  await placeHostedOrder(page, METHODS.card);
  const moneiId = hostedPaymentId(page.url());
  const cartId = await cartIdOf(page.context());
  return { moneiId, cartId };
}

test("the buyer returns: order, admin capture, then a full refund", async ({ page }) => {
  const email = uniqueEmail("customer-return");
  const { moneiId } = await payHosted(page, email);
  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  const orderId = await expectOrderConfirmed(page);
  expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);

  const held = await getPayment(moneiId);
  expect([held.status, held.amount, held.currency]).toEqual(["AUTHORIZED", 2250, "EUR"]);
  expect(held.traceDetails?.source).toBe("MONEI/Medusa");
  expect(held.traceDetails?.sourceVersion).toBe(PLUGIN_VERSION);
  // The SDK type lacks `comment`, but the API returns it. The version is the one the stack
  // was started with, so a backend that silently ran another Medusa fails here.
  expect((held.traceDetails as { comment?: string } | undefined)?.comment).toMatch(
    new RegExp(`^Medusa v${escapeRegExp(medusaVersion())}; Node v\\d+\\.\\d+\\.\\d+$`),
  );

  const payment = await onlyPayment(orderId);
  expect(payment.captured_at, "an authorized payment is not captured").toBeNull();

  const capture = await adminRequest(`/admin/payments/${payment.id}/capture`, {});
  expect(capture.status, JSON.stringify(capture.body)).toBe(200);
  expect((await getPayment(moneiId)).status).toBe("SUCCEEDED");
  expect(
    (await paymentDates(payment.id)).captured_at,
    "Medusa recorded the capture",
  ).not.toBeNull();

  const refund = await adminRequest(`/admin/payments/${payment.id}/refund`, {});
  expect(refund.status, JSON.stringify(refund.body)).toBe(200);
  const refunded = await getPayment(moneiId);
  expect([refunded.status, refunded.refundedAmount]).toEqual(["REFUNDED", 2250]);
});

test("the buyer closes the tab: the callback places the order, canceling it voids the hold", async ({
  page,
}) => {
  const email = uniqueEmail("customer-closed");
  const { moneiId, cartId } = await payHosted(page, email);

  // No return page and no dashboard webhook: only the payment's callbackUrl completes the cart.
  await page.route("**/checkout/monei/return**", (route) => route.abort());
  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  await expect
    .poll(async () => (await getPayment(moneiId)).status, { timeout: 60_000 })
    .toBe("AUTHORIZED");
  await page.close();

  await waitForSubscriber(async () => (await storeCart(cartId)).completed_at, {
    what: "the AUTHORIZED callback to complete the cart",
  });
  const orders = await ordersByEmail(email);
  expect(orders, "exactly one order").toHaveLength(1);
  const payment = await onlyPayment(orders[0].id);

  // cancelOrderWorkflow cancels payments without captures. Its cancel step only logs a
  // provider error, so the 200 alone proves nothing.
  const cancel = await adminRequest(`/admin/orders/${orders[0].id}/cancel`, {});
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
  expect((await getPayment(moneiId)).status).toBe("CANCELED");
  expect((await paymentDates(payment.id)).canceled_at, "Medusa recorded the void").not.toBeNull();
});
