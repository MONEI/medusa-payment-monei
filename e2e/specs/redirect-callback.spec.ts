import { stripVTControlCharacters } from "node:util";
import { expect, test } from "@playwright/test";
import {
  CARDS,
  METHODS,
  PRODUCTS,
  SHIPPING,
  answerThreeDsChallenge,
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  moneiSession,
  payBizumOnHostedPage,
  payOnHostedPage,
  placeHostedOrder,
  returnUrl,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import {
  backendLog,
  eventJobsMentioning,
  ordersByEmail,
  waitForSubscriber,
} from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

/** Index of the e2e backend subscriber's line for this payment's callback, or -1. */
const webhookLine = (lines: string[], paymentId: string) =>
  lines.findIndex((line) => line.includes(`E2E webhook event:`) && line.includes(paymentId));

async function waitForStatus(paymentId: string, status: string) {
  await expect
    .poll(async () => (await getPayment(paymentId)).status, { timeout: 60_000 })
    .toBe(status);
}

/**
 * The callback and the return page both try to complete the cart (core
 * `processPaymentWorkflow` and `cart.complete`). Whichever comes first, there is
 * exactly one order and the return page shows it.
 */
test.describe("hosted payment page: callback and return races", () => {
  test("the buyer pays and closes the tab: the callback places the order, the return URL shows it", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("closed-tab");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const paymentId = hostedPaymentId(page.url());
    const cartId = await cartIdOf(context);
    const session = await moneiSession(cartId);

    // The buyer never reaches the return page.
    await page.route("**/checkout/monei/return**", (route) => route.abort());
    await payOnHostedPage(page, CARDS.visaChallenge);
    await answerThreeDsChallenge(page, "complete");
    await waitForStatus(paymentId, "SUCCEEDED");
    await page.close();

    await waitForSubscriber(async () => (await storeCart(cartId)).completed_at, {
      what: "the callback to complete the cart",
    });
    const [order] = await ordersByEmail(email);
    expect(order, "the callback placed an order").toBeTruthy();

    const later = await context.newPage();
    await later.goto(returnUrl(cartId, session.id));
    expect(await expectOrderConfirmed(later)).toBe(order.id);
    expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([order.id]);
  });

  test("the buyer returns first: the late callback adds no order and no error", async ({
    page,
  }) => {
    const email = uniqueEmail("late-callback");
    await checkoutToPayment(page, { email });
    await placeHostedOrder(page, METHODS.card);
    const paymentId = hostedPaymentId(page.url());

    await payOnHostedPage(page, CARDS.visaChallenge);
    await answerThreeDsChallenge(page, "complete");
    const orderId = await expectOrderConfirmed(page);

    // Inconclusive, not passed, when the callback was processed before the return.
    expect(
      webhookLine(backendLog(), paymentId),
      "the callback was processed before the buyer returned; the race was not exercised",
    ).toBe(-1);

    const lines = await waitForSubscriber(
      async () => {
        const log = backendLog();
        return webhookLine(log, paymentId) >= 0 && log;
      },
      { what: `the callback of payment ${paymentId}` },
    );
    const from = webhookLine(lines, paymentId);
    // The core and plugin subscribers run alongside the logging one: wait until the
    // job is gone, which means all of them succeeded (a failed one keeps it).
    await waitForSubscriber(async () => eventJobsMentioning(paymentId) === 0, {
      what: `every subscriber of the callback of payment ${paymentId} to succeed`,
    });

    const after = backendLog()
      .slice(from)
      .map((line) => stripVTControlCharacters(line));
    // The Redis event bus logs a failed subscriber at warn and retries it; the plugin
    // warns on an ignored callback. Nothing else logs in this window.
    expect(
      after.filter((line) => /^(warn|error):/.test(line) || /^info:\s+Retrying /.test(line)),
    ).toEqual([]);
    expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);
  });

  test("the return page left on processing shows the order once the Bizum callback places it", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("bizum-processing");
    // 2.50 EUR: Bizum test approval needs at most 5 EUR.
    await checkoutToPayment(page, { product: PRODUCTS.sticker, shipping: SHIPPING.free, email });
    await placeHostedOrder(page, METHODS.bizum);
    const cartId = await cartIdOf(context);
    const session = await moneiSession(cartId);

    const returnPage = await context.newPage();
    await returnPage.goto(returnUrl(cartId, session.id));
    await expect(returnPage.getByTestId("monei-return-processing")).toBeVisible();

    // The buyer approves in the bank app; the hosted page tab is gone.
    await payBizumOnHostedPage(page);
    await page.close();

    const orderId = await expectOrderConfirmed(returnPage);
    expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);
  });

  test("a rejected Bizum request turns the open return page from processing into the error", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("bizum-rejected");
    // 7.00 EUR: above 5 EUR the Bizum test processor declines the request.
    await checkoutToPayment(page, {
      product: PRODUCTS.sticker,
      shipping: SHIPPING.standard,
      email,
    });
    await placeHostedOrder(page, METHODS.bizum);
    const paymentId = hostedPaymentId(page.url());
    const cartId = await cartIdOf(context);
    const session = await moneiSession(cartId);

    const returnPage = await context.newPage();
    await returnPage.goto(returnUrl(cartId, session.id));
    await expect(returnPage.getByTestId("monei-return-processing")).toBeVisible();

    await payBizumOnHostedPage(page);
    await page.close();

    await expect(returnPage.getByTestId("monei-return-error")).toBeVisible({ timeout: 60_000 });
    await expect(returnPage.getByTestId("monei-return-checkout-link")).toBeVisible();
    expect((await getPayment(paymentId)).status).toBe("FAILED");
    expect(await ordersByEmail(email)).toEqual([]);
  });
});
