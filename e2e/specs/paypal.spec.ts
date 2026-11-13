// Embedded PayPal: the monei.js PayPal button, mounted with the session's MONEI payment
// id, against the real PayPal sandbox.
import { expect, test } from "@playwright/test";
import {
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import {
  PROVIDERS,
  continueToReview,
  selectPaymentMethod,
  useEmbeddedCheckout,
  waitForMoneiSession,
} from "../utils/embedded.ts";
import { ordersByEmail } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";
import { PAYPAL_ACCOUNTS, closePayPalPopup, payWithPayPal } from "../utils/paypal.ts";

test.describe("embedded PayPal", () => {
  test.beforeEach(async ({ context }) => useEmbeddedCheckout(context));

  test("pays with the PayPal sandbox", async ({ page, context }) => {
    const email = uniqueEmail("emb-paypal");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, "PayPal");
    const session = await waitForMoneiSession(await cartIdOf(context), PROVIDERS.paypal);
    await continueToReview(page);

    await payWithPayPal(page, PAYPAL_ACCOUNTS.personal);
    await expectOrderConfirmed(page);

    const payment = await getPayment(session.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.amount).toBe(2250);
    expect(payment.paymentMethod?.paypal?.email).toBe(PAYPAL_ACCOUNTS.personal.email);
    expect(await ordersByEmail(email)).toHaveLength(1);
  });

  test("buyer closes the PayPal popup: message, no order, the retry pays", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("emb-paypal-close");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, "PayPal");
    const cartId = await cartIdOf(context);
    const session = await waitForMoneiSession(cartId, PROVIDERS.paypal);
    await continueToReview(page);
    const message = page.getByTestId("monei-payment-error-message");
    await expect(message).toBeHidden();

    await closePayPalPopup(page);

    await expect(message).toContainText("PayPal window was closed");
    await expect(page).toHaveURL(/\/checkout\?step=review/);
    expect(await ordersByEmail(email)).toHaveLength(0);
    expect((await getPayment(session.data.id)).status).toBe("PENDING");
    const cart = await storeCart(cartId);
    expect(cart.completed_at).toBeFalsy();
    // Still payable with the same session and MONEI payment.
    expect(await waitForMoneiSession(cartId, PROVIDERS.paypal)).toMatchObject({
      id: session.id,
      data: { id: session.data.id },
    });

    await payWithPayPal(page, PAYPAL_ACCOUNTS.personal);
    await expectOrderConfirmed(page);
    expect((await getPayment(session.data.id)).status).toBe("SUCCEEDED");
    expect(await ordersByEmail(email)).toHaveLength(1);
  });
});
