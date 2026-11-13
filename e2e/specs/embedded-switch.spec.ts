// Embedded flow, method switch: Continue waits for the session of the method the shopper
// picked. Review must not open on the old session, which Medusa is deleting.
import { expect, test, type Request, type Route } from "@playwright/test";
import { METHODS, cartIdOf, checkoutToPayment, storeCart } from "../utils/checkout.ts";
import { STOREFRONT_URL } from "../utils/env.ts";
import {
  PROVIDERS,
  continueToReview,
  selectPaymentMethod,
  useEmbeddedCheckout,
  waitForMoneiSession,
} from "../utils/embedded.ts";

test.beforeEach(async ({ context }) => useEmbeddedCheckout(context));

test("Continue stays disabled until the session of the new method exists", async ({
  page,
  context,
}) => {
  await checkoutToPayment(page);
  await selectPaymentMethod(page, METHODS.card);
  const cartId = await cartIdOf(context);
  await waitForMoneiSession(cartId, PROVIDERS.card);
  const submit = page.getByTestId("submit-payment-button");
  await expect(submit).toBeEnabled();

  // Hold the storefront's server actions (initiatePaymentSession among them), so the
  // Bizum session cannot be made before the checks below.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  const isServerAction = (request: Request) =>
    request.method() === "POST" && request.headers()["next-action"] !== undefined;
  const hold = async (route: Route) => {
    if (!isServerAction(route.request())) return route.fallback();
    held++;
    await released;
    await route.continue();
  };
  await page.route(`${STOREFRONT_URL}/**`, hold);

  await selectPaymentMethod(page, METHODS.bizum);
  await expect.poll(() => held, { message: "the session request was sent" }).toBeGreaterThan(0);
  await expect(submit).toBeDisabled();
  const pending = (await storeCart(cartId)).payment_collection.payment_sessions.filter(
    (s: any) => s.provider_id === PROVIDERS.bizum,
  );
  expect(pending, "no Bizum session exists yet").toHaveLength(0);

  release();
  await waitForMoneiSession(cartId, PROVIDERS.bizum);
  await expect(submit).toBeEnabled();
  await continueToReview(page);
  await expect(
    page.frameLocator("#monei-bizum-container iframe").getByTestId("bizum-button"),
    "review mounts the Bizum component",
  ).toBeVisible({ timeout: 60_000 });
});
