// Hosted payment page with `capture: false`: the AUTHORIZED callback alone places the order
// (core processPaymentWorkflow), and the money stays held.
import { expect, test } from "../utils/auth.ts";
import {
  CARDS,
  METHODS,
  answerThreeDsChallenge,
  cartIdOf,
  checkoutToPayment,
  payOnHostedPage,
  placeHostedOrder,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import { ordersByEmail, orderPayments, waitForSubscriber } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const hostedPaymentId = (url: string) => url.match(/secure\.monei\.com\/payments\/([^/?#]+)/)![1];

test("the AUTHORIZED callback places the order when the buyer never returns", async ({
  page,
  context,
}) => {
  const email = uniqueEmail("hosted-auth");
  await checkoutToPayment(page, { email });
  await placeHostedOrder(page, METHODS.card);
  const paymentId = hostedPaymentId(page.url());
  const cartId = await cartIdOf(context);

  // The buyer never reaches the return page, so only the callback can complete the cart.
  await page.route("**/checkout/monei/return**", (route) => route.abort());
  await payOnHostedPage(page, CARDS.visaChallenge);
  await answerThreeDsChallenge(page, "complete");
  await expect
    .poll(async () => (await getPayment(paymentId)).status, { timeout: 60_000 })
    .toBe("AUTHORIZED");
  await page.close();

  await waitForSubscriber(async () => (await storeCart(cartId)).completed_at, {
    what: "the AUTHORIZED callback to complete the cart",
  });
  const orders = await ordersByEmail(email);
  expect(orders, "exactly one order").toHaveLength(1);
  // Core completeCartWorkflow sets completed_at before authorizePaymentSessionStep
  // creates the payment.
  const [payment] = await waitForSubscriber(
    async () => {
      const payments = await orderPayments(orders[0].id);
      return payments.length ? payments : undefined;
    },
    { what: "the order's payment" },
  );
  expect(payment.captured_at, "an authorized payment is not captured").toBeNull();
  expect((await getPayment(paymentId)).status, "the money is still held").toBe("AUTHORIZED");
});
