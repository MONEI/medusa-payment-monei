// Shopper state for the customer and saved-card specs: MONEI customers, account holders
// and saved cards (MONEI-WooCommerce `customers.spec.js` resetShopper / customerState).
import { expect, type Page } from "@playwright/test";
import { BACKEND_LOCAL_URL, fixtures } from "./env.ts";
import { COUNTRY, PRODUCTS, SHIPPING } from "./checkout.ts";
import { ADDRESS, compose, customerToken, medusaFetch } from "./medusa.ts";
import { moneiClient } from "./monei.ts";
import { PROVIDERS } from "./embedded.ts";

export type Shopper = { email: string; password: string };

/** One value per row, `|` between columns. Only for values the harness itself controls. */
export function sql(query: string): string[] {
  return compose(["exec", "-T", "postgres", "psql", "-U", "medusa", "-d", "medusa", "-tAc", query])
    .split("\n")
    .filter(Boolean);
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The registered customer id of a seeded shopper. */
export function customerIdOf(shopper: Shopper): string {
  const [id] = sql(
    `select id from customer where email = ${literal(shopper.email)} and has_account and deleted_at is null`,
  );
  expect(id, `${shopper.email} is registered`).toBeTruthy();
  return id;
}

export type Holder = { id: string; externalId: string };

/** Live card account holders linked to the shopper (a dangling link has no holder row). */
export function cardHolders(shopper: Shopper): Holder[] {
  return sql(
    `select ah.id, ah.external_id from customer_account_holder l
       join account_holder ah on ah.id = l.account_holder_id and ah.deleted_at is null
     where l.customer_id = ${literal(customerIdOf(shopper))} and l.deleted_at is null
       and ah.provider_id = ${literal(PROVIDERS.card)}
     order by ah.created_at`,
  ).map((row) => {
    const [id, externalId] = row.split("|");
    return { id, externalId };
  });
}

/** The shopper's only card account holder; fails when there is none or more than one. */
export function cardHolder(shopper: Shopper): Holder {
  const holders = cardHolders(shopper);
  expect(holders, `${shopper.email} has exactly one card account holder`).toHaveLength(1);
  return holders[0];
}

const isNotFound = (error: unknown) =>
  (error as { statusCode?: number; response?: { status?: number } }).statusCode === 404 ||
  (error as { response?: { status?: number } }).response?.status === 404;

/**
 * Start from a shopper with no MONEI customer, account holder or saved card: every
 * customer the shopper's holders ever pointed to is deleted at MONEI (its saved cards
 * with it), then the holder rows and link rows, dangling ones included.
 */
export async function resetShopper(shopper: Shopper): Promise<void> {
  const customerId = customerIdOf(shopper);
  const rows = sql(
    `select ah.id, ah.external_id from customer_account_holder l
       join account_holder ah on ah.id = l.account_holder_id
     where l.customer_id = ${literal(customerId)}`,
  ).map((row) => row.split("|"));
  for (const [, externalId] of rows) {
    try {
      const cards = await moneiClient().customers.listPaymentMethods(externalId);
      for (const card of cards) {
        await moneiClient().customers.deletePaymentMethod(externalId, card.id);
      }
      await moneiClient().customers.delete(externalId);
    } catch (error) {
      if (!isNotFound(error)) throw new Error(`MONEI customer ${externalId}: ${String(error)}`);
    }
  }
  const ids = rows.map(([id]) => literal(id)).join(",");
  if (ids) sql(`delete from account_holder where id in (${ids})`);
  sql(`delete from customer_account_holder where customer_id = ${literal(customerId)}`);
  expect(cardHolders(shopper)).toEqual([]);
}

export async function signIn(page: Page, shopper: Shopper): Promise<void> {
  await page.goto(`/${COUNTRY}/account`);
  await page.getByTestId("email-input").fill(shopper.email);
  await page.getByTestId("password-input").fill(shopper.password);
  await page.getByTestId("sign-in-button").click();
  await expect(page.getByTestId("welcome-message")).toBeVisible({ timeout: 60_000 });
}

/** A raw store API call, for specs that assert a refusal's status; guest without `token`. */
export async function storeRequest(
  path: string,
  { token, method, body }: { token?: string; method?: string; body?: unknown },
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${BACKEND_LOCAL_URL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      "x-publishable-api-key": fixtures().publishableKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

export type SavedCard = { id: string; brand: string; last4: string; expires_at: number };

export async function savedCards(shopper: Shopper): Promise<SavedCard[]> {
  const { payment_methods } = await medusaFetch<{ payment_methods: SavedCard[] }>(
    "/store/monei/payment-methods",
    { token: await customerToken(shopper) },
  );
  return payment_methods;
}

/**
 * A card session on the shopper's own cart, made through the store API the way the
 * storefront makes it. The session creates the shopper's account holder when missing.
 */
export async function apiCardSession(
  shopper: Shopper,
  data: Record<string, unknown> = {},
): Promise<{ token: string; cartId: string; session: { id: string; data: any } }> {
  const token = await customerToken(shopper);
  const f = fixtures();
  const { cart } = await medusaFetch<{ cart: { id: string } }>("/store/carts", {
    token,
    body: {
      region_id: f.regionId,
      email: shopper.email,
      shipping_address: ADDRESS,
      billing_address: ADDRESS,
      items: [{ variant_id: f.products[PRODUCTS.tshirt].variantId, quantity: 1 }],
    },
  });
  await medusaFetch(`/store/carts/${cart.id}/shipping-methods`, {
    token,
    body: { option_id: f.shippingOptions[SHIPPING.standard] },
  });
  const { payment_collection } = await medusaFetch<{ payment_collection: { id: string } }>(
    "/store/payment-collections",
    { token, body: { cart_id: cart.id } },
  );
  const { payment_collection: collection } = await medusaFetch<{
    payment_collection: { payment_sessions: { id: string; provider_id: string; data: any }[] };
  }>(`/store/payment-collections/${payment_collection.id}/payment-sessions`, {
    token,
    body: { provider_id: PROVIDERS.card, data: { monei_session_id: cart.id, ...data } },
  });
  const session = collection.payment_sessions.find((s) => s.provider_id === PROVIDERS.card);
  expect(session?.data?.id, "the card session has a MONEI payment").toBeTruthy();
  return { token, cartId: cart.id, session: session! };
}
