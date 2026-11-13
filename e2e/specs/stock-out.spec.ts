// Stock runs out while the buyer pays with SALE. The callback captures, core cart
// completion fails at the stock reservation, and core refunds the payment and gives the
// cart a new session, so the buyer can pay again once the product is back in stock.
import { expect, test } from "@playwright/test";
import {
  CARDS,
  COUNTRY,
  METHODS,
  PRODUCTS,
  answerThreeDsChallenge,
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  moneiSession,
  payOnHostedPage,
  placeHostedOrder,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import { ordersByEmail, setLimitedStock } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

test.describe.configure({ timeout: 300_000 });

test.afterEach(async () => {
  await setLimitedStock(1000);
});

test("stock runs out while the buyer pays and closes the tab: refunded, and the buyer can pay again", async ({
  page,
  context,
}) => {
  const email = uniqueEmail("stock-out-sale");
  await checkoutToPayment(page, { product: PRODUCTS.limited, email });
  await placeHostedOrder(page, METHODS.card);
  const paymentId = hostedPaymentId(page.url());
  const cartId = await cartIdOf(context);
  const firstSession = await moneiSession(cartId);
  await setLimitedStock(0);

  // Only the callback runs cart completion, and with it core's refund.
  await page.route("**/checkout/monei/return**", (route) => route.abort());
  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  await expect
    .poll(async () => (await getPayment(paymentId)).status, { timeout: 120_000 })
    .toBe("REFUNDED");
  await page.close();

  expect(await ordersByEmail(email), "no order for the cart").toEqual([]);
  expect((await storeCart(cartId)).completed_at, "the cart stays open").toBeNull();
  const newSession = await moneiSession(cartId);
  expect(newSession.id, "core gave the cart a new session").not.toBe(firstSession.id);

  await setLimitedStock(1000);
  const again = await context.newPage();
  await again.goto(`/${COUNTRY}/checkout?step=payment`);
  await placeHostedOrder(again, METHODS.card);
  const secondPaymentId = hostedPaymentId(again.url());
  expect(secondPaymentId).not.toBe(paymentId);
  await payOnHostedPage(again, CARDS.visaChallenge);
  await answerThreeDsChallenge(again, "complete");
  const orderId = await expectOrderConfirmed(again);

  expect((await ordersByEmail(email)).map((o) => o.id)).toEqual([orderId]);
  expect((await getPayment(secondPaymentId)).status).toBe("SUCCEEDED");
  expect((await getPayment(paymentId)).status, "the first payment stays refunded").toBe("REFUNDED");
});
