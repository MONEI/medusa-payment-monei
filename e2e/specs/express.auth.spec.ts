// Express with `capture: false` (MONEI-WooCommerce `express-payment`, "with Payment Action
// set to Authorization"): the wallet payment is held, not taken, until the admin captures
// it, and only in full (the plugin's capture middleware).
import { expect, test } from "../utils/auth.ts";
import {
  PRODUCTS,
  SHIPPING,
  expectOrderConfirmed,
  moneiSession,
  uniqueEmail,
} from "../utils/checkout.ts";
import { waitForOrderAnsweringThreeDs } from "../utils/embedded.ts";
import {
  cardToken,
  openProductExpress,
  submitExpress,
  useExpressCheckout,
  walletContact,
} from "../utils/express.ts";
import { storeRequest } from "../utils/customers.ts";
import { PROVIDERS } from "../utils/embedded.ts";
import { cartSnapshot } from "../utils/express.ts";
import { adminRequest, createCart, medusaFetch, orderPayments } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

test("express holds the money, refuses a partial capture, then captures in full", async ({
  page,
  context,
}) => {
  await useExpressCheckout(context);
  const mount = await openProductExpress(page, PRODUCTS.tshirt);
  const token = await cardToken(page, mount);
  await submitExpress(page, {
    token,
    paymentMethod: "card",
    finalAmount: mount.amount,
    billingDetails: walletContact(uniqueEmail("express-auth")),
  });
  await waitForOrderAnsweringThreeDs(page);
  const orderId = await expectOrderConfirmed(page);

  const victim = await moneiSession(mount.cartId);
  const moneiId = victim.data.id;
  expect((await getPayment(moneiId)).status).toBe("AUTHORIZED");

  // A cart change elsewhere must never cancel the hold of a placed order: the store
  // refuses session data that names a MONEI payment.
  const other = await createCart({ handle: PRODUCTS.tshirt, shipping: SHIPPING.standard });
  const { payment_collection } = await medusaFetch<{ payment_collection: { id: string } }>(
    "/store/payment-collections",
    { body: { cart_id: other.id } },
  );
  const forged = await storeRequest(
    `/store/payment-collections/${payment_collection.id}/payment-sessions`,
    { body: { provider_id: PROVIDERS.card, data: { id: moneiId, session_id: victim.id } } },
  );
  expect(forged.status, forged.text).toBe(400);
  expect((await cartSnapshot(other.id)).sessions, "no forged session is stored").toEqual([]);
  expect((await getPayment(moneiId)).status).toBe("AUTHORIZED");
  const [payment] = await orderPayments(orderId);
  expect(payment.captured_at, "an authorized express payment is not captured").toBeNull();

  // MONEI would capture in full while Medusa recorded the part.
  const partial = await adminRequest(`/admin/payments/${payment.id}/capture`, { amount: 9 });
  expect(partial.status, JSON.stringify(partial.body)).toBe(400);
  expect(partial.body.message).toContain("captured in full");
  expect((await getPayment(moneiId)).status).toBe("AUTHORIZED");
  expect((await orderPayments(orderId))[0].captured_at).toBeNull();

  const full = await adminRequest(`/admin/payments/${payment.id}/capture`, {});
  expect(full.status, JSON.stringify(full.body)).toBe(200);
  expect((await getPayment(moneiId)).status).toBe("SUCCEEDED");
  expect((await orderPayments(orderId))[0].captured_at).not.toBeNull();
});
