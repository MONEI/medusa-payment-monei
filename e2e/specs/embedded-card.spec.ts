// Embedded card (MONEI-WooCommerce `blocks-cc-single`, `blocks-cc-split`): monei.js card
// fields on the storefront, mounted with the account id and a monei.js session id.
import { expect, test } from "@playwright/test";
import {
  CARDS,
  COUNTRY,
  METHODS,
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  moneiSession,
  storeCart,
  uniqueEmail,
} from "../utils/checkout.ts";
import {
  CARD_CVC,
  CARD_EXPIRY,
  PROVIDERS,
  answerModalThreeDs,
  cardInput,
  continueToReview,
  fillCard,
  fillCardholderName,
  placeEmbeddedOrder,
  selectPaymentMethod,
  splitPartContainer,
  typeIntoCardInput,
  useEmbeddedCheckout,
  waitForMoneiSession,
  waitForOrderAnsweringThreeDs,
} from "../utils/embedded.ts";
import { ADDRESS, adminFetch, ordersByEmail } from "../utils/medusa.ts";
import { PLUGIN_VERSION, fixtures } from "../utils/env.ts";
import { getPayment } from "../utils/monei.ts";

test.describe("embedded card, single field", () => {
  test.beforeEach(async ({ context }) => useEmbeddedCheckout(context, "single"));

  test("pays with a card and MONEI records the Medusa trace details", async ({ page, context }) => {
    const email = uniqueEmail("emb-card");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, METHODS.card);
    const session = await waitForMoneiSession(await cartIdOf(context), PROVIDERS.card);

    await fillCardholderName(page);
    await fillCard(page, "single", CARDS.visaFrictionless);
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    await waitForOrderAnsweringThreeDs(page);
    await expectOrderConfirmed(page);

    const payment = await getPayment(session.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    // 18.00 + 4.50 shipping.
    expect(payment.amount).toBe(2250);
    // The browser confirm must not replace the server-side User-Agent trace.
    expect(payment.traceDetails?.source).toBe("MONEI/Medusa");
    expect(payment.traceDetails?.sourceVersion).toBe(PLUGIN_VERSION);
    // The SDK type lacks `comment`, but the API returns it.
    expect((payment.traceDetails as { comment?: string } | undefined)?.comment).toMatch(
      /^Medusa v\d+\.\d+\.\d+; Node v\d+\.\d+\.\d+$/,
    );
    expect(await ordersByEmail(email)).toHaveLength(1);
  });

  test("shows the 3DS challenge and completes the payment", async ({ page, context }) => {
    const email = uniqueEmail("emb-3ds");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, METHODS.card);
    const session = await waitForMoneiSession(await cartIdOf(context), PROVIDERS.card);

    await fillCardholderName(page);
    await fillCard(page, "single", CARDS.visaChallenge);
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    // Always challenged: the challenge must not be optional here.
    await answerModalThreeDs(page, "complete");
    await expectOrderConfirmed(page);

    expect((await getPayment(session.data.id)).status).toBe("SUCCEEDED");
    expect(await ordersByEmail(email)).toHaveLength(1);
  });

  test("3DS Fail keeps the buyer on the page and the retry pays with a new session", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("emb-3ds-fail");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, METHODS.card);
    const cartId = await cartIdOf(context);
    const first = await waitForMoneiSession(cartId, PROVIDERS.card);

    await fillCardholderName(page);
    await fillCard(page, "single", CARDS.visaChallenge);
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    await answerModalThreeDs(page, "fail");

    await expect(page.getByTestId("monei-payment-error-message")).toBeVisible();
    await expect(page).toHaveURL(/\/checkout\?step=review/);
    expect((await getPayment(first.data.id)).status).toBe("FAILED");
    expect(await ordersByEmail(email)).toHaveLength(0);

    // A failed MONEI payment cannot be confirmed again: the retry needs a new session.
    const second = await waitForMoneiSession(cartId, PROVIDERS.card, { not: first.id });
    expect(second.data.id).not.toBe(first.data.id);
    await placeEmbeddedOrder(page);
    await answerModalThreeDs(page, "complete");
    await expectOrderConfirmed(page);

    expect((await getPayment(second.data.id)).status).toBe("SUCCEEDED");
    expect(await ordersByEmail(email)).toHaveLength(1);
  });

  test("a guest who registers after the session exists pays as the new customer", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("emb-signup");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, METHODS.card);
    const cartId = await cartIdOf(context);
    const guestSession = await waitForMoneiSession(cartId, PROVIDERS.card);

    await page.goto(`/${COUNTRY}/account`);
    await page.getByTestId("register-button").click();
    const register = page.getByTestId("register-page");
    await register.getByTestId("first-name-input").fill(ADDRESS.first_name);
    await register.getByTestId("last-name-input").fill(ADDRESS.last_name);
    await register.getByTestId("email-input").fill(email);
    await register.getByTestId("phone-input").fill(ADDRESS.phone);
    await register.getByTestId("password-input").fill("e2e-signup-pass");
    await register.getByTestId("register-button").click();
    await expect(page.getByTestId("welcome-message")).toBeVisible({ timeout: 60_000 });
    expect((await storeCart(cartId)).email).toBe(email);

    await page.goto(`/${COUNTRY}/checkout?step=payment`);
    // The session made as a guest is kept: re-creating it would bind another payment.
    expect((await moneiSession(cartId)).id).toBe(guestSession.id);
    await fillCardholderName(page);
    await fillCard(page, "single", CARDS.visaFrictionless);
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    await waitForOrderAnsweringThreeDs(page);
    const orderId = await expectOrderConfirmed(page);

    const { customers } = await adminFetch<{
      customers: { id: string; email: string; has_account: boolean }[];
    }>(`/admin/customers?q=${encodeURIComponent(email)}&fields=id,email,has_account`);
    // The guest checkout made its own customer row (has_account false) with this email.
    const customer = customers.find((c) => c.email === email && c.has_account);
    expect(customer, "registration created the customer").toBeTruthy();
    const { order } = await adminFetch<{ order: { customer_id: string } }>(
      `/admin/orders/${orderId}?fields=id,customer_id`,
    );
    expect(order.customer_id).toBe(customer!.id);
    const payment = await getPayment(guestSession.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.customerId).toBeFalsy();
  });
});

