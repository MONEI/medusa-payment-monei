// Express checkout (MONEI-WooCommerce `express-amount`, `express-payment`). The wallet
// sheet is a cross-origin browser UI no automation can authorise, so the storefront specs
// hand the express `onSubmit` the result a wallet would, with a real token from a real
// card input. Everything after the sheet runs for real.
import { expect, test } from "@playwright/test";
import {
  PRODUCTS,
  SHIPPING,
  addToCart,
  cartIdOf,
  expectOrderConfirmed,
  moneiSession,
  uniqueEmail,
} from "../utils/checkout.ts";
import { storeRequest } from "../utils/customers.ts";
import { PROVIDERS, waitForOrderAnsweringThreeDs } from "../utils/embedded.ts";
import {
  REJECTED_TOKEN,
  cartSnapshot,
  cardToken,
  openProductExpress,
  submitExpress,
  useExpressCheckout,
  walletContact,
} from "../utils/express.ts";
import { adminFetch, createCart, medusaFetch, orderPayments } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const AMOUNT_MISMATCH = /Expected amount .* does not match the cart amount/;

test.describe("express amount verification (store API)", () => {
  test("refuses a tampered expected_amount and accepts the real one", async () => {
    // 18.00 + 4.50 shipping.
    const cart = await createCart({ handle: PRODUCTS.tshirt, shipping: SHIPPING.standard });
    expect(cart.total).toBe(22.5);
    const { payment_collection } = await medusaFetch<{ payment_collection: { id: string } }>(
      "/store/payment-collections",
      { body: { cart_id: cart.id } },
    );
    const createSession = (expected: unknown) =>
      storeRequest(`/store/payment-collections/${payment_collection.id}/payment-sessions`, {
        body: {
          provider_id: PROVIDERS.card,
          data: { expected_amount: expected, monei_session_id: cart.id },
        },
      });

    // A free order is the whole point of tampering; one cent under is the smallest theft;
    // minor units sent as major would charge a hundred times the total.
    for (const tampered of ["0", "22.49", 2250]) {
      const refused = await createSession(tampered);
      expect(refused.status, `expected_amount ${tampered} is refused`).toBe(400);
      expect(refused.text).toMatch(AMOUNT_MISMATCH);
    }
    expect((await cartSnapshot(cart.id)).sessions, "no session survives a refusal").toEqual([]);

    // Without this the suite would pass against a plugin that refused every amount.
    const accepted = await createSession("22.50");
    expect(accepted.status, accepted.text).toBe(200);
    const session = JSON.parse(accepted.text).payment_collection.payment_sessions.find(
      (s: any) => s.provider_id === PROVIDERS.card,
    );
    const payment = await getPayment(session.data.id);
    expect(payment.amount).toBe(2250);
    expect(payment.status).toBe("PENDING");
  });
});

test.describe("product page express", () => {
  test.beforeEach(async ({ context }) => useExpressCheckout(context));

  test("a refused amount leaves the shopper's regular cart untouched", async ({
    page,
    context,
  }) => {
    await addToCart(page, PRODUCTS.sticker);
    const regularId = await cartIdOf(context);
    const before = await cartSnapshot(regularId);

    const mount = await openProductExpress(page, PRODUCTS.tshirt);
    expect(mount.cartId, "product express pays its own cart").not.toBe(regularId);
    await submitExpress(page, {
      token: REJECTED_TOKEN,
      paymentMethod: "googlePay",
      finalAmount: mount.amount - 1,
      billingDetails: walletContact(uniqueEmail("express-refused")),
    });

    await expect(page.getByTestId("monei-express-error")).toContainText(AMOUNT_MISMATCH);
    expect((await cartSnapshot(mount.cartId)).sessions).toEqual([]);
    expect(await cartIdOf(context)).toBe(regularId);
    expect(await cartSnapshot(regularId)).toEqual(before);
  });

  test("refuses a wallet result without an email before any session", async ({ page }) => {
    // MONEI-WooCommerce regression: monei.js once requested no Google Pay email, and every
    // express payment then failed deep in the MONEI API.
    const mount = await openProductExpress(page, PRODUCTS.tshirt);
    await submitExpress(page, {
      token: REJECTED_TOKEN,
      paymentMethod: "googlePay",
      finalAmount: mount.amount,
      billingDetails: walletContact(),
    });

    await expect(page.getByTestId("monei-express-error")).toContainText("did not share an email");
    const cart = await cartSnapshot(mount.cartId);
    expect(cart.sessions).toEqual([]);
    expect(cart.email).toBeNull();
  });

  test("pays with a real token: MONEI SUCCEEDED, Medusa payment captured", async ({
    page,
    context,
  }) => {
    await addToCart(page, PRODUCTS.sticker);
    const regularId = await cartIdOf(context);
    const before = await cartSnapshot(regularId);

    const mount = await openProductExpress(page, PRODUCTS.tshirt);
    // 18.00 with the cheapest (free) shipping option the express cart starts with.
    expect(mount.amount).toBe(1800);
    const token = await cardToken(page, mount);
    const email = uniqueEmail("express");
    await submitExpress(page, {
      token,
      paymentMethod: "card",
      finalAmount: mount.amount,
      billingDetails: walletContact(email),
      shippingDetails: walletContact(),
    });
    await waitForOrderAnsweringThreeDs(page);
    const orderId = await expectOrderConfirmed(page);

    const session = await moneiSession(mount.cartId);
    expect(session.data).toMatchObject({
      expected_amount: "18.00",
      monei_session_id: mount.cartId,
    });
    const payment = await getPayment(session.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.amount).toBe(1800);
    // A card token, unlike a wallet token, pays only with the cardholder name (MONEI stores
    // it in uppercase).
    expect(payment.paymentMethod?.card?.cardholderName).toBe(walletContact().name.toUpperCase());

    const { order } = await adminFetch<{ order: any }>(
      `/admin/orders/${orderId}?fields=id,email,shipping_address.city,shipping_address.country_code`,
    );
    expect(order.email).toBe(email);
    expect(order.shipping_address).toMatchObject({ city: "Madrid", country_code: "es" });
    await expect
      .poll(async () => (await orderPayments(orderId))[0]?.captured_at ?? null, {
        message: "the Medusa payment is captured",
      })
      .not.toBeNull();

    expect(await cartIdOf(context)).toBe(regularId);
    expect(await cartSnapshot(regularId)).toEqual(before);
  });
});
