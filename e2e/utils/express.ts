// Express checkout: the Apple Pay / Google Pay and PayPal buttons on the product and cart
// pages (storefront `modules/products/components/monei-express`).
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { CARDS, COUNTRY } from "./checkout.ts";
import { STOREFRONT_URL } from "./env.ts";
import { ADDRESS, medusaFetch } from "./medusa.ts";
import { CARD_CVC, CARD_EXPIRY, typeIntoCardInput } from "./embedded.ts";

/** Deliberately not a credential: MONEI must refuse it (MONEI-WooCommerce `express-amount`). */
export const REJECTED_TOKEN = ["not", "a", "real", "token"].join("-");

/** The express buttons are opt-in per browser; this cookie shows them. */
export async function useExpressCheckout(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "monei_express", value: "on", url: STOREFRONT_URL }]);
}

/** What the mounted express buttons expose: their cart and the amount the wallet shows. */
export type ExpressMount = {
  cartId: string;
  accountId: string;
  /** Minor units. */
  amount: number;
  currency: string;
};

export async function expressMount(page: Page): Promise<ExpressMount> {
  const root = page.getByTestId("monei-express");
  await expect(root, "the express buttons mounted").toBeVisible({ timeout: 60_000 });
  const attr = async (name: string) => (await root.getAttribute(name)) ?? "";
  return {
    cartId: await attr("data-session-id"),
    accountId: await attr("data-account-id"),
    amount: Number(await attr("data-amount")),
    currency: await attr("data-currency"),
  };
}

export async function openProductExpress(page: Page, handle: string): Promise<ExpressMount> {
  await page.goto(`/${COUNTRY}/products/${handle}`);
  return expressMount(page);
}

/**
 * A real one-time token from a real `monei.CardInput`, mounted on the page with the
 * account id and the express session id and filled with a MONEI test card
 * (MONEI-WooCommerce `express-payment`). No automation can authorise an Apple Pay or
 * Google Pay sheet, so this is the only genuine token a test can obtain. Unlike a wallet
 * token it carries no `tokenizationMethod`, so MONEI requires the cardholder name.
 */
export async function cardToken(
  page: Page,
  mount: ExpressMount,
  card: string = CARDS.visaFrictionless,
): Promise<string> {
  await page.addScriptTag({ url: "https://js.monei.com/v3/monei.js" });
  await page.waitForFunction(() => typeof (window as any).monei !== "undefined");
  await page.evaluate(({ accountId, cartId, amount, currency }) => {
    const mountPoint = document.createElement("div");
    mountPoint.id = "monei-e2e-card-input";
    document.body.prepend(mountPoint);
    const input = (window as any).monei.CardInput({
      accountId,
      sessionId: cartId,
      amount,
      currency,
    });
    input.render(mountPoint);
    (window as any).__moneiE2eCardInput = input;
  }, mount);

  const frame = page.frameLocator("#monei-e2e-card-input iframe");
  await typeIntoCardInput(frame.getByTestId("card-number-input"), card);
  await typeIntoCardInput(frame.getByTestId("expiry-date-input"), CARD_EXPIRY);
  await typeIntoCardInput(frame.getByTestId("cvc-input"), CARD_CVC);
  await expect(frame.getByTestId("expiry-date-input")).toHaveValue("12 / 34");

  const submitted = await page.evaluate(() => (window as any).__moneiE2eCardInput.submit());
  expect(submitted.error, "the card component returned a token").toBeFalsy();
  expect(submitted.token).toBeTruthy();
  return submitted.token;
}

/** The contact a wallet returns: the Spanish test address, country in uppercase. */
export const walletContact = (email?: string) => ({
  name: `${ADDRESS.first_name} ${ADDRESS.last_name}`,
  ...(email ? { email } : {}),
  phone: ADDRESS.phone,
  address: {
    line1: ADDRESS.address_1,
    city: ADDRESS.city,
    zip: ADDRESS.postal_code,
    state: ADDRESS.province,
    country: ADDRESS.country_code.toUpperCase(),
  },
});

/** A monei.js `SubmitResult`, as Apple Pay or Google Pay hands it to `onSubmit`. */
export type WalletResult = {
  token: string;
  paymentMethod: "card" | "applePay" | "googlePay" | "paypal";
  finalAmount: number;
  billingDetails?: ReturnType<typeof walletContact>;
  shippingDetails?: ReturnType<typeof walletContact>;
};

/**
 * Hands the result to the storefront's express `onSubmit`, the handler the wallet calls.
 * Not awaited in the page: the handler navigates away when the order is placed.
 */
export async function submitExpress(page: Page, result: WalletResult): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__moneiExpress);
  await page.evaluate((r) => {
    void (window as any).__moneiExpress.submit(r);
  }, result);
}

/** A cart with its items and payment sessions, for before/after comparisons. */
export async function cartSnapshot(cartId: string) {
  const { cart } = await medusaFetch<{ cart: any }>(
    `/store/carts/${cartId}?fields=id,email,total,completed_at,items.variant_id,items.quantity,*payment_collection.payment_sessions`,
  );
  return {
    email: cart.email as string | null,
    total: cart.total as number,
    completed: !!cart.completed_at,
    items: (cart.items as { variant_id: string; quantity: number }[]).map(
      ({ variant_id, quantity }) => ({ variant_id, quantity }),
    ),
    sessions: (cart.payment_collection?.payment_sessions ?? []) as { id: string; data: any }[],
  };
}