test.describe("embedded card, split fields", () => {
  test.beforeEach(async ({ context }) => useEmbeddedCheckout(context, "split"));

  test("moves focus from number to expiry to CVC", async ({ page }) => {
    await checkoutToPayment(page, { email: uniqueEmail("emb-focus") });
    await selectPaymentMethod(page, METHODS.card);

    await typeIntoCardInput(cardInput(page, "split", "number"), CARDS.visaFrictionless);
    await expect(
      splitPartContainer(page, "expiry"),
      "expiry takes focus once the number is complete",
    ).toHaveClass(/monei-component--focus/);
    // Typing without a click proves focus moved into the expiry frame.
    await page.keyboard.type(CARD_EXPIRY, { delay: 40 });
    await expect(cardInput(page, "split", "expiry")).toHaveValue("12 / 34");

    await expect(
      splitPartContainer(page, "cvc"),
      "CVC takes focus once the expiry is complete",
    ).toHaveClass(/monei-component--focus/);
    await page.keyboard.type(CARD_CVC, { delay: 40 });
    await expect(cardInput(page, "split", "cvc")).toHaveValue(CARD_CVC);
  });

  test("a promotion applied mid-entry re-creates the session and keeps the typed digits", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("emb-promo");
    await checkoutToPayment(page, { email });
    await selectPaymentMethod(page, METHODS.card);
    const cartId = await cartIdOf(context);
    const first = await waitForMoneiSession(cartId, PROVIDERS.card);
    expect(first.data.amount).toBe(22.5);

    const numberInput = cardInput(page, "split", "number");
    await typeIntoCardInput(numberInput, "444444444444");
    await expect(numberInput).toHaveValue("4444 4444 4444");

    await page.getByTestId("add-discount-button").click();
    await page.getByTestId("discount-input").fill(fixtures().promotionCode);
    await page.getByTestId("discount-apply-button").click();
    // 22.50 - 10% of the 18.00 item.
    await expect.poll(async () => (await storeCart(cartId)).total).toBe(20.7);

    const second = await waitForMoneiSession(cartId, PROVIDERS.card, { not: first.id });
    expect(second.data.id).not.toBe(first.data.id);
    // Both payments carry the cart id as monei.js session id, so the mounted card's token fits.
    expect(first.data.monei_session_id).toBe(cartId);
    expect(second.data.monei_session_id).toBe(cartId);
    // Medusa dropped the old session; the plugin cancels its payment so it cannot be paid.
    expect((await getPayment(first.data.id)).status).toBe("CANCELED");

    // The regression: re-creating the card component wipes what the buyer typed.
    await expect(page.locator("#monei-card-number iframe"), "one card iframe").toHaveCount(1);
    await expect(numberInput, "typed digits survive the total change").toHaveValue(
      "4444 4444 4444",
    );

    await fillCardholderName(page);
    await typeIntoCardInput(numberInput, "4414");
    await expect(numberInput).toHaveValue("4444 4444 4444 4414");
    await typeIntoCardInput(cardInput(page, "split", "expiry"), CARD_EXPIRY);
    await typeIntoCardInput(cardInput(page, "split", "cvc"), CARD_CVC);
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    await waitForOrderAnsweringThreeDs(page);
    await expectOrderConfirmed(page);

    const payment = await getPayment(second.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.amount).toBe(2070);
  });
});
