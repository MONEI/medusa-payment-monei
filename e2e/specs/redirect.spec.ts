import { expect, test } from "@playwright/test";
import {
  CARDS,
  METHODS,
  answerThreeDsChallenge,
  checkoutToPayment,
  completeThreeDsChallengeIfShown,
  expectOrderConfirmed,
  payOnHostedPage,
  placeHostedOrder,
  uniqueEmail,
} from "../utils/checkout.ts";
import { PLUGIN_VERSION } from "../utils/env.ts";
import { adminFetch, ordersByEmail } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

/** The MONEI payment id in the hosted page URL. */
const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

/**
 * Hosted redirect checkout (MONEI-WooCommerce `classic-cc-single`). The default cart is
 * the 18.00 EUR product plus 4.50 EUR standard shipping.
 */
test.describe("hosted payment page", () => {
  test("pays with a card: MONEI charges the Medusa total and sees the plugin", async ({ page }) => {
    const email = uniqueEmail("redirect");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const paymentId = hostedPaymentId(page.url());

    await payOnHostedPage(page, CARDS.visaFrictionless);
    await completeThreeDsChallengeIfShown(page);
    const orderId = await expectOrderConfirmed(page);

    const payment = await getPayment(paymentId);
    expect(payment.status).toBe("SUCCEEDED");
    // 0.1.1 sent major units as cents: 22.50 EUR must reach MONEI as 2250.
    expect([payment.amount, payment.currency]).toEqual([2250, "EUR"]);
    expect(payment.traceDetails?.source).toBe("MONEI/Medusa");
    expect(payment.traceDetails?.sourceVersion).toBe(PLUGIN_VERSION);
    // The SDK type lacks `comment`, but the API returns it.
    expect((payment.traceDetails as { comment?: string } | undefined)?.comment).toMatch(
      /^Medusa v\d+\.\d+\.\d+; Node v\d+\.\d+\.\d+$/,
    );
    // A guest has no saved address: the storefront sends the cart's billing country.
    expect(payment.billingDetails?.address?.country).toBe("ES");

    const { order } = await adminFetch<{ order: any }>(
      `/admin/orders/${orderId}?fields=id,total,payment_status`,
    );
    expect(Math.round(order.total * 100)).toBe(payment.amount);
    expect(order.payment_status).toBe("captured");
    expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);
  });

  test("shows the 3DS challenge and completes the payment", async ({ page }) => {
    const email = uniqueEmail("challenge");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const paymentId = hostedPaymentId(page.url());

    await payOnHostedPage(page, CARDS.visaChallenge);
    // Always challenged: the helper fails when no challenge shows.
    await answerThreeDsChallenge(page, "complete");
    const orderId = await expectOrderConfirmed(page);

    expect((await getPayment(paymentId)).status).toBe("SUCCEEDED");
    expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);
  });

  test("a failed 3DS returns to the store with an error and no order; a retry pays", async ({
    page,
  }) => {
    const email = uniqueEmail("3ds-fail");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const failedId = hostedPaymentId(page.url());

    await payOnHostedPage(page, CARDS.visaChallenge);
    await answerThreeDsChallenge(page, "fail");

    // failUrl: the return page; MONEI appends the outcome to it.
    await page.waitForURL(/\/checkout\/monei\/return\?/);
    expect(new URL(page.url()).searchParams.get("status")).toBe("FAILED");
    await expect(page.getByTestId("monei-return-error")).toBeVisible();
    await expect(page.getByTestId("monei-return-error")).not.toContainText(/cancel/i);
    expect((await getPayment(failedId)).status).toBe("FAILED");
    expect(await ordersByEmail(email)).toEqual([]);

    // The cart is still payable: back to the payment step, a new MONEI payment pays.
    await page.getByTestId("monei-return-checkout-link").click();
    await expect(page).toHaveURL(/step=payment/);
    await placeHostedOrder(page, METHODS.card);
    const retryId = hostedPaymentId(page.url());
    expect(retryId).not.toBe(failedId);
    await payOnHostedPage(page, CARDS.visaFrictionless);
    await completeThreeDsChallengeIfShown(page);
    const orderId = await expectOrderConfirmed(page);

    expect((await getPayment(retryId)).status).toBe("SUCCEEDED");
    expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);
  });

  test("cancel on the hosted page returns to the store with no order", async ({ page }) => {
    const email = uniqueEmail("cancel");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);

    // MONEI's "Back to <merchant>" link is the cancelUrl.
    await page.locator('a[href*="monei_canceled=1"]').click();

    await page.waitForURL(/\/checkout\/monei\/return\?.*monei_canceled=1/);
    await expect(page.getByTestId("monei-return-error")).toContainText(/canceled/i);
    await expect(page.getByTestId("monei-return-checkout-link")).toBeVisible();
    expect(await ordersByEmail(email)).toEqual([]);
  });
});
