// Embedded Bizum (MONEI-WooCommerce `blocks-bizum`): a Bizum-only checkout renders the
// monei.js Bizum button, mounted with the session's MONEI payment id, and pays.
import { expect, test } from "@playwright/test";
import {
  BIZUM_PHONE,
  COUNTRY,
  METHODS,
  PRODUCTS,
  SHIPPING,
  cartIdOf,
  checkoutToPayment,
  expectOrderConfirmed,
  paymentOptions,
  storeCart,
} from "../utils/checkout.ts";
import {
  PROVIDERS,
  continueToReview,
  selectPaymentMethod,
  useEmbeddedCheckout,
  waitForMoneiSession,
} from "../utils/embedded.ts";
import { fixtures } from "../utils/env.ts";
import { SHOPPERS, adminFetch } from "../utils/medusa.ts";
import { getPayment } from "../utils/monei.ts";

const SHOPPER = SHOPPERS[0];

const regionProviders = async (): Promise<string[]> => {
  const { region } = await adminFetch<{ region: { payment_providers: { id: string }[] } }>(
    `/admin/regions/${fixtures().regionId}?fields=id,*payment_providers`,
  );
  return region.payment_providers.map((p) => p.id);
};

const setRegionProviders = (ids: string[]) =>
  adminFetch(`/admin/regions/${fixtures().regionId}`, { body: { payment_providers: ids } });

test.describe("embedded Bizum, Bizum-only checkout", () => {
  let previous: string[] | undefined;

  test.beforeAll(async () => {
    previous = await regionProviders();
    await setRegionProviders([PROVIDERS.bizum]);
  });

  test.afterAll(async () => {
    // A failed beforeAll leaves this unset; never write back an invented list.
    if (previous) await setRegionProviders(previous);
  });

  test.beforeEach(async ({ context }) => useEmbeddedCheckout(context));

  test("renders the Bizum component with no SDK error and pays as the ES shopper", async ({
    page,
    context,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(`/${COUNTRY}/account`);
    await page.getByTestId("email-input").fill(SHOPPER.email);
    await page.getByTestId("password-input").fill(SHOPPER.password);
    await page.getByTestId("sign-in-button").click();
    await expect(page.getByTestId("welcome-message")).toBeVisible({ timeout: 60_000 });

    await checkoutToPayment(page, {
      product: PRODUCTS.sticker,
      shipping: SHIPPING.free,
      email: SHOPPER.email,
    });
    await expect(paymentOptions(page), "Bizum is the only method").toHaveCount(1);
    await selectPaymentMethod(page, METHODS.bizum);
    const cartId = await cartIdOf(context);
    const session = await waitForMoneiSession(cartId, PROVIDERS.bizum);
    // The Bizum test processor approves only below 5 EUR.
    expect((await storeCart(cartId)).total).toBeLessThan(5);
    await continueToReview(page);

    const button = page.frameLocator("#monei-bizum-container iframe").getByTestId("bizum-button");
    await expect(button, "the Bizum component mounted").toBeVisible({ timeout: 60_000 });
    await button.click();
    const modal = page.frameLocator('iframe[title="monei_bizum"]');
    const phone = modal.getByTestId("bizum-phone-input");
    const digits = (value: string) => value.replace(/\D/g, "");
    // The modal's markup has the input before its script runs, and the script resets it:
    // wait for the frame to load, then type and read back.
    const modalFrame = await page.locator('iframe[title="monei_bizum"]').elementHandle();
    await (await modalFrame!.contentFrame())!.waitForLoadState("load");
    await expect(async () => {
      await phone.fill("");
      await phone.pressSequentially(BIZUM_PHONE, { delay: 30 });
      expect(digits(await phone.inputValue())).toBe(digits(BIZUM_PHONE));
    }).toPass({ timeout: 30_000 });
    await modal.getByTestId("bizum-pay-button").click();
    await expectOrderConfirmed(page);

    const payment = await getPayment(session.data.id);
    expect(payment.status).toBe("SUCCEEDED");
    // The shopper's default billing address is stored with country_code "es".
    expect(payment.billingDetails?.address?.country).toBe("ES");
    expect(
      consoleErrors.filter((text) =>
        /ReferenceError|monei is not defined|MONEI SDK is not available/i.test(text),
      ),
      "no missing-SDK errors were logged",
    ).toEqual([]);
  });
});
