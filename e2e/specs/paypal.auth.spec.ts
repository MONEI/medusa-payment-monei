// Embedded PayPal with `capture: false`: the storefront reads the capture mode from
// GET /store/monei/config and mounts PayPal with transactionType AUTH. monei.js loads the
// PayPal SDK with intent=capture otherwise, and a capture order cannot pay an AUTH payment.
import { expect, test } from "../utils/auth.ts";
import {
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  uniqueEmail,
} from "../utils/checkout.ts";
import {
  PROVIDERS,
  continueToReview,
  selectPaymentMethod,
  useEmbeddedCheckout,
  waitForMoneiSession,
} from "../utils/embedded.ts";
import { orderPayments } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";
import { PAYPAL_ACCOUNTS, payWithPayPal } from "../utils/paypal.ts";

// The PayPal sandbox is unstable (the paypal project retries the same way).
test.describe.configure({ retries: process.env.CI ? 1 : 0 });

test("PayPal mounts with the authorize intent and holds the money", async ({ page, context }) => {
  await useEmbeddedCheckout(context);
  const intents: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname.endsWith("paypal.com") && url.pathname === "/sdk/js") {
      intents.push(url.searchParams.get("intent") ?? "");
    }
  });

  await checkoutToPayment(page, { email: uniqueEmail("emb-paypal-auth") });
  await selectPaymentMethod(page, "PayPal");
  const session = await waitForMoneiSession(await cartIdOf(context), PROVIDERS.paypal);
  await continueToReview(page);

  await payWithPayPal(page, PAYPAL_ACCOUNTS.personal);
  const orderId = await expectOrderConfirmed(page);

  expect(intents, "the PayPal SDK was loaded").not.toHaveLength(0);
  expect(new Set(intents), "every PayPal SDK load used the authorize intent").toEqual(
    new Set(["authorize"]),
  );
  expect((await getPayment(session.data.id)).status).toBe("AUTHORIZED");
  const [payment] = await orderPayments(orderId);
  expect(payment.captured_at, "an authorized PayPal payment is not captured").toBeNull();
});
