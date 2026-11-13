// MONEI customers (MONEI-WooCommerce `customers.spec.js`): a signed-in shopper's card
// payments link to a MONEI customer made from the Medusa account, through the card
// provider's account holder; a customer deleted at MONEI is replaced.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  CARDS,
  METHODS,
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import { cardHolder, cardHolders, resetShopper, signIn } from "../utils/customers.ts";
import {
  PROVIDERS,
  continueToReview,
  fillCard,
  fillCardholderName,
  placeEmbeddedOrder,
  selectPaymentMethod,
  useEmbeddedCheckout,
  waitForMoneiSession,
  waitForOrderAnsweringThreeDs,
} from "../utils/embedded.ts";
import { SHOPPERS, waitForSubscriber } from "../utils/medusa.ts";
import { getPayment, moneiClient } from "../utils/monei.ts";

const SHOPPER = SHOPPERS[0];

/** Pays with a new card as the signed-in shopper; returns the session it paid. */
async function payWithNewCard(page: Page, context: BrowserContext, email: string = SHOPPER.email) {
  await checkoutToPayment(page, { email });
  await selectPaymentMethod(page, METHODS.card);
  const cartId = await cartIdOf(context);
  const session = await waitForMoneiSession(cartId, PROVIDERS.card);
  // The order email the shopper typed, which may differ from the account email.
  expect((await storeCart(cartId)).email).toBe(email);
  await fillCardholderName(page);
  await fillCard(page, "single", CARDS.visaFrictionless);
  await continueToReview(page);
  await placeEmbeddedOrder(page);
  await waitForOrderAnsweringThreeDs(page);
  await expectOrderConfirmed(page);
  const payment = await getPayment(session.data.id);
  expect(payment.status).toBe("SUCCEEDED");
  return { session, payment };
}

test.describe("MONEI customers, signed-in card payments", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    await resetShopper(SHOPPER);
    await useEmbeddedCheckout(context, "single");
  });

  test.afterAll(() => resetShopper(SHOPPER));

  test("links the payment to a MONEI customer made from the Medusa account", async ({
    page,
    context,
  }) => {
    await signIn(page, SHOPPER);
    // The order is billed to another address than the account's.
    const billingEmail = uniqueEmail("billing");
    const { payment } = await payWithNewCard(page, context, billingEmail);

    const holder = cardHolder(SHOPPER);
    expect(payment.customerId).toBe(holder.externalId);
    // The account email, not the order's: the MONEI customer is the Medusa customer.
    const customer = await moneiClient().customers.get(holder.externalId);
    expect(customer.email).toBe(SHOPPER.email);
  });

  test("pays without a customer MONEI no longer knows, then links a new one", async ({
    page,
    context,
  }) => {
    // Three card payments, each with a possible 3DS round trip.
    test.slow();
    await signIn(page, SHOPPER);
    const first = await payWithNewCard(page, context);
    const deleted = cardHolder(SHOPPER);
    expect(first.payment.customerId).toBe(deleted.externalId);
    // The state a merchant makes by deleting the customer in the MONEI dashboard.
    await moneiClient().customers.delete(deleted.externalId);

    const second = await payWithNewCard(page, context);
    expect(second.session.data.monei_customer_missing).toBe(true);
    expect(second.payment.customerId).toBeFalsy();
    // The callback of the second payment reaches the reconcile subscriber.
    await waitForSubscriber(async () => !cardHolders(SHOPPER).some((h) => h.id === deleted.id), {
      what: "the reconcile subscriber to delete the stale account holder",
    });

    const third = await payWithNewCard(page, context);
    const relinked = cardHolder(SHOPPER);
    expect(relinked.externalId).not.toBe(deleted.externalId);
    expect(third.session.data.monei_customer_missing).toBe(false);
    expect(third.payment.customerId).toBe(relinked.externalId);
  });
});
