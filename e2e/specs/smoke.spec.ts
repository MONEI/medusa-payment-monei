import { expect, test } from "@playwright/test";
import { PRODUCTS, SHIPPING, checkoutToPayment, paymentOptions } from "../utils/checkout.ts";
import { BACKEND_LOCAL_URL, fixtures, tunnelUrl } from "../utils/env.ts";
import { createCart, medusaFetch, readBackendLog } from "../utils/medusa.ts";

const MONEI_PROVIDERS = [
  "pp_monei-bizum_monei",
  "pp_monei-mbway_monei",
  "pp_monei-multibanco_monei",
  "pp_monei-paypal_monei",
  "pp_monei_monei",
];

test.describe("e2e stack", () => {
  test("backend answers /health locally and through the tunnel MONEI calls back on", async ({
    request,
  }) => {
    expect((await request.get(`${BACKEND_LOCAL_URL}/health`)).status()).toBe(200);
    expect(tunnelUrl()).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    expect((await request.get(`${tunnelUrl()}/health`)).status()).toBe(200);
  });

  test("the region lists the five MONEI providers", async () => {
    const { payment_providers } = await medusaFetch<{ payment_providers: { id: string }[] }>(
      `/store/payment-providers?region_id=${fixtures().regionId}`,
    );
    expect(payment_providers.map((p) => p.id).sort()).toEqual(MONEI_PROVIDERS);
  });

  test("the packed plugin's store routes are mounted behind customer auth", async ({ request }) => {
    // 404 here means the plugin is not loaded from `plugins` (routes and subscribers).
    const response = await request.get(`${BACKEND_LOCAL_URL}/store/monei/payment-methods`, {
      headers: { "x-publishable-api-key": fixtures().publishableKey },
    });
    expect(response.status()).toBe(401);
  });

  test("seeded carts carry the literal totals the payment specs assert", async () => {
    // Bizum test approval needs < 5 EUR; tax would move every amount.
    const sticker = await createCart({ handle: PRODUCTS.sticker, shipping: SHIPPING.free });
    expect([sticker.total, sticker.tax_total]).toEqual([2.5, 0]);

    const tshirt = await createCart({ handle: PRODUCTS.tshirt, shipping: SHIPPING.standard });
    expect([tshirt.total, tshirt.tax_total]).toEqual([22.5, 0]);

    const promoted = await createCart({
      handle: PRODUCTS.tshirt,
      shipping: SHIPPING.standard,
      promoCode: fixtures().promotionCode,
    });
    expect([promoted.discount_total, promoted.total]).toEqual([1.8, 20.7]);
  });

  test("the backend log is readable for log-gated specs", () => {
    expect(readBackendLog(/Server is ready on port/).length).toBeGreaterThan(0);
  });

  test("a guest reaches the payment step with five payment options", async ({ page }) => {
    await checkoutToPayment(page);
    await expect(paymentOptions(page)).toHaveCount(MONEI_PROVIDERS.length);
  });
});
