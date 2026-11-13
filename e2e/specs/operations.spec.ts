import { stripVTControlCharacters } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  CARDS,
  METHODS,
  SHIPPING,
  answerThreeDsChallenge,
  cartIdOf,
  checkoutToPayment,
  completeThreeDsChallengeIfShown,
  expectOrderConfirmed,
  payOnHostedPage,
  placeHostedOrder,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import { fixtures } from "../utils/env.ts";
import {
  adminFetch,
  adminRequest,
  adminToken,
  backendLog,
  eventJobsMentioning,
  medusaFetch,
  orderPayments,
  ordersByEmail,
  readBackendLog,
  waitForSubscriber,
} from "../utils/medusa.ts";
import { getPayment, moneiClient } from "../utils/monei.ts";

const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

/** An 18.00 EUR order (free shipping) paid on the hosted page; MONEI holds 1800. */
async function paidOrder(page: Page, tag: string) {
  await checkoutToPayment(page, { email: uniqueEmail(tag), shipping: SHIPPING.free });
  await placeHostedOrder(page, METHODS.card);
  const moneiId = hostedPaymentId(page.url());
  await payOnHostedPage(page, CARDS.visaFrictionless);
  await completeThreeDsChallengeIfShown(page);
  const orderId = await expectOrderConfirmed(page);
  const [payment] = await orderPayments(orderId);
  expect([payment.amount, (await getPayment(moneiId)).amount]).toEqual([18, 1800]);
  return { moneiId, paymentId: payment.id };
}

/** Refunds Medusa keeps on the payment (a failed provider call soft-deletes its row). */
async function medusaRefunds(paymentId: string): Promise<number[]> {
  const { payment } = await adminFetch<{ payment: { refunds: { amount: number }[] } }>(
    `/admin/payments/${paymentId}?fields=id,*refunds`,
  );
  return payment.refunds.map((refund) => refund.amount);
}

const refundPath = (paymentId: string) => `/admin/payments/${paymentId}/refund`;

