// Saved cards: the card provider saves a new card to the shopper's MONEI customer, the
// plugin routes list and delete it by an opaque id, and a saved card pays through the
// server-side confirm route, so the permanent token never reaches the browser.
import { expect, test } from "@playwright/test";
import {
  CARDS,
  COUNTRY,
  METHODS,
  cartIdOf,
  checkoutToPayment,
  completeThreeDsChallengeIfShown,
  expectOrderConfirmed,
  payOnHostedPage,
  storeCart,
} from "../utils/checkout.ts";
import {
  apiCardSession,
  cardHolder,
  resetShopper,
  savedCards,
  signIn,
  storeRequest,
} from "../utils/customers.ts";
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
import { STOREFRONT_URL } from "../utils/env.ts";
import { SHOPPERS, customerToken } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const [SHOPPER, OTHER] = SHOPPERS;

/** The cart's pending card session once it carries the save choice the spec made. */
async function waitForSaveSession(cartId: string): Promise<{ id: string; data: any }> {
  let found: { id: string; data: any } | undefined;
  await expect
    .poll(
      async () => {
        const cart = await storeCart(cartId);
        found = cart.payment_collection?.payment_sessions?.find(
          (s: any) =>
            s.provider_id === PROVIDERS.card &&
            s.status === "pending" &&
            typeof s.data?.id === "string" &&
            s.data.save_card === true,
        );
        return found?.id ?? null;
      },
      { message: `a save-card session on cart ${cartId}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return found!;
}

test.describe("saved cards", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    await resetShopper(SHOPPER);
    await resetShopper(OTHER);
    await useEmbeddedCheckout(context, "single");
  });

  test.afterAll(async () => {
    await resetShopper(SHOPPER);
    await resetShopper(OTHER);
  });

  test("saves a card, pays with it and deletes it", async ({ page, context }) => {
    test.slow();
    await signIn(page, SHOPPER);

    // Save: a new card with "save" ticked.
    await checkoutToPayment(page, { email: SHOPPER.email });
    await selectPaymentMethod(page, METHODS.card);
    const cartId = await cartIdOf(context);
    await page.getByTestId("monei-save-card-checkbox").check();
    const saveSession = await waitForSaveSession(cartId);
    await fillCardholderName(page);
    await fillCard(page, "single", CARDS.visaFrictionless);
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    await waitForOrderAnsweringThreeDs(page);
    await expectOrderConfirmed(page);

    const saved = await getPayment(saveSession.data.id);
    expect(saved.status).toBe("SUCCEEDED");
    expect(saved.customerId).toBe(cardHolder(SHOPPER).externalId);
    const token = saved.paymentToken;
    // Booleans only: an assertion message must never print the token.
    expect(typeof token === "string" && token.length > 0, "MONEI saved the card").toBe(true);
    const cartText = (
      await storeRequest(`/store/carts/${cartId}?fields=*payment_collection.payment_sessions`, {
        token: await customerToken(SHOPPER),
      })
    ).text;
    expect(cartText.includes(saveSession.data.id), "the response holds the session").toBe(true);
    expect(cartText.includes(token!), "the store cart never returns the token").toBe(false);

    const cards = await savedCards(SHOPPER);
    expect(cards.map((c) => c.last4)).toEqual(["4414"]);
    expect(JSON.stringify(cards).includes(token!), "the list never returns the token").toBe(false);

    // Pay: the saved card, confirmed by the plugin route; no card details typed.
    await checkoutToPayment(page, { email: SHOPPER.email });
    await selectPaymentMethod(page, METHODS.card);
    const savedOption = page.getByTestId("monei-saved-card").filter({ hasText: "4414" });
    await savedOption.getByRole("radio").check();
    await expect(page.locator("#monei-card-input"), "a saved card needs no card form").toHaveCount(
      0,
    );
    const paySession = await waitForMoneiSession(await cartIdOf(context), PROVIDERS.card);
    expect(paySession.data.save_card).toBeUndefined();
    await continueToReview(page);
    await placeEmbeddedOrder(page);
    await expectOrderConfirmed(page);

    const paid = await getPayment(paySession.data.id);
    expect(paid.status).toBe("SUCCEEDED");
    expect(paid.customerId).toBe(cardHolder(SHOPPER).externalId);
    expect(paid.paymentMethod?.card?.last4).toBe("4414");

    // Delete, from the account page.
    await page.goto(`/${COUNTRY}/account/cards`);
    const row = page.getByTestId("saved-card").filter({ hasText: "4414" });
    await expect(row).toBeVisible();
    await row.getByTestId("delete-saved-card-button").click();
    await expect(page.getByTestId("no-saved-cards")).toBeVisible();
    expect(await savedCards(SHOPPER)).toEqual([]);
  });

  test("another shopper cannot list, pay with or delete the card", async ({ page }) => {
    // The first shopper saves a card on the hosted page.
    const save = await apiCardSession(SHOPPER, {
      save_card: true,
      return_url: `${STOREFRONT_URL}/${COUNTRY}/checkout/monei/return?cart_id=x`,
    });
    await page.goto(save.session.data.redirect_url);
    await payOnHostedPage(page, CARDS.visaFrictionless);
    await completeThreeDsChallengeIfShown(page);
    await expect
      .poll(async () => (await getPayment(save.session.data.id)).status)
      .toBe("SUCCEEDED");
    const [card] = await savedCards(SHOPPER);
    expect(card?.last4).toBe("4414");

    // The other shopper has an account holder and a card session of their own, so only
    // the ownership checks can refuse.
    const other = await apiCardSession(OTHER);
    // Without a holder, or with a payment of no customer, the route refuses earlier.
    const otherHolder = cardHolder(OTHER);
    expect((await getPayment(other.session.data.id)).customerId).toBe(otherHolder.externalId);
    expect((await savedCards(OTHER)).map((c) => c.id)).not.toContain(card.id);

    const del = await storeRequest(`/store/monei/payment-methods/${card.id}`, {
      token: other.token,
      method: "DELETE",
    });
    expect(del.status).toBe(404);

    const ownSession = await storeRequest("/store/monei/confirm", {
      token: other.token,
      body: { payment_session_id: other.session.id, payment_method_id: card.id },
    });
    expect(ownSession.status).toBe(404);
    expect((await getPayment(other.session.data.id)).status).toBe("PENDING");

    // The first shopper's own pending session, with the first shopper's card.
    const victim = await apiCardSession(SHOPPER);
    const foreignSession = await storeRequest("/store/monei/confirm", {
      token: other.token,
      body: { payment_session_id: victim.session.id, payment_method_id: card.id },
    });
    expect(foreignSession.status).toBe(403);
    expect((await getPayment(victim.session.data.id)).status).toBe("PENDING");

    expect((await savedCards(SHOPPER)).map((c) => c.id)).toEqual([card.id]);
  });
});
