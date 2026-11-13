// Express PayPal (MONEI-WooCommerce `paypal-express`): the monei.js PayPal button mounted
// with the account id and the express cart as monei.js session, against the PayPal sandbox.
import { expect, test } from "@playwright/test";
import {
  COUNTRY,
  PRODUCTS,
  addToCart,
  cartIdOf,
  expectOrderConfirmed,
  moneiSession,
} from "../utils/checkout.ts";
import { PROVIDERS } from "../utils/embedded.ts";
import { expressMount, openProductExpress, useExpressCheckout } from "../utils/express.ts";
import { adminFetch } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";
import { PAYPAL_ACCOUNTS, payWithPayPal } from "../utils/paypal.ts";

test.describe("express PayPal", () => {
  test.beforeEach(async ({ context }) => useExpressCheckout(context));

  test("product page PayPal express pays", async ({ page }) => {
    const mount = await openProductExpress(page, PRODUCTS.tshirt);

    await payWithPayPal(page, PAYPAL_ACCOUNTS.personal);
    const orderId = await expectOrderConfirmed(page);

    const session = await moneiSession(mount.cartId);
    expect(session).toMatchObject({ provider_id: PROVIDERS.paypal });
    const payment = await getPayment(session.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.amount).toBe(mount.amount);
    expect(payment.paymentMethod?.paypal?.email).toBe(PAYPAL_ACCOUNTS.personal.email);
    // PayPal is the only source of the order email on an express cart.
    const { order } = await adminFetch<{ order: { email: string } }>(
      `/admin/orders/${orderId}?fields=id,email`,
    );
    expect(order.email).toBe(PAYPAL_ACCOUNTS.personal.email);
  });

  test("cart page PayPal express pays the shopper's cart", async ({ page, context }) => {
    // MONEI-WooCommerce regression: the cart page express order failed silently after the
    // buyer had already approved in PayPal. The seeded cart is valid, so the only correct
    // outcome is an order; express.spec.ts covers the visible message of a refused one.
    await addToCart(page, PRODUCTS.sticker);
    const cartId = await cartIdOf(context);
    await page.goto(`/${COUNTRY}/cart`);
    expect((await expressMount(page)).cartId, "cart page express pays the shopper's cart").toBe(
      cartId,
    );

    await payWithPayPal(page, PAYPAL_ACCOUNTS.personal);

    await expectOrderConfirmed(page);
    const payment = await getPayment((await moneiSession(cartId)).data.id);
    expect(payment.status).toBe("SUCCEEDED");
  });
});
