import { execFileSync } from "node:child_process";
import { BACKEND_LOCAL_URL, COMPOSE_FILE, fixtures } from "./env.ts";

/** Admin user the seed creates. Not a secret: a local throwaway stack. */
export const ADMIN = { email: "admin@monei-e2e.test", password: "e2e-admin-pass" };

/** Shopper accounts the seed registers through the store API, as the storefront does. */
export const SHOPPERS = [
  { email: "e2e-shopper-1@monei-e2e.test", password: "e2e-shopper-pass", first_name: "Ada" },
  { email: "e2e-shopper-2@monei-e2e.test", password: "e2e-shopper-pass", first_name: "Grace" },
] as const;

/** Spanish address. `country_code` is lowercase, as Medusa stores it from the storefront. */
export const ADDRESS = {
  first_name: "Ada",
  last_name: "Lovelace",
  address_1: "Calle Mayor 1",
  postal_code: "28013",
  city: "Madrid",
  province: "Madrid",
  country_code: "es",
  phone: "600000000",
};

/** Core payment webhook route: event emitted with a 5 s delay, 3 attempts. */
export const WEBHOOK_EVENT_DELAY_MS = 5_000;

type FetchOptions = { method?: string; body?: unknown; token?: string; store?: boolean };

export async function medusaFetch<T = any>(path: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.store !== false && !path.startsWith("/admin")) {
    headers["x-publishable-api-key"] = fixtures().publishableKey;
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${BACKEND_LOCAL_URL}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} answered ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function login(actor: "user" | "customer", email: string, password: string) {
  const { token } = await medusaFetch<{ token: string }>(`/auth/${actor}/emailpass`, {
    body: { email, password },
    store: false,
  });
  return token;
}

export const adminToken = () => login("user", ADMIN.email, ADMIN.password);
export const customerToken = (shopper: { email: string; password: string }) =>
  login("customer", shopper.email, shopper.password);

/** Admin API call as the seeded admin. */
export async function adminFetch<T = any>(path: string, options: Omit<FetchOptions, "token"> = {}) {
  return medusaFetch<T>(path, { ...options, token: await adminToken() });
}

/**
 * A raw admin API call, for specs that assert a refusal's status. Pass `token` when two
 * calls must leave back to back (a login costs a round trip).
 */
export async function adminRequest(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BACKEND_LOCAL_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token ?? (await adminToken())}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** The order's Medusa payments (one per payment collection), as the admin sees them. */
export async function orderPayments(
  orderId: string,
): Promise<
  { id: string; provider_id: string; amount: number; captured_at: string | null; data: any }[]
> {
  const { order } = await adminFetch<{ order: any }>(
    `/admin/orders/${orderId}?fields=id,payment_collections.payments.id,payment_collections.payments.provider_id,payment_collections.payments.amount,payment_collections.payments.captured_at,payment_collections.payments.data`,
  );
  return order.payment_collections.flatMap((collection: any) => collection.payments);
}

/**
 * Guest cart built through the store API (the calls `src/lib/data/cart.ts` of the
 * storefront makes): one product, Spanish address, a shipping option, optional promotion.
 */
export async function createCart({
  handle,
  shipping,
  email = "e2e-guest@monei-e2e.test",
  promoCode,
}: {
  handle: string;
  shipping: string;
  email?: string;
  promoCode?: string;
}): Promise<any> {
  const f = fixtures();
  const { cart } = await medusaFetch<{ cart: { id: string } }>("/store/carts", {
    body: {
      region_id: f.regionId,
      email,
      shipping_address: ADDRESS,
      billing_address: ADDRESS,
      items: [{ variant_id: f.products[handle].variantId, quantity: 1 }],
    },
  });
  await medusaFetch(`/store/carts/${cart.id}/shipping-methods`, {
    body: { option_id: f.shippingOptions[shipping] },
  });
  if (promoCode) {
    await medusaFetch(`/store/carts/${cart.id}`, { body: { promo_codes: [promoCode] } });
  }
  return (await medusaFetch<{ cart: any }>(`/store/carts/${cart.id}`)).cart;
}

export function compose(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Lines of the backend container log that match `pattern`. */
export function readBackendLog(pattern: RegExp): string[] {
  return backendLog().filter((line) => pattern.test(line));
}

/** Every line of the backend container log, oldest first. */
export function backendLog(): string[] {
  return compose(["logs", "--no-color", "--no-log-prefix", "backend"]).split("\n");
}

// Redis keeps an event bus job until every subscriber of it succeeded (removeOnComplete),
// and keeps a failed one for its retry or in the failed set.
const COUNT_JOBS = `local n = 0
for _, key in ipairs(redis.call("KEYS", ARGV[1])) do
  if redis.call("TYPE", key).ok == "hash" then
    local data = redis.call("HGET", key, "data")
    if data and string.find(data, ARGV[2], 1, true) then n = n + 1 end
  end
end
return n`;

/** Event bus jobs (callbacks included) whose data names `text`, still queued or failed. */
export function eventJobsMentioning(text: string): number {
  const out = compose([
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "EVAL",
    COUNT_JOBS,
    "0",
    "RedisEventBusService:events-queue:*",
    text,
  ]);
  return Number(out.trim().replace(/^\(integer\)\s*/, ""));
}

/** Orders placed with `email`, through the admin API. */
export async function ordersByEmail(email: string): Promise<{ id: string; total: number }[]> {
  const { orders } = await adminFetch<{ orders: { id: string; email: string; total: number }[] }>(
    `/admin/orders?q=${encodeURIComponent(email)}&fields=id,email,total&limit=50`,
  );
  // `q` is a fuzzy search: keep exact matches only.
  return orders.filter((order) => order.email === email);
}

export async function waitForBackend(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BACKEND_LOCAL_URL}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // backend still booting
    }
    if (Date.now() > deadline) {
      throw new Error(`The backend did not answer /health within ${timeoutMs / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Recreate only the backend with another `capture` mode; the tunnel URL is kept. */
export async function restartBackend(capture: boolean): Promise<void> {
  compose(["up", "-d", "--no-deps", "--force-recreate", "backend"], {
    MONEI_CAPTURE: String(capture),
  });
  await waitForBackend();
}

/**
 * Poll until a subscriber's effect is visible. The webhook event is delivered after
 * WEBHOOK_EVENT_DELAY_MS and retried, so the default leaves room for one retry.
 */
export async function waitForSubscriber<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = WEBHOOK_EVENT_DELAY_MS * 3 + 15_000, what = "the subscriber" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Sets the stock of the managed-inventory product (PRODUCTS.limited) at the seeded location. */
export async function setLimitedStock(quantity: number): Promise<void> {
  const { inventoryItemId, locationId } = fixtures().limitedStock;
  await adminFetch(`/admin/inventory-items/${inventoryItemId}/location-levels/${locationId}`, {
    body: { stocked_quantity: quantity },
  });
}