test.describe("post-payment operations", () => {
  test("a full refund from the admin refunds the MONEI payment", async ({ page }) => {
    const { moneiId, paymentId } = await paidOrder(page, "refund-full");

    const refund = await adminRequest(refundPath(paymentId), {});
    expect(refund.status, JSON.stringify(refund.body)).toBe(200);

    const payment = await getPayment(moneiId);
    expect([payment.status, payment.refundedAmount]).toEqual(["REFUNDED", 1800]);
    expect(await medusaRefunds(paymentId)).toEqual([18]);
  });

  test("two equal partial refunds sent back to back: the second is refused", async ({ page }) => {
    const { moneiId, paymentId } = await paidOrder(page, "refund-dedupe");

    // One login up front: nothing may sit between the two refunds.
    const token = await adminToken();
    const first = await adminRequest(refundPath(paymentId), { amount: 9 }, token);
    const second = await adminRequest(refundPath(paymentId), { amount: 9 }, token);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    // The plugin's timing line (monei-base.ts refundPayment), one per refund POST.
    const lines = readBackendLog(new RegExp(`MONEI refund POST: payment=${moneiId} `)).map((line) =>
      stripVTControlCharacters(line),
    );
    expect(lines).toHaveLength(2);
    const at = (line: string, key: string) =>
      Date.parse(line.match(new RegExp(`${key}=(\\S+)`))![1]);
    const firstAnswered = at(lines[0], "answered_at");
    const secondSent = at(lines[1], "sent_at");

    const payment = await getPayment(moneiId);
    const refunds = await medusaRefunds(paymentId);
    const medusaTotal = refunds.reduce((sum, amount) => sum + amount, 0);
    expect(Math.round(medusaTotal * 100)).toBe(payment.refundedAmount ?? 0);

    // Past the gate the two refunds may be too far apart to merge.
    // A slow runner proves only the totals above.
    const gap = secondSent - firstAnswered;
    if (gap > 2_000) {
      const reason =
        `Inconclusive: the second refund POST left ${gap} ms after MONEI answered the first ` +
        `(gate 2000 ms)`;
      // The list reporter does not print skip reasons.
      console.warn(reason);
      test.skip(true, reason);
    }
    expect(second.status, JSON.stringify(second.body)).toBe(500);
    expect(second.body.message).toContain("MONEI did not apply the refund of 900 EUR");
    expect(refunds).toEqual([9]);
    expect([payment.status, payment.refundedAmount]).toEqual(["PARTIALLY_REFUNDED", 900]);
  });

  test("after a partial refund in the MONEI dashboard, a full refund from the admin is refused", async ({
    page,
  }) => {
    const { moneiId, paymentId } = await paidOrder(page, "refund-dashboard");
    // Not synced to Medusa: its own guard still sees 18.00 refundable.
    await moneiClient().payments.refund(moneiId, { amount: 900 });

    const refund = await adminRequest(refundPath(paymentId), {});
    expect(refund.status, JSON.stringify(refund.body)).toBe(400);
    expect(refund.body.message).toContain(
      "The amount to be refunded exceeds the payment amount: requested 1800, not yet refunded 900",
    );

    expect(await medusaRefunds(paymentId)).toEqual([]);
    const payment = await getPayment(moneiId);
    expect([payment.status, payment.refundedAmount]).toEqual(["PARTIALLY_REFUNDED", 900]);
  });

  test("a cart change while the hosted page is open cancels the old payment, which cannot be paid", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("cart-change");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const moneiId = hostedPaymentId(page.url());
    const cartId = await cartIdOf(context);

    // The shopper changes the cart in another tab; Medusa deletes the session.
    await medusaFetch(`/store/carts/${cartId}`, {
      body: { promo_codes: [fixtures().promotionCode] },
    });
    await expect
      .poll(async () => (await getPayment(moneiId)).status, { timeout: 30_000 })
      .toBe("CANCELED");

    // The open page still shows the form; MONEI refuses to tokenize the card for it.
    const tokenResponse = page.waitForResponse(
      (response) =>
        response.url().startsWith("https://api.monei.com/v1/tokens") &&
        response.request().method() === "POST",
    );
    await payOnHostedPage(page, CARDS.visaFrictionless);
    const tokens = await tokenResponse;
    expect(tokens.status()).toBe(400);
    expect((await tokens.json()).message).toBe(
      "Cannot generate token if payment is pending provider or already processed",
    );

    expect((await getPayment(moneiId)).status).toBe("CANCELED");
    expect((await storeCart(cartId)).completed_at).toBeNull();
    expect(await ordersByEmail(email)).toEqual([]);
    expect(readBackendLog(new RegExp(`could not cancel payment ${moneiId}`))).toEqual([]);
  });

  test("a payment completed after its session was deleted is reported, and its callback reaches no cart", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("deleted-session");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const moneiId = hostedPaymentId(page.url());
    const cartId = await cartIdOf(context);
    // Only the callback may act on this payment.
    await page.route("**/checkout/monei/return**", (route) => route.abort());

    // A payment in a 3DS challenge cannot be canceled, so it stays payable.
    await payOnHostedPage(page, CARDS.visaChallenge);
    await expect(page.getByTestId("complete-button")).toBeVisible({ timeout: 60_000 });
    await medusaFetch(`/store/carts/${cartId}`, {
      body: { promo_codes: [fixtures().promotionCode] },
    });
    await waitForSubscriber(
      async () => readBackendLog(new RegExp(`could not cancel payment ${moneiId}`)).length > 0,
      { what: `the refused cancel of payment ${moneiId}` },
    );
    const from = backendLog().length;

    await answerThreeDsChallenge(page, "complete");
    await expect
      .poll(async () => (await getPayment(moneiId)).status, { timeout: 60_000 })
      .toBe("SUCCEEDED");
    await waitForSubscriber(
      async () => readBackendLog(new RegExp(`MONEI orphan payment: payment ${moneiId}`)).length,
      { what: `the orphan report of payment ${moneiId}` },
    );
    // The job is gone only when every subscriber succeeded (a failed one keeps it).
    await waitForSubscriber(async () => eventJobsMentioning(moneiId) === 0, {
      what: `every subscriber of the callback of payment ${moneiId} to succeed`,
    });

    const lines = backendLog()
      .slice(from)
      .map((line) => stripVTControlCharacters(line))
      .filter((line) => /^(warn|error):/.test(line) || /^info:\s+Retrying /.test(line));
    // Only the plugin's ignore warning and the orphan report may appear: core must
    // never act on this callback.
    for (const line of lines) {
      expect(line).toMatch(
        new RegExp(
          `^warn:\\s+MONEI webhook ignored: payment ${moneiId}: session payses_\\w+ no longer exists$|^error:\\s+MONEI orphan payment: payment ${moneiId} `,
        ),
      );
    }
    expect(lines.some((line) => line.includes("MONEI webhook ignored"))).toBe(true);
    expect((await storeCart(cartId)).completed_at).toBeNull();
    expect(await ordersByEmail(email)).toEqual([]);
  });
});
