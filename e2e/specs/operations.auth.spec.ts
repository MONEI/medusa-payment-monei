// Void with `capture: false`: canceling the order releases the held MONEI payment.
import { expect, test } from "../utils/auth.ts";
import { PRODUCTS, expectOrderConfirmed, moneiSession, uniqueEmail } from "../utils/checkout.ts";
import { waitForOrderAnsweringThreeDs } from "../utils/embedded.ts";
import {
  cardToken,
  openProductExpress,
  submitExpress,
  useExpressCheckout,
  walletContact,
} from "../utils/express.ts";
import { adminFetch, adminRequest, orderPayments } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

test("void from the admin cancels the authorized MONEI payment", async ({ page, context }) => {
  // Express is the proven AUTH checkout path (express.auth.spec.ts).
  await useExpressCheckout(context);
  const mount = await openProductExpress(page, PRODUCTS.tshirt);
  const token = await cardToken(page, mount);
  await submitExpress(page, {
    token,
    paymentMethod: "card",
    finalAmount: mount.amount,
    billingDetails: walletContact(uniqueEmail("void")),
  });
  await waitForOrderAnsweringThreeDs(page);
  const orderId = await expectOrderConfirmed(page);

  const moneiId = (await moneiSession(mount.cartId)).data.id;
  expect((await getPayment(moneiId)).status).toBe("AUTHORIZED");
  const [payment] = await orderPayments(orderId);

  // Medusa's void: cancelOrderWorkflow cancels payments without captures. Its cancel step
  // only logs a provider error, so the 200 alone proves nothing.
  const cancel = await adminRequest(`/admin/orders/${orderId}/cancel`, {});
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

  expect((await getPayment(moneiId)).status).toBe("CANCELED");
  const { payment: voided } = await adminFetch<{ payment: { canceled_at: string | null } }>(
    `/admin/payments/${payment.id}?fields=id,canceled_at`,
  );
  expect(voided.canceled_at, "Medusa recorded the void").not.toBeNull();
});
