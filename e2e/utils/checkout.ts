import { expect, type BrowserContext, type Page } from "@playwright/test";
import { STOREFRONT_URL } from "./env.ts";
import { ADDRESS, medusaFetch } from "./medusa.ts";

/** Storefront country segment; the seeded region covers ES and PT. */
export const COUNTRY = "es";

export const PRODUCTS = {
  /** 2.50 EUR: with free shipping the total stays below the 5 EUR Bizum test limit. */
  sticker: "monei-e2e-sticker",
  /** 18.00 EUR, the WooCommerce suite's product price. */
  tshirt: "monei-e2e-t-shirt",
  /** 18.00 EUR, the only product with managed stock (setLimitedStock). */
  limited: "monei-e2e-limited-print",
} as const;

export const SHIPPING = { free: "Free shipping", standard: "Standard shipping" } as const;

export const GUEST_EMAIL = "e2e-guest@monei-e2e.test";

/** A guest email no other test used, so the orders of one test can be counted. */
export const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@monei-e2e.test`;

/** MONEI test cards (MONEI-WooCommerce `utils/checkout.js`). Expiry 12/34, CVC 123. */
export const CARDS = {
  // Documented as frictionless, but the account risk rules may still challenge it.
  visaFrictionless: "4444444444444414",
  // 3DS v2.1, always challenged.
  visaChallenge: "4444444444444406",
} as const;

/** Bizum test phone: approved at or below 5 EUR, declined above. */
export const BIZUM_PHONE = "+34500000000";

/** Titles the storefront shows for the MONEI providers. */
export const METHODS = { card: "Card", bizum: "Bizum" } as const;

export async function addToCart(page: Page, handle: string): Promise<void> {
  await page.goto(`/${COUNTRY}/products/${handle}`);
  const add = page.getByTestId("add-product-button");
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByTestId("nav-cart-link")).toContainText("(1)");
}

/** Guest address step: fills the shipping address (billing = shipping) and continues. */
export async function fillAddress(page: Page, email = GUEST_EMAIL): Promise<void> {
  await page.goto(`/${COUNTRY}/checkout?step=address`);
  await page.getByTestId("shipping-first-name-input").fill(ADDRESS.first_name);
  await page.getByTestId("shipping-last-name-input").fill(ADDRESS.last_name);
  await page.getByTestId("shipping-address-input").fill(ADDRESS.address_1);
  await page.getByTestId("shipping-postal-code-input").fill(ADDRESS.postal_code);
  await page.getByTestId("shipping-city-input").fill(ADDRESS.city);
  await page.getByTestId("shipping-country-select").selectOption(ADDRESS.country_code);
  await page.getByTestId("shipping-province-input").fill(ADDRESS.province);
  await page.getByTestId("shipping-email-input").fill(email);
  await page.getByTestId("shipping-phone-input").fill(ADDRESS.phone);
  await page.getByTestId("submit-address-button").click();
  await expect(page).toHaveURL(/step=delivery/);
}

export async function chooseShipping(page: Page, name: string): Promise<void> {
  await page.getByTestId("delivery-option-radio").filter({ hasText: name }).click();
  await page.getByTestId("submit-delivery-option-button").click();
  await expect(page).toHaveURL(/step=payment/);
}

/** Cart with one product, address and shipping set: the buyer sees the payment step. */
export async function checkoutToPayment(
  page: Page,
  {
    product = PRODUCTS.tshirt,
    shipping = SHIPPING.standard,
    email = GUEST_EMAIL,
  }: { product?: string; shipping?: string; email?: string } = {},
): Promise<void> {
  await addToCart(page, product);
  await fillAddress(page, email);
  await chooseShipping(page, shipping);
}

/**
 * Payment options of the open payment step. Each option is a radio that wraps a decorative
 * radio, so only the outer one counts.
 */
export const paymentOptions = (page: Page) =>
  page.getByRole("radiogroup").locator('[role="radio"]:has([role="radio"])');

/** Selects a MONEI method, continues to review and presses "Place order" (hosted page). */
export async function placeHostedOrder(page: Page, method: string): Promise<void> {
  await paymentOptions(page)
    .filter({ has: page.getByText(method, { exact: true }) })
    .click();
  await page.getByTestId("submit-payment-button").click();
  await expect(page).toHaveURL(/step=review/);
  await page.getByTestId("submit-order-button").click();
  await page.waitForURL(/secure\.monei\.com\/payments\//);
}

/** Fills the card form of the MONEI hosted page and pays. */
export async function payOnHostedPage(page: Page, card: string): Promise<void> {
  const frame = page.frameLocator('iframe[title="monei_card_input"]');
  await page
    .getByTestId("cardholder-name-input")
    .fill(`${ADDRESS.first_name} ${ADDRESS.last_name}`);
  for (const [testId, text] of [
    ["card-number-input", card],
    ["expiry-date-input", "1234"],
    ["cvc-input", "123"],
  ]) {
    const input = frame.getByTestId(testId);
    await expect(input).toBeEditable({ timeout: 60_000 });
    await input.click();
    // Keystrokes: MONEI formats and auto-advances on key events.
    await input.pressSequentially(text, { delay: 40 });
  }
  await expect(frame.getByTestId("expiry-date-input")).toHaveValue("12 / 34");
  await page.getByTestId("pay-button").click();
}

/** Bizum on the hosted page: phone, pay, and wait for MONEI's waiting screen. */
export async function payBizumOnHostedPage(page: Page): Promise<void> {
  await page.getByTestId("bizum-phone-input").fill(BIZUM_PHONE);
  await page.getByTestId("bizum-pay-button").click();
  await page.waitForURL(/secure\.monei\.com\/payments\/[^/]+\/challenge/);
}

const challengeButton = (page: Page, outcome: "complete" | "fail") =>
  page.getByTestId(`${outcome}-button`);

/**
 * Answers the 3DS challenge, which the hosted page shows as a full-page redirect to
 * MONEI's simulator. Strict: fails when no challenge shows.
 */
export async function answerThreeDsChallenge(
  page: Page,
  outcome: "complete" | "fail" = "complete",
): Promise<void> {
  const button = challengeButton(page, outcome);
  await expect(button, "3DS challenge is displayed").toBeVisible({ timeout: 60_000 });
  await button.click();
}

/**
 * For a card the account may or may not challenge: answers the challenge when one
 * shows, and returns once the browser has left the MONEI pages.
 */
export async function completeThreeDsChallengeIfShown(page: Page): Promise<void> {
  const left = page
    .waitForURL((url) => url.hostname !== "secure.monei.com", { timeout: 60_000 })
    .then(() => "left" as const);
  const challenged = challengeButton(page, "complete")
    .waitFor({ state: "visible", timeout: 60_000 })
    .then(() => "challenge" as const);
  if ((await Promise.race([left, challenged.catch(() => left)])) === "challenge") {
    await challengeButton(page, "complete").click();
  }
}

/** The order confirmation page; returns the Medusa order id from its URL. */
export async function expectOrderConfirmed(page: Page): Promise<string> {
  await page.waitForURL(/\/order\/order_[^/]+\/confirmed/, { timeout: 90_000 });
  await expect(page.getByTestId("order-complete-container")).toBeVisible();
  return page.url().match(/\/order\/(order_[^/]+)\/confirmed/)![1];
}

/** The storefront's cart id, from its (httpOnly) cookie. */
export async function cartIdOf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(STOREFRONT_URL)).find((c) => c.name === "_medusa_cart_id");
  expect(cookie?.value, "the storefront set a cart cookie").toBeTruthy();
  return cookie!.value;
}

/** The cart as the store API returns it, with its payment sessions. */
export async function storeCart(cartId: string): Promise<any> {
  const { cart } = await medusaFetch<{ cart: any }>(
    `/store/carts/${cartId}?fields=id,email,total,completed_at,*payment_collection.payment_sessions`,
  );
  return cart;
}

/** The cart's MONEI session (the one "Place order" redirected with). */
export async function moneiSession(cartId: string): Promise<{ id: string; data: any }> {
  const cart = await storeCart(cartId);
  const session = cart.payment_collection?.payment_sessions?.find((s: any) =>
    s.provider_id.startsWith("pp_monei"),
  );
  expect(session, `cart ${cartId} has a MONEI payment session`).toBeTruthy();
  return session;
}

/** The return URL MONEI redirects to, as the plugin builds it (minus MONEI's own params). */
export const returnUrl = (cartId: string, sessionId: string) =>
  `/${COUNTRY}/checkout/monei/return?cart_id=${cartId}&session_id=${sessionId}`;
