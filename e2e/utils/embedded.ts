// Helpers for the embedded checkout: monei.js components on the storefront's own page.
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { STOREFRONT_URL } from "./env.ts";
import { ADDRESS } from "./medusa.ts";
import { paymentOptions, storeCart } from "./checkout.ts";

export const PROVIDERS = {
  card: "pp_monei_monei",
  bizum: "pp_monei-bizum_monei",
  paypal: "pp_monei-paypal_monei",
} as const;

export type CardLayout = "single" | "split";

export const CARD_EXPIRY = "1234";
export const CARD_CVC = "123";

/** One storefront build serves both flows; these cookies pick the embedded one. */
export async function useEmbeddedCheckout(
  context: BrowserContext,
  layout: CardLayout = "single",
): Promise<void> {
  await context.addCookies([
    { name: "monei_flow", value: "embedded", url: STOREFRONT_URL },
    { name: "monei_card_layout", value: layout, url: STOREFRONT_URL },
  ]);
}

export async function selectPaymentMethod(page: Page, title: string): Promise<void> {
  await paymentOptions(page)
    .filter({ has: page.getByText(title, { exact: true }) })
    .click();
}

/**
 * The cart's pending session of `providerId` once the storefront has made it; with
 * `not`, a newer one than that session.
 */
export async function waitForMoneiSession(
  cartId: string,
  providerId: string,
  { not }: { not?: string } = {},
): Promise<{ id: string; data: any }> {
  let found: { id: string; data: any } | undefined;
  await expect
    .poll(
      async () => {
        const cart = await storeCart(cartId);
        // Medusa saves the row before the provider answers: wait for the MONEI payment id.
        found = cart.payment_collection?.payment_sessions?.find(
          (s: any) =>
            s.provider_id === providerId &&
            s.status === "pending" &&
            s.id !== not &&
            typeof s.data?.id === "string",
        );
        return found?.id ?? null;
      },
      { message: `a ${providerId} session on cart ${cartId}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return found!;
}

const SINGLE_MOUNT = "#monei-card-input";
const SPLIT_MOUNT = {
  number: "#monei-card-number",
  expiry: "#monei-card-expiry",
  cvc: "#monei-card-cvc",
} as const;
const CARD_PART_TEST_ID = {
  number: "card-number-input",
  expiry: "expiry-date-input",
  cvc: "cvc-input",
} as const;

export type CardPart = keyof typeof CARD_PART_TEST_ID;

export const cardMount = (layout: CardLayout, part: CardPart) =>
  layout === "split" ? SPLIT_MOUNT[part] : SINGLE_MOUNT;

/** The element monei.js renders a split part into; it carries `monei-component--*`. */
export const splitPartContainer = (page: Page, part: CardPart) =>
  page.locator(`${SPLIT_MOUNT[part]} > div`);

/** An input inside a MONEI card iframe. */
export const cardInput = (page: Page, layout: CardLayout, part: CardPart): Locator =>
  page.frameLocator(`${cardMount(layout, part)} iframe`).getByTestId(CARD_PART_TEST_ID[part]);

/** Click, anchor the caret at the end, then type key by key (MONEI formats on key events). */
export async function typeIntoCardInput(input: Locator, text: string): Promise<void> {
  await expect(input).toBeEditable({ timeout: 60_000 });
  await input.click();
  await input.press("End");
  await input.pressSequentially(text, { delay: 40 });
}

/**
 * The cardholder name sits next to the card iframes. Typed key by key and read back:
 * a container that swallows Space would pass a `fill()`.
 */
export async function fillCardholderName(page: Page): Promise<void> {
  const name = `${ADDRESS.first_name} ${ADDRESS.last_name}`;
  const input = page.getByTestId("cardholder-name-input");
  await input.click();
  await input.pressSequentially(name, { delay: 20 });
  await expect(input).toHaveValue(name);
}

export async function fillCard(page: Page, layout: CardLayout, number: string): Promise<void> {
  await typeIntoCardInput(cardInput(page, layout, "number"), number);
  await typeIntoCardInput(cardInput(page, layout, "expiry"), CARD_EXPIRY);
  await typeIntoCardInput(cardInput(page, layout, "cvc"), CARD_CVC);
  await expect(cardInput(page, layout, "expiry")).toHaveValue("12 / 34");
  await expect(cardInput(page, layout, "cvc")).toHaveValue(CARD_CVC);
}

export async function continueToReview(page: Page): Promise<void> {
  await page.getByTestId("submit-payment-button").click();
  await expect(page).toHaveURL(/step=review/);
}

/** "Place order" of the embedded card flow, once the session it pays exists. */
export async function placeEmbeddedOrder(page: Page): Promise<void> {
  const button = page.getByTestId("submit-order-button");
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
}

/**
 * monei.js shows the 3DS challenge in its payment modal, which embeds MONEI's
 * simulator in a second cross-origin frame.
 */
const modalChallengeButton = (page: Page, outcome: "complete" | "fail") =>
  page
    .frameLocator('iframe[title="monei_payment_modal"]')
    .frameLocator("iframe")
    .getByTestId(`${outcome}-button`);

// Two cross-origin frames down, synthetic clicks do not arrive; keyboard input follows
// focus (MONEI-WooCommerce `activateChallengeButton`).
async function activate(button: Locator, page: Page): Promise<void> {
  await button.focus();
  await page.keyboard.press("Enter");
}

/** Answers the modal 3DS challenge. Strict: fails when no challenge shows. */
export async function answerModalThreeDs(
  page: Page,
  outcome: "complete" | "fail" = "complete",
): Promise<void> {
  const button = modalChallengeButton(page, outcome);
  await expect(button, "3DS challenge is displayed").toBeVisible({ timeout: 60_000 });
  await activate(button, page);
}

const ORDER_URL = /\/order\/order_[^/]+\/confirmed/;

/**
 * For a card the account may or may not challenge: waits for the order page and
 * answers a challenge whenever one is on screen. A tolerant one-shot race cannot tell
 * "no challenge" from "challenge still loading".
 */
export async function waitForOrderAnsweringThreeDs(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await page.waitForURL(ORDER_URL, { timeout: 10_000 });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      const button = modalChallengeButton(page, "complete");
      if (await button.isVisible().catch(() => false)) await activate(button, page);
    }
  }
}
